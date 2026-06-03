// Copyright 2026 Surabhi Pradhan.
// SPDX-License-Identifier: MIT

package webhook_test

import (
	"context"
	"encoding/json"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	aepv1alpha1 "github.com/surpradhan/aep-operator/api/v1alpha1"
	"github.com/surpradhan/aep-operator/internal/webhook"
)

// ── Helpers ───────────────────────────────────────────────────────────────────

func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatalf("clientgoscheme: %v", err)
	}
	if err := aepv1alpha1.AddToScheme(s); err != nil {
		t.Fatalf("aepv1alpha1: %v", err)
	}
	return s
}

// newInjector builds a SidecarInjector with a fake client and a decoder.
func newInjector(t *testing.T, scheme *runtime.Scheme, objs ...client.Object) *webhook.SidecarInjector {
	t.Helper()
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
	inj := &webhook.SidecarInjector{
		Client:       c,
		AEPServerURL: "http://aep.default.svc:8787",
		SidecarImage: "ghcr.io/surpradhan/aep-sidecar:test",
		Decoder:      admission.NewDecoder(scheme),
	}
	return inj
}

// podRequest builds an admission.Request for a Pod CREATE.
func podRequest(t *testing.T, pod *corev1.Pod) admission.Request {
	t.Helper()
	raw, err := json.Marshal(pod)
	if err != nil {
		t.Fatalf("marshalling pod: %v", err)
	}
	return admission.Request{
		AdmissionRequest: admissionv1.AdmissionRequest{
			UID:       "test-uid",
			Name:      pod.Name,
			Namespace: pod.Namespace,
			Operation: admissionv1.Create,
			Object:    runtime.RawExtension{Raw: raw},
		},
	}
}

// plainNS returns a Namespace with no labels.
func plainNS(name string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

// labelledNS returns a Namespace with the given labels.
func labelledNS(name string, lbl map[string]string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: lbl}}
}

// enabledAinstr returns an enabled AgentInstrumentation with optional NS selector.
func enabledAinstr(name string, nsSelector *metav1.LabelSelector) *aepv1alpha1.AgentInstrumentation {
	return &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: aepv1alpha1.AgentInstrumentationSpec{
			Enabled:           true,
			NamespaceSelector: nsSelector,
		},
	}
}

// sidecarFromPatches extracts the aep-sidecar container from the admission
// patches. Returns nil if no container add patch is found.
func sidecarFromPatches(t *testing.T, patches []admission.JSONPatchOp) *corev1.Container {
	t.Helper()
	for _, p := range patches {
		if p.Operation == "add" && p.Path == "/spec/containers/-" {
			raw, err := json.Marshal(p.Value)
			if err != nil {
				t.Fatalf("marshalling patch value: %v", err)
			}
			var c corev1.Container
			if err := json.Unmarshal(raw, &c); err != nil {
				t.Fatalf("unmarshalling container from patch: %v", err)
			}
			if c.Name == "aep-sidecar" {
				return &c
			}
		}
	}
	return nil
}

// patchedAnnotation returns the value set by an annotations add patch, or "".
func patchedAnnotation(patches []admission.JSONPatchOp, key string) string {
	// JSON Patch escapes '/' as '~1' in paths.
	escapedKey := ""
	for _, ch := range key {
		if ch == '/' {
			escapedKey += "~1"
		} else {
			escapedKey += string(ch)
		}
	}
	target := "/metadata/annotations/" + escapedKey
	for _, p := range patches {
		if p.Operation == "add" && p.Path == target {
			if s, ok := p.Value.(string); ok {
				return s
			}
		}
	}
	return ""
}

// envVal looks up an env var value by name (plain Value only, not ValueFrom).
func envVal(env []corev1.EnvVar, name string) string {
	for _, e := range env {
		if e.Name == name && e.ValueFrom == nil {
			return e.Value
		}
	}
	return ""
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestHandle_NoAnnotation: pod has no aep.dev/inject annotation → allowed, no patch.
func TestHandle_NoAnnotation(t *testing.T) {
	scheme := testScheme(t)
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "default"}}
	inj := newInjector(t, scheme, plainNS("default"))

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	if !resp.Allowed {
		t.Errorf("expected Allowed, got: %v", resp.Result)
	}
	if len(resp.Patches) > 0 {
		t.Errorf("expected no patches, got %d", len(resp.Patches))
	}
}

// TestHandle_ExplicitOptOut: aep.dev/inject=false → allowed, no patch even with active ainstr.
func TestHandle_ExplicitOptOut(t *testing.T) {
	scheme := testScheme(t)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "false"},
		},
	}
	inj := newInjector(t, scheme, plainNS("default"), enabledAinstr("global", nil))

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	if !resp.Allowed {
		t.Errorf("expected Allowed, got: %v", resp.Result)
	}
	if len(resp.Patches) > 0 {
		t.Errorf("expected no patches for opt-out, got %d", len(resp.Patches))
	}
}

