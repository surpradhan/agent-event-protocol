// Copyright 2026 Surabhi Pradhan.
// SPDX-License-Identifier: MIT

//go:build integration

// Package tests contains integration tests for the AEP operator.
//
// These tests use controller-runtime's envtest framework, which spins up a
// real API server binary without requiring a live cluster.
//
// # Prerequisites
//
//	make envtest                              # install setup-envtest once
//	source <(setup-envtest use 1.29 -p env)  # set KUBEBUILDER_ASSETS
//	go test -tags integration ./tests/...
//
// Or use the Makefile shortcut:
//
//	make test-integration
package tests

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	aepv1alpha1 "github.com/surpradhan/aep-operator/api/v1alpha1"
	"github.com/surpradhan/aep-operator/internal/controller"
)

// ── Suite setup ───────────────────────────────────────────────────────────────

var (
	testEnv *envtest.Environment
	k8sClient client.Client
	scheme    *runtime.Scheme
)

func TestMain(m *testing.M) {
	ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

	scheme = runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(scheme)
	_ = aepv1alpha1.AddToScheme(scheme)

	// Locate CRD manifests relative to this test file.
	crdPaths := []string{
		filepath.Join("..", "config", "crd"),
	}

	testEnv = &envtest.Environment{
		CRDDirectoryPaths:     crdPaths,
		ErrorIfCRDPathMissing: true,
		Scheme:                scheme,
	}

	cfg, err := testEnv.Start()
	if err != nil {
		panic("failed to start envtest: " + err.Error())
	}

	k8sClient, err = client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		panic("failed to create client: " + err.Error())
	}

	code := m.Run()

	_ = testEnv.Stop()
	os.Exit(code)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// startReconciler starts the AgentInstrumentation reconciler in the background
// and returns a cancel function that shuts it down.
func startReconciler(t *testing.T) context.CancelFunc {
	t.Helper()
	mgr, err := ctrl.NewManager(testEnv.Config, ctrl.Options{Scheme: scheme})
	if err != nil {
		t.Fatalf("creating manager: %v", err)
	}
	if err := (&controller.AgentInstrumentationReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		t.Fatalf("setting up controller: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		if err := mgr.Start(ctx); err != nil {
			t.Logf("manager stopped: %v", err)
		}
	}()
	return cancel
}

// waitForCondition polls until the AgentInstrumentation has a Ready condition
// with the expected status, or times out.
func waitForCondition(
	t *testing.T,
	name string,
	wantStatus metav1.ConditionStatus,
	timeout time.Duration,
) *aepv1alpha1.AgentInstrumentation {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		ainstr := &aepv1alpha1.AgentInstrumentation{}
		if err := k8sClient.Get(context.Background(),
			types.NamespacedName{Name: name}, ainstr); err == nil {
			for _, c := range ainstr.Status.Conditions {
				if c.Type == aepv1alpha1.ConditionReady && c.Status == wantStatus {
					return ainstr
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s Ready=%s", name, wantStatus)
	return nil
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestReconciler_CreateAndReady verifies the full create→reconcile→Ready flow.
func TestReconciler_CreateAndReady(t *testing.T) {
	cancel := startReconciler(t)
	defer cancel()

	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "integration-test",
			Generation: 1,
		},
		Spec: aepv1alpha1.AgentInstrumentationSpec{
			Enabled: true,
		},
	}
	if err := k8sClient.Create(context.Background(), ainstr); err != nil {
		t.Fatalf("creating AgentInstrumentation: %v", err)
	}
	t.Cleanup(func() {
		_ = k8sClient.Delete(context.Background(), ainstr)
	})

	got := waitForCondition(t, "integration-test", metav1.ConditionTrue, 10*time.Second)
	if got.Status.ObservedGeneration == 0 {
		t.Error("expected non-zero ObservedGeneration after reconcile")
	}
}

// TestReconciler_DisabledResource verifies Ready=False when spec.enabled=false.
func TestReconciler_DisabledResource(t *testing.T) {
	cancel := startReconciler(t)
	defer cancel()

	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "integration-disabled"},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: false},
	}
	if err := k8sClient.Create(context.Background(), ainstr); err != nil {
		t.Fatalf("creating AgentInstrumentation: %v", err)
	}
	t.Cleanup(func() {
		_ = k8sClient.Delete(context.Background(), ainstr)
	})

	got := waitForCondition(t, "integration-disabled", metav1.ConditionFalse, 10*time.Second)
	for _, c := range got.Status.Conditions {
		if c.Type == aepv1alpha1.ConditionReady {
			if c.Reason != aepv1alpha1.ReasonDisabled {
				t.Errorf("expected reason=%s, got %s", aepv1alpha1.ReasonDisabled, c.Reason)
			}
		}
	}
}

