// Copyright 2026 Surabhi Pradhan.
// SPDX-License-Identifier: MIT

package controller_test

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	aepv1alpha1 "github.com/surpradhan/aep-operator/api/v1alpha1"
	"github.com/surpradhan/aep-operator/internal/controller"
)

// ── Helpers ──────────────────────────────────────────────────────────────────

func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatalf("clientgoscheme.AddToScheme: %v", err)
	}
	if err := aepv1alpha1.AddToScheme(s); err != nil {
		t.Fatalf("aepv1alpha1.AddToScheme: %v", err)
	}
	return s
}

// getAinstr fetches the AgentInstrumentation named `name` from the fake client.
func getAinstr(t *testing.T, c interface {
	Get(ctx context.Context, key types.NamespacedName, obj interface{ DeepCopyObject() runtime.Object }, opts ...interface{}) error
}, name string) *aepv1alpha1.AgentInstrumentation {
	t.Helper()
	// Use the raw client instead — fake.Client implements client.Client
	return nil // placeholder; actual assertion done inline per test
}

func reconcile(t *testing.T, r *controller.AgentInstrumentationReconciler, name string) (ctrl.Result, error) {
	t.Helper()
	return r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: name},
	})
}

func requireCondition(
	t *testing.T,
	conditions []metav1.Condition,
	condType string,
	wantStatus metav1.ConditionStatus,
	wantReason string,
) {
	t.Helper()
	cond := apimeta.FindStatusCondition(conditions, condType)
	if cond == nil {
		t.Fatalf("condition %q not found in %+v", condType, conditions)
	}
	if cond.Status != wantStatus {
		t.Errorf("condition %q: want status %s, got %s (reason=%s, msg=%s)",
			condType, wantStatus, cond.Status, cond.Reason, cond.Message)
	}
	if cond.Reason != wantReason {
		t.Errorf("condition %q: want reason %s, got %s", condType, wantReason, cond.Reason)
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestReconcile_NotFound verifies a clean return when the resource is already
// deleted before the reconcile loop runs.
func TestReconcile_NotFound(t *testing.T) {
	scheme := testScheme(t)
	r := &controller.AgentInstrumentationReconciler{
		Client: fake.NewClientBuilder().WithScheme(scheme).Build(),
		Scheme: scheme,
	}
	result, err := reconcile(t, r, "nonexistent")
	if err != nil {
		t.Fatalf("expected no error for not-found resource, got: %v", err)
	}
	if result.Requeue || result.RequeueAfter != 0 {
		t.Error("expected no requeue for not-found resource")
	}
}

// TestReconcile_Disabled verifies Ready=False/Disabled when spec.enabled=false.
func TestReconcile_Disabled(t *testing.T) {
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Generation: 1},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: false},
	}
	scheme := testScheme(t)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(ainstr).
		WithStatusSubresource(ainstr).
		Build()
	r := &controller.AgentInstrumentationReconciler{Client: c, Scheme: scheme}

	result, err := reconcile(t, r, "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Disabled → no periodic requeue.
	if result.Requeue || result.RequeueAfter != 0 {
		t.Errorf("expected no requeue when disabled, got %+v", result)
	}

	updated := &aepv1alpha1.AgentInstrumentation{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "test"}, updated); err != nil {
		t.Fatalf("fetching updated resource: %v", err)
	}
	requireCondition(t, updated.Status.Conditions,
		aepv1alpha1.ConditionReady, metav1.ConditionFalse, aepv1alpha1.ReasonDisabled)
	if updated.Status.InjectedCount != 0 {
		t.Errorf("expected InjectedCount=0 when disabled, got %d", updated.Status.InjectedCount)
	}
	if updated.Status.ObservedGeneration != 1 {
		t.Errorf("expected ObservedGeneration=1, got %d", updated.Status.ObservedGeneration)
	}
}

// TestReconcile_Enabled_NoPods verifies Ready=True/Active when enabled with no
// injected pods yet.
func TestReconcile_Enabled_NoPods(t *testing.T) {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "default"}}
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Generation: 2},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: true},
	}
	scheme := testScheme(t)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(ainstr, ns).
		WithStatusSubresource(ainstr).
		Build()
	r := &controller.AgentInstrumentationReconciler{Client: c, Scheme: scheme}

	result, err := reconcile(t, r, "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Active → should requeue after interval.
	if result.RequeueAfter == 0 {
		t.Error("expected RequeueAfter for active instrumentation")
	}

	updated := &aepv1alpha1.AgentInstrumentation{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "test"}, updated); err != nil {
		t.Fatalf("fetching updated resource: %v", err)
	}
	requireCondition(t, updated.Status.Conditions,
		aepv1alpha1.ConditionReady, metav1.ConditionTrue, aepv1alpha1.ReasonActive)
	if updated.Status.InjectedCount != 0 {
		t.Errorf("expected InjectedCount=0, got %d", updated.Status.InjectedCount)
	}
	if updated.Status.ObservedGeneration != 2 {
		t.Errorf("expected ObservedGeneration=2, got %d", updated.Status.ObservedGeneration)
	}
}

// TestReconcile_Enabled_WithInjectedPods verifies that injected pod count is
// correctly reflected in status.
func TestReconcile_Enabled_WithInjectedPods(t *testing.T) {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "default"}}
	injectedPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "agent-1", Namespace: "default",
			Annotations: map[string]string{controller.SidecarAnnotation: "true"},
		},
	}
	plainPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "default"},
	}
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Generation: 1},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: true},
	}
	scheme := testScheme(t)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(ainstr, ns, injectedPod, plainPod).
		WithStatusSubresource(ainstr).
		Build()
	r := &controller.AgentInstrumentationReconciler{Client: c, Scheme: scheme}

	if _, err := reconcile(t, r, "test"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	updated := &aepv1alpha1.AgentInstrumentation{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "test"}, updated); err != nil {
		t.Fatalf("fetching updated resource: %v", err)
	}
	if updated.Status.InjectedCount != 1 {
		t.Errorf("expected InjectedCount=1, got %d", updated.Status.InjectedCount)
	}
}