// TestHandle_AlreadyInjected: pod already carries InjectedAnnotation → no-op.
func TestHandle_AlreadyInjected(t *testing.T) {
	scheme := testScheme(t)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{
				webhook.InjectAnnotation:   "true",
				webhook.InjectedAnnotation: "true",
			},
		},
	}
	inj := newInjector(t, scheme, plainNS("default"), enabledAinstr("global", nil))

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	if !resp.Allowed {
		t.Errorf("expected Allowed, got: %v", resp.Result)
	}
	if len(resp.Patches) > 0 {
		t.Errorf("expected no patches for already-injected pod, got %d", len(resp.Patches))
	}
}

// TestHandle_NoCoveringInstrumentation: opted-in but no AgentInstrumentation exists.
func TestHandle_NoCoveringInstrumentation(t *testing.T) {
	scheme := testScheme(t)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
	}
	inj := newInjector(t, scheme, plainNS("default")) // no ainstr objects

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	if !resp.Allowed {
		t.Errorf("expected Allowed, got: %v", resp.Result)
	}
	if len(resp.Patches) > 0 {
		t.Errorf("expected no patches, got %d", len(resp.Patches))
	}
}

// TestHandle_DisabledInstrumentation: ainstr exists but spec.enabled=false.
func TestHandle_DisabledInstrumentation(t *testing.T) {
	scheme := testScheme(t)
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec:       aepv1alpha1.AgentInstrumentationSpec{Enabled: false},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
	}
	inj := newInjector(t, scheme, plainNS("default"), ainstr)

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	if !resp.Allowed {
		t.Errorf("expected Allowed, got: %v", resp.Result)
	}
	if len(resp.Patches) > 0 {
		t.Errorf("expected no patches for disabled instrumentation, got %d", len(resp.Patches))
	}
}

// TestHandle_Inject: happy path — sidecar is appended and annotations are stamped.
func TestHandle_Inject(t *testing.T) {
	scheme := testScheme(t)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "agent", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "app", Image: "myapp:latest"}},
		},
	}
	inj := newInjector(t, scheme, plainNS("default"), enabledAinstr("global", nil))

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	if !resp.Allowed {
		t.Fatalf("expected Allowed, got: %+v", resp.Result)
	}
	if len(resp.Patches) == 0 {
		t.Fatal("expected patches, got none")
	}

	// InjectedAnnotation must be added.
	if got := patchedAnnotation(resp.Patches, webhook.InjectedAnnotation); got != "true" {
		t.Errorf("aep.dev/injected=%q, want true", got)
	}

	// Sidecar container must be appended.
	sidecar := sidecarFromPatches(t, resp.Patches)
	if sidecar == nil {
		t.Fatalf("aep-sidecar container not found in patches: %+v", resp.Patches)
	}
	if sidecar.Image != "ghcr.io/surpradhan/aep-sidecar:test" {
		t.Errorf("sidecar image=%q, want ghcr.io/surpradhan/aep-sidecar:test", sidecar.Image)
	}
	if got := envVal(sidecar.Env, "AEP_SERVER_URL"); got != "http://aep.default.svc:8787" {
		t.Errorf("AEP_SERVER_URL=%q, want http://aep.default.svc:8787", got)
	}
	if got := envVal(sidecar.Env, "AEP_NAMESPACE"); got != "default" {
		t.Errorf("AEP_NAMESPACE=%q, want default", got)
	}
}

// TestHandle_NamespaceSelectorFilter: ainstr with selector only covers labelled namespaces.
func TestHandle_NamespaceSelectorFilter(t *testing.T) {
	scheme := testScheme(t)
	ainstr := enabledAinstr("selective", &metav1.LabelSelector{
		MatchLabels: map[string]string{"team": "ai"},
	})

	podIn := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "ai",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}
	podOut := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}

	inj := newInjector(t, scheme,
		labelledNS("ai", map[string]string{"team": "ai"}),
		plainNS("default"),
		ainstr,
	)

	// Pod in matching namespace → injected.
	respIn := inj.Handle(context.Background(), podRequest(t, podIn))
	if !respIn.Allowed {
		t.Fatalf("expected Allowed for labelled NS: %+v", respIn.Result)
	}
	if sidecarFromPatches(t, respIn.Patches) == nil {
		t.Error("expected sidecar injection in labelled namespace")
	}

	// Pod in unmatched namespace → not injected.
	respOut := inj.Handle(context.Background(), podRequest(t, podOut))
	if !respOut.Allowed {
		t.Fatalf("expected Allowed for unlabelled NS: %+v", respOut.Result)
	}
	if len(respOut.Patches) > 0 {
		t.Errorf("expected no patches for unlabelled namespace, got %d", len(respOut.Patches))
	}
}

