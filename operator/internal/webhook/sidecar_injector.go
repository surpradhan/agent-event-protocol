// Copyright 2026 Surabhi Pradhan.
// SPDX-License-Identifier: MIT

// Package webhook implements the AEP sidecar-injection mutating webhook.
//
// # Injection flow
//
//  1. A Pod creation request reaches the API server.
//  2. The MutatingWebhookConfiguration routes it here via /mutate-core-v1-pod.
//  3. Handle() checks the pod for aep.dev/inject=true (opt-in) and
//     aep.dev/inject=false (explicit opt-out).
//  4. If injection is requested, it checks whether any enabled
//     AgentInstrumentation covers this pod's namespace.
//  5. If covered, it builds and appends the AEP sidecar container, stamps
//     aep.dev/injected=true, and returns a JSON patch.
package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	aepv1alpha1 "github.com/surpradhan/aep-operator/api/v1alpha1"
)

const (
	// InjectAnnotation is the opt-in annotation users add to pods.
	InjectAnnotation = "aep.dev/inject"

	// InjectedAnnotation is stamped on pods after successful injection.
	// The controller reads this to compute status.injectedCount.
	InjectedAnnotation = "aep.dev/injected"

	// SidecarContainerName is the name of the injected container.
	// Exported so tests and the controller can reference it without hardcoding.
	SidecarContainerName = "aep-sidecar"

	// webhookPath is the HTTP path the API server sends admission requests to.
	webhookPath = "/mutate-core-v1-pod"
)

// SidecarInjector is a mutating admission webhook that injects the AEP sidecar
// container into pods opted in via the aep.dev/inject=true annotation.
//
// +kubebuilder:webhook:path=/mutate-core-v1-pod,mutating=true,failurePolicy=ignore,sideEffects=None,groups=core,resources=pods,verbs=create,versions=v1,name=mpod.aep.dev,admissionReviewVersions=v1
type SidecarInjector struct {
	Client       client.Client
	AEPServerURL string
	SidecarImage string
	// Decoder is set by SetupWithManager and may be overridden in tests.
	Decoder *admission.Decoder
}

// Handle processes a mutating admission request for a Pod.
// It is called by the webhook server on every Pod CREATE routed to this path.
func (s *SidecarInjector) Handle(ctx context.Context, req admission.Request) admission.Response {
	logger := log.FromContext(ctx).WithValues(
		"pod", req.Name,
		"namespace", req.Namespace,
	)

	pod := &corev1.Pod{}
	if err := s.Decoder.Decode(req, pod); err != nil {
		return admission.Errored(http.StatusBadRequest,
			fmt.Errorf("decoding pod: %w", err))
	}

	// ── Explicit opt-out: aep.dev/inject=false ───────────────────────
	if pod.Annotations[InjectAnnotation] == "false" {
		logger.V(1).Info("skipping injection: aep.dev/inject=false")
		return admission.Allowed("injection explicitly disabled")
	}

	// ── Opt-in gate: aep.dev/inject=true required ────────────────────
	if pod.Annotations[InjectAnnotation] != "true" {
		return admission.Allowed("no aep.dev/inject=true annotation")
	}

	// ── Already injected guard (e.g. webhook called twice) ───────────
	if pod.Annotations[InjectedAnnotation] == "true" {
		logger.V(1).Info("skipping injection: already injected")
		return admission.Allowed("sidecar already present")
	}

	// ── Find a covering AgentInstrumentation ─────────────────────────
	ainstr, err := s.findCoveringInstrumentation(ctx, req.Namespace)
	if err != nil {
		logger.Error(err, "looking up AgentInstrumentation")
		return admission.Errored(http.StatusInternalServerError,
			fmt.Errorf("looking up AgentInstrumentation: %w", err))
	}
	if ainstr == nil {
		logger.V(1).Info("no enabled AgentInstrumentation covers this namespace")
		return admission.Allowed("no covering AgentInstrumentation")
	}

	// ── Inject ───────────────────────────────────────────────────────
	original, err := json.Marshal(pod)
	if err != nil {
		return admission.Errored(http.StatusInternalServerError,
			fmt.Errorf("marshalling original pod: %w", err))
	}

	s.inject(pod, req.Namespace, ainstr)

	patched, err := json.Marshal(pod)
	if err != nil {
		return admission.Errored(http.StatusInternalServerError,
			fmt.Errorf("marshalling patched pod: %w", err))
	}

	logger.Info("injected AEP sidecar",
		"agentInstrumentation", ainstr.Name,
		"sidecarImage", s.sidecarImage(ainstr),
	)
	return admission.PatchResponseFromRaw(original, patched)
}

// findCoveringInstrumentation returns the first enabled AgentInstrumentation
// whose namespaceSelector covers podNamespace, or nil if none exists.
//
// Conflict resolution: when multiple resources match, alphabetical-first wins
// (consistent with the policy documented on AgentInstrumentationSpec).
func (s *SidecarInjector) findCoveringInstrumentation(
	ctx context.Context,
	podNamespace string,
) (*aepv1alpha1.AgentInstrumentation, error) {

	list := &aepv1alpha1.AgentInstrumentationList{}
	if err := s.Client.List(ctx, list); err != nil {
		return nil, fmt.Errorf("listing AgentInstrumentations: %w", err)
	}

	// Fetch the namespace object once so we can match its labels.
	ns := &corev1.Namespace{}
	if err := s.Client.Get(ctx, client.ObjectKey{Name: podNamespace}, ns); err != nil {
		return nil, fmt.Errorf("fetching namespace %q: %w", podNamespace, err)
	}

	// Items are returned in unspecified order; sort by name for determinism.
	sortByName(list.Items)

	for i := range list.Items {
		ai := &list.Items[i]
		if !ai.Spec.Enabled {
			continue
		}
		if covers, err := namespaceCovered(ai, ns); err != nil {
			return nil, err
		} else if covers {
			return ai, nil
		}
	}
	return nil, nil
}