// TestReconcile_Enabled_MultipleInjectedPods verifies count across multiple pods.
func TestReconcile_Enabled_MultipleInjectedPods(t *testing.T) {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "default"}}
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Generation: 1},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: true},
	}
	objects := []interface{ DeepCopyObject() runtime.Object }{ainstr, ns}
	// Add 3 injected pods and 2 plain pods.
	for i := 1; i <= 3; i++ {
		objects = append(objects, &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name:        fmt.Sprintf("injected-%d", i),
				Namespace:   "default",
				Annotations: map[string]string{controller.SidecarAnnotation: "true"},
			},
		})
	}
	for i := 1; i <= 2; i++ {
		objects = append(objects, &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name:      fmt.Sprintf("plain-%d", i),
				Namespace: "default",
			},
		})
	}
	scheme := testScheme(t)
	builder := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(ainstr)
	for _, o := range objects {
		builder = builder.WithObjects(o.(interface {
			DeepCopyObject() runtime.Object
		}))
	}
	// Rebuild cleanly using individual WithObjects calls
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(ainstr, ns).
		WithStatusSubresource(ainstr).
		Build()

	// Add pods directly
	for i := 1; i <= 3; i++ {
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name:        fmt.Sprintf("injected-%d", i),
				Namespace:   "default",
				Annotations: map[string]string{controller.SidecarAnnotation: "true"},
			},
		}
		if err := c.Create(context.Background(), pod); err != nil {
			t.Fatalf("creating pod: %v", err)
		}
	}
	for i := 1; i <= 2; i++ {
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name:      fmt.Sprintf("plain-%d", i),
				Namespace: "default",
			},
		}
		if err := c.Create(context.Background(), pod); err != nil {
			t.Fatalf("creating plain pod: %v", err)
		}
	}

	r := &controller.AgentInstrumentationReconciler{Client: c, Scheme: scheme}
	if _, err := reconcile(t, r, "test"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	updated := &aepv1alpha1.AgentInstrumentation{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "test"}, updated); err != nil {
		t.Fatalf("fetching: %v", err)
	}
	if updated.Status.InjectedCount != 3 {
		t.Errorf("expected InjectedCount=3, got %d", updated.Status.InjectedCount)
	}
}

// TestReconcile_ConditionObservedGeneration verifies the condition carries the
// correct ObservedGeneration (not zero).
func TestReconcile_ConditionObservedGeneration(t *testing.T) {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "default"}}
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Generation: 5},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: true},
	}
	scheme := testScheme(t)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(ainstr, ns).
		WithStatusSubresource(ainstr).
		Build()
	r := &controller.AgentInstrumentationReconciler{Client: c, Scheme: scheme}

	if _, err := reconcile(t, r, "test"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	updated := &aepv1alpha1.AgentInstrumentation{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "test"}, updated); err != nil {
		t.Fatalf("fetching: %v", err)
	}
	cond := apimeta.FindStatusCondition(updated.Status.Conditions, aepv1alpha1.ConditionReady)
	if cond == nil {
		t.Fatal("Ready condition not found")
	}
	if cond.ObservedGeneration != 5 {
		t.Errorf("expected ObservedGeneration=5 on condition, got %d", cond.ObservedGeneration)
	}
}

// TestReconcile_RequeueInterval verifies the active case returns a RequeueAfter
// greater than zero (exact value is an implementation detail).
func TestReconcile_RequeueInterval(t *testing.T) {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "default"}}
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Generation: 1},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: true},
	}
	scheme := testScheme(t)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(ainstr, ns).
		WithStatusSubresource(ainstr).
		Build()
	r := &controller.AgentInstrumentationReconciler{Client: c, Scheme: scheme}

	result, err := reconcile(t, r, "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.RequeueAfter < time.Minute {
		t.Errorf("expected RequeueAfter >= 1m, got %s", result.RequeueAfter)
	}
}

// TestReconcile_NamespaceSelector verifies that only pods in matching
// namespaces are counted.
func TestReconcile_NamespaceSelector(t *testing.T) {
	matchedNS := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name:   "ai-workloads",
			Labels: map[string]string{"aep.dev/instrumented": "true"},
		},
	}
	unmatchedNS := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: "other"},
	}
	// One injected pod in matched NS, one in unmatched NS.
	podMatched := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "agent", Namespace: "ai-workloads",
			Annotations: map[string]string{controller.SidecarAnnotation: "true"},
		},
	}
	podUnmatched := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "agent", Namespace: "other",
			Annotations: map[string]string{controller.SidecarAnnotation: "true"},
		},
	}
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Generation: 1},
		Spec: aepv1alpha1.AgentInstrumentationSpec{
			Enabled: true,
			NamespaceSelector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"aep.dev/instrumented": "true"},
			},
		},
	}
	scheme := testScheme(t)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(ainstr, matchedNS, unmatchedNS, podMatched, podUnmatched).
		WithStatusSubresource(ainstr).
		Build()
	r := &controller.AgentInstrumentationReconciler{Client: c, Scheme: scheme}

	if _, err := reconcile(t, r, "test"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	updated := &aepv1alpha1.AgentInstrumentation{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "test"}, updated); err != nil {
		t.Fatalf("fetching: %v", err)
	}
	// Only pod in matched namespace should be counted.
	if updated.Status.InjectedCount != 1 {
		t.Errorf("expected InjectedCount=1 (only matched namespace), got %d",
			updated.Status.InjectedCount)
	}
}