// TestReconciler_InjectedPodCount verifies that pods annotated with
// aep.dev/injected=true are counted in status.injectedCount.
func TestReconciler_InjectedPodCount(t *testing.T) {
	cancel := startReconciler(t)
	defer cancel()

	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: "integration-ns"},
	}
	if err := k8sClient.Create(context.Background(), ns); err != nil {
		t.Fatalf("creating namespace: %v", err)
	}
	t.Cleanup(func() { _ = k8sClient.Delete(context.Background(), ns) })

	// Create a pod annotated as injected.
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "injected-pod",
			Namespace: "integration-ns",
			Annotations: map[string]string{
				"aep.dev/injected": "true",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "app", Image: "nginx:latest"}},
		},
	}
	if err := k8sClient.Create(context.Background(), pod); err != nil {
		t.Fatalf("creating pod: %v", err)
	}
	t.Cleanup(func() { _ = k8sClient.Delete(context.Background(), pod) })

	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "integration-count"},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: true},
	}
	if err := k8sClient.Create(context.Background(), ainstr); err != nil {
		t.Fatalf("creating AgentInstrumentation: %v", err)
	}
	t.Cleanup(func() { _ = k8sClient.Delete(context.Background(), ainstr) })

	// Wait for active status then check count.
	deadline := time.Now().Add(10 * time.Second)
	var got *aepv1alpha1.AgentInstrumentation
	for time.Now().Before(deadline) {
		got = waitForCondition(t, "integration-count", metav1.ConditionTrue, 5*time.Second)
		if got.Status.InjectedCount >= 1 {
			break
		}
		time.Sleep(200 * time.Millisecond)
		// Re-fetch.
		_ = k8sClient.Get(context.Background(),
			types.NamespacedName{Name: "integration-count"}, got)
	}
	if got.Status.InjectedCount < 1 {
		t.Errorf("expected InjectedCount >= 1, got %d", got.Status.InjectedCount)
	}
}

// TestReconciler_UpdateSpec verifies that changing spec.enabled triggers a reconcile.
func TestReconciler_UpdateSpec(t *testing.T) {
	cancel := startReconciler(t)
	defer cancel()

	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "integration-update"},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: true},
	}
	if err := k8sClient.Create(context.Background(), ainstr); err != nil {
		t.Fatalf("creating AgentInstrumentation: %v", err)
	}
	t.Cleanup(func() { _ = k8sClient.Delete(context.Background(), ainstr) })

	// Wait for Ready=True.
	waitForCondition(t, "integration-update", metav1.ConditionTrue, 10*time.Second)

	// Disable injection.
	patch := client.MergeFrom(ainstr.DeepCopy())
	ainstr.Spec.Enabled = false
	if err := k8sClient.Patch(context.Background(), ainstr, patch); err != nil {
		t.Fatalf("patching spec.enabled=false: %v", err)
	}

	// Expect Ready=False.
	waitForCondition(t, "integration-update", metav1.ConditionFalse, 10*time.Second)
}
