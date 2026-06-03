// Package controller implements the AgentInstrumentation reconciler.
// Full reconcile logic is added in Step 3.
package controller

import (
	"context"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// AgentInstrumentationReconciler reconciles AgentInstrumentation resources.
type AgentInstrumentationReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile is the stub reconcile loop — full implementation in Step 3.
func (r *AgentInstrumentationReconciler) Reconcile(_ context.Context, _ reconcile.Request) (ctrl.Result, error) {
	return ctrl.Result{}, nil
}

// SetupWithManager registers the controller with the manager.
// Full watch/predicate setup is added in Step 3.
func (r *AgentInstrumentationReconciler) SetupWithManager(_ ctrl.Manager) error {
	return nil
}