// namespaceCovered reports whether ai's namespaceSelector matches ns.
// A nil selector matches all namespaces.
func namespaceCovered(ai *aepv1alpha1.AgentInstrumentation, ns *corev1.Namespace) (bool, error) {
	if ai.Spec.NamespaceSelector == nil {
		return true, nil
	}
	sel, err := metav1.LabelSelectorAsSelector(ai.Spec.NamespaceSelector)
	if err != nil {
		return false, fmt.Errorf("invalid namespaceSelector on %q: %w", ai.Name, err)
	}
	return sel.Matches(labels.Set(ns.Labels)), nil
}

// inject appends the AEP sidecar container to pod and stamps the injected annotation.
func (s *SidecarInjector) inject(
	pod *corev1.Pod,
	namespace string,
	ainstr *aepv1alpha1.AgentInstrumentation,
) {
	if pod.Annotations == nil {
		pod.Annotations = make(map[string]string)
	}
	pod.Annotations[InjectedAnnotation] = "true"

	sidecar := s.buildSidecar(namespace, ainstr)
	pod.Spec.Containers = append(pod.Spec.Containers, sidecar)
}

// buildSidecar constructs the AEP sidecar container spec.
// Environment variables are layered in this order (last wins):
//  1. Operator defaults (AEP_SERVER_URL, AEP_NAMESPACE)
//  2. Kubernetes downward API (AEP_POD_NAME, AEP_NODE_NAME, AEP_POD_UID)
//  3. API key Secret (AEP_API_KEY, if spec.apiKeySecretRef is set)
//  4. Per-instrumentation overrides (spec.env)
func (s *SidecarInjector) buildSidecar(
	namespace string,
	ainstr *aepv1alpha1.AgentInstrumentation,
) corev1.Container {

	aepURL := s.sidecarURL(ainstr)

	// Base environment: server URL + Kubernetes metadata via downward API.
	env := []corev1.EnvVar{
		{Name: "AEP_SERVER_URL", Value: aepURL},
		{Name: "AEP_NAMESPACE", Value: namespace},
		{
			Name: "AEP_POD_NAME",
			ValueFrom: &corev1.EnvVarSource{
				FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"},
			},
		},
		{
			Name: "AEP_NODE_NAME",
			ValueFrom: &corev1.EnvVarSource{
				FieldRef: &corev1.ObjectFieldSelector{FieldPath: "spec.nodeName"},
			},
		},
		{
			Name: "AEP_POD_UID",
			ValueFrom: &corev1.EnvVarSource{
				FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.uid"},
			},
		},
	}

	// API key from Secret (if configured).
	if ainstr.Spec.APIKeySecretRef != nil {
		env = append(env, corev1.EnvVar{
			Name: "AEP_API_KEY",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: ainstr.Spec.APIKeySecretRef,
			},
		})
	}

	// Per-instrumentation env overrides last — they win over defaults.
	env = append(env, ainstr.Spec.Env...)

	// Resource requirements: use per-instrumentation override or safe defaults.
	resources := ainstr.Spec.Resources
	if resources.Requests == nil && resources.Limits == nil {
		resources = defaultResources()
	}

	return corev1.Container{
		Name:            SidecarContainerName,
		Image:           s.sidecarImage(ainstr),
		ImagePullPolicy: corev1.PullIfNotPresent,
		Env:             env,
		Resources:       resources,
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: boolPtr(false),
			ReadOnlyRootFilesystem:   boolPtr(true),
			RunAsNonRoot:             boolPtr(true),
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
	}
}

// defaultResources returns minimal resource requests/limits for the sidecar.
func defaultResources() corev1.ResourceRequirements {
	return corev1.ResourceRequirements{
		Requests: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("5m"),
			corev1.ResourceMemory: resource.MustParse("16Mi"),
		},
		Limits: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("100m"),
			corev1.ResourceMemory: resource.MustParse("64Mi"),
		},
	}
}

// sidecarImage returns the effective sidecar image (per-CR override or operator default).
func (s *SidecarInjector) sidecarImage(ainstr *aepv1alpha1.AgentInstrumentation) string {
	if ainstr.Spec.SidecarImage != "" {
		return ainstr.Spec.SidecarImage
	}
	return s.SidecarImage
}

// sidecarURL returns the effective AEP server URL (per-CR override or operator default).
func (s *SidecarInjector) sidecarURL(ainstr *aepv1alpha1.AgentInstrumentation) string {
	if ainstr.Spec.AEPServerURL != "" {
		return ainstr.Spec.AEPServerURL
	}
	return s.AEPServerURL
}

// sortByName sorts AgentInstrumentation items in-place by .metadata.name so
// conflict resolution is deterministic.
func sortByName(items []aepv1alpha1.AgentInstrumentation) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j].Name < items[j-1].Name; j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

// boolPtr returns a pointer to the given bool value.
func boolPtr(b bool) *bool { return &b }

// SetupWithManager registers the webhook handler with the controller-runtime
// webhook server.
func (s *SidecarInjector) SetupWithManager(mgr ctrl.Manager) error {
	s.Decoder = admission.NewDecoder(mgr.GetScheme())
	mgr.GetWebhookServer().Register(webhookPath,
		&webhook.Admission{Handler: s})
	return nil
}