// TestHandle_PerCROverrides: per-CR sidecarImage and aepServerURL override operator defaults.
func TestHandle_PerCROverrides(t *testing.T) {
	scheme := testScheme(t)
	ainstr := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "custom"},
		Spec: aepv1alpha1.AgentInstrumentationSpec{
			Enabled:      true,
			SidecarImage: "myregistry/aep-sidecar:v2",
			AEPServerURL: "http://custom-aep:9000",
		},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}
	inj := newInjector(t, scheme, plainNS("default"), ainstr)

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	if !resp.Allowed || len(resp.Patches) == 0 {
		t.Fatalf("expected injection, got Allowed=%v patches=%d", resp.Allowed, len(resp.Patches))
	}
	sidecar := sidecarFromPatches(t, resp.Patches)
	if sidecar == nil {
		t.Fatal("sidecar not found in patches")
	}
	if sidecar.Image != "myregistry/aep-sidecar:v2" {
		t.Errorf("sidecar.Image=%q, want myregistry/aep-sidecar:v2", sidecar.Image)
	}
	if got := envVal(sidecar.Env, "AEP_SERVER_URL"); got != "http://custom-aep:9000" {
		t.Errorf("AEP_SERVER_URL=%q, want http://custom-aep:9000", got)
	}
}

// TestHandle_DefaultResources: sidecar gets default resource requests/limits.
func TestHandle_DefaultResources(t *testing.T) {
	scheme := testScheme(t)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}
	inj := newInjector(t, scheme, plainNS("default"), enabledAinstr("g", nil))

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	sidecar := sidecarFromPatches(t, resp.Patches)
	if sidecar == nil {
		t.Fatal("sidecar not found")
	}
	if sidecar.Resources.Requests == nil {
		t.Error("expected default resource requests")
	}
	if sidecar.Resources.Limits == nil {
		t.Error("expected default resource limits")
	}
}

// TestHandle_SecurityContext: injected sidecar enforces secure defaults.
func TestHandle_SecurityContext(t *testing.T) {
	scheme := testScheme(t)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}
	inj := newInjector(t, scheme, plainNS("default"), enabledAinstr("g", nil))

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	sidecar := sidecarFromPatches(t, resp.Patches)
	if sidecar == nil {
		t.Fatal("sidecar not found")
	}
	sc := sidecar.SecurityContext
	if sc == nil {
		t.Fatal("sidecar has no SecurityContext")
	}
	if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Error("expected AllowPrivilegeEscalation=false")
	}
	if sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem {
		t.Error("expected ReadOnlyRootFilesystem=true")
	}
	if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Error("expected RunAsNonRoot=true")
	}
}

// TestHandle_KubernetesMetadataEnv: downward API env vars are present.
func TestHandle_KubernetesMetadataEnv(t *testing.T) {
	scheme := testScheme(t)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}
	inj := newInjector(t, scheme, plainNS("default"), enabledAinstr("g", nil))

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	sidecar := sidecarFromPatches(t, resp.Patches)
	if sidecar == nil {
		t.Fatal("sidecar not found")
	}

	// Check downward-API vars are wired up (ValueFrom, not plain Value).
	downwardVars := map[string]string{
		"AEP_POD_NAME":  "metadata.name",
		"AEP_NODE_NAME": "spec.nodeName",
		"AEP_POD_UID":   "metadata.uid",
	}
	envByName := make(map[string]corev1.EnvVar)
	for _, e := range sidecar.Env {
		envByName[e.Name] = e
	}
	for varName, fieldPath := range downwardVars {
		e, ok := envByName[varName]
		if !ok {
			t.Errorf("missing env var %s", varName)
			continue
		}
		if e.ValueFrom == nil || e.ValueFrom.FieldRef == nil {
			t.Errorf("%s: expected ValueFrom.FieldRef, got %+v", varName, e.ValueFrom)
			continue
		}
		if e.ValueFrom.FieldRef.FieldPath != fieldPath {
			t.Errorf("%s: fieldPath=%q, want %q", varName, e.ValueFrom.FieldRef.FieldPath, fieldPath)
		}
	}
}

// TestHandle_AlphabeticalConflictResolution: when two ainstr resources cover the
// same namespace, alphabetically-first wins.
func TestHandle_AlphabeticalConflictResolution(t *testing.T) {
	scheme := testScheme(t)
	ainstrA := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "aaa"},
		Spec: aepv1alpha1.AgentInstrumentationSpec{
			Enabled:      true,
			SidecarImage: "image-from-aaa",
		},
	}
	ainstrZ := &aepv1alpha1.AgentInstrumentation{
		ObjectMeta: metav1.ObjectMeta{Name: "zzz"},
		Spec: aepv1alpha1.AgentInstrumentationSpec{
			Enabled:      true,
			SidecarImage: "image-from-zzz",
		},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "p", Namespace: "default",
			Annotations: map[string]string{webhook.InjectAnnotation: "true"},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}
	inj := newInjector(t, scheme, plainNS("default"), ainstrA, ainstrZ)

	resp := inj.Handle(context.Background(), podRequest(t, pod))
	sidecar := sidecarFromPatches(t, resp.Patches)
	if sidecar == nil {
		t.Fatal("sidecar not found")
	}
	if sidecar.Image != "image-from-aaa" {
		t.Errorf("expected alphabetically-first ainstr to win; image=%q, want image-from-aaa",
			sidecar.Image)
	}
}
