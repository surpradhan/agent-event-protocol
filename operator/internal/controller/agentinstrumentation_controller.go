// Copyright 2026 Surabhi Pradhan.
// SPDX-License-Identifier: MIT

// Package controller implements the AgentInstrumentation reconciler.
package controller

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	aepv1alpha1 "github.com/surpradhan/aep-operator/api/v1alpha1"
)

const (
	// requeueInterval is how often the controller re-syncs injected pod counts
	// even without a spec change — catches pods recreated between events.
	requeueInterval = 5 * time.Minute

	// SidecarAnnotation is the annotation the webhook stamps on injected pods.
	// The controller reads it to compute status.injectedCount.
	SidecarAnnotation = "aep.dev/injected"
)

// AgentInstrumentationReconciler reconciles AgentInstrumentation resources.
//
// +kubebuilder:rbac:groups=aep.dev,resources=agentinstrumentations,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=aep.dev,resources=agentinstrumentations/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=aep.dev,resources=agentinstrumentations/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
type AgentInstrumentationReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile is the main reconciliation loop for AgentInstrumentation.
//
// It runs whenever an AgentInstrumentation resource is created, updated, or
// deleted, and also on the requeueInterval timer to keep injectedCount fresh.
func (r *AgentInstrumentationReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// ── Fetch the resource ───────────────────────────────────────────
	ainstr := &aepv1alpha1.AgentInstrumentation{}
	if err := r.Get(ctx, req.NamespacedName, ainstr); err != nil {
		if apierrors.IsNotFound(err) {
			// Deleted before reconcile ran — nothing to clean up.
			// Pods that already received a sidecar keep it until recreated;
			// the webhook will simply not inject into new pods.
			logger.Info("AgentInstrumentation not found; deleted", "name", req.Name)
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("fetching AgentInstrumentation %s: %w", req.Name, err)
	}

	logger.Info("reconciling AgentInstrumentation",
		"name", ainstr.Name,
		"generation", ainstr.Generation,
		"enabled", ainstr.Spec.Enabled,
	)

	// ── spec.enabled=false → pause injection ─────────────────────────
	if !ainstr.Spec.Enabled {
		if err := r.setStatus(ctx, ainstr,
			metav1.ConditionFalse,
			aepv1alpha1.ReasonDisabled,
			"Sidecar injection is paused (spec.enabled=false).",
			0,
		); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil // no requeue; next change will re-trigger
	}

	// ── Count already-injected pods ──────────────────────────────────
	injected, err := r.countInjectedPods(ctx, ainstr)
	if err != nil {
		logger.Error(err, "counting injected pods")
		// Best-effort status update; log but don't mask the original error.
		if sErr := r.setStatus(ctx, ainstr,
			metav1.ConditionFalse,
			aepv1alpha1.ReasonInjectionFailed,
			fmt.Sprintf("Failed to count injected pods: %v", err),
			0,
		); sErr != nil {
			logger.Error(sErr, "updating status after count error")
		}
		return ctrl.Result{}, err
	}

	// ── Healthy ──────────────────────────────────────────────────────
	if err := r.setStatus(ctx, ainstr,
		metav1.ConditionTrue,
		aepv1alpha1.ReasonActive,
		fmt.Sprintf("Injection active. %d pod(s) instrumented.", injected),
		injected,
	); err != nil {
		return ctrl.Result{}, err
	}

	// Requeue periodically so injectedCount stays accurate even without
	// spec changes (e.g. after a deployment rollout replaces all pods).
	return ctrl.Result{RequeueAfter: requeueInterval}, nil
}

// countInjectedPods lists eligible namespaces and counts pods in them that
// carry the aep.dev/injected=true annotation.
func (r *AgentInstrumentationReconciler) countInjectedPods(
	ctx context.Context,
	ainstr *aepv1alpha1.AgentInstrumentation,
) (int32, error) {

	// ── Resolve eligible namespaces ──────────────────────────────────
	nsList := &corev1.NamespaceList{}
	nsListOpts := []client.ListOption{}
	if ainstr.Spec.NamespaceSelector != nil {
		sel, err := metav1.LabelSelectorAsSelector(ainstr.Spec.NamespaceSelector)
		if err != nil {
			return 0, fmt.Errorf("invalid namespaceSelector: %w", err)
		}
		nsListOpts = append(nsListOpts, client.MatchingLabelsSelector{Selector: sel})
	}
	if err := r.List(ctx, nsList, nsListOpts...); err != nil {
		return 0, fmt.Errorf("listing namespaces: %w", err)
	}

	// ── Build optional pod label selector ────────────────────────────
	var podSel labels.Selector
	if ainstr.Spec.PodSelector != nil {
		var err error
		podSel, err = metav1.LabelSelectorAsSelector(ainstr.Spec.PodSelector)
		if err != nil {
			return 0, fmt.Errorf("invalid podSelector: %w", err)
		}
	}

	// ── Count injected pods across all eligible namespaces ───────────
	var total int32
	for i := range nsList.Items {
		ns := nsList.Items[i].Name
		podList := &corev1.PodList{}
		listOpts := []client.ListOption{client.InNamespace(ns)}
		if podSel != nil {
			listOpts = append(listOpts, client.MatchingLabelsSelector{Selector: podSel})
		}
		if err := r.List(ctx, podList, listOpts...); err != nil {
			return 0, fmt.Errorf("listing pods in namespace %q: %w", ns, err)
		}
		for j := range podList.Items {
			if podList.Items[j].Annotations[SidecarAnnotation] == "true" {
				total++
			}
		}
	}
	return total, nil
}

// setStatus updates the Ready condition and counters, then patches status via
// the status subresource. It uses a MergeFrom patch to minimise write conflicts.
//
// Note: setStatus mutates ainstr.Status in place as a side effect of calling
// apimeta.SetStatusCondition. Callers must not read ainstr.Status after this
// call; re-fetch from the API server if the updated state is needed.
func (r *AgentInstrumentationReconciler) setStatus(
	ctx context.Context,
	ainstr *aepv1alpha1.AgentInstrumentation,
	status metav1.ConditionStatus,
	reason, message string,
	injected int32,
) error {
	patch := client.MergeFrom(ainstr.DeepCopy())

	apimeta.SetStatusCondition(&ainstr.Status.Conditions, metav1.Condition{
		Type:               aepv1alpha1.ConditionReady,
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: ainstr.Generation,
	})
	ainstr.Status.InjectedCount = injected
	ainstr.Status.ObservedGeneration = ainstr.Generation

	if err := r.Status().Patch(ctx, ainstr, patch); err != nil {
		return fmt.Errorf("patching AgentInstrumentation status: %w", err)
	}
	return nil
}

// SetupWithManager registers the controller with the manager and establishes
// watches on AgentInstrumentation resources.
func (r *AgentInstrumentationReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&aepv1alpha1.AgentInstrumentation{}).
		Complete(r)
}
