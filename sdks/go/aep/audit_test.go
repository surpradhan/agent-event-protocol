package aep

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Shared KAT generated from the server (src/audit.js buildAuditBundle), verified
// identically by the server and the Python/Node SDKs.
const (
	katSecret        = "shared-secret-123"
	katContentDigest = "3de94f67e3ff35fc9b3e31c2e5efc1932f9e950cc6be0813eed571271ad6f6d5"
	katSignature     = "D6IW2aVORoxIZWy+LiWUrZ08QKLkzFo9uTEySZlcWVA="
)

func katBundleBytes(t *testing.T) []byte {
	t.Helper()
	path := filepath.Join("..", "..", "..", "tests", "fixtures", "audit", "kat-bundle.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read KAT fixture %s: %v", path, err)
	}
	return data
}

// katBundleMap parses the fixture into a mutable map (json.Number preserved).
func katBundleMap(t *testing.T) map[string]any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(katBundleBytes(t)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("decode KAT fixture: %v", err)
	}
	return m
}

func TestVerifyAuditBundle_KnownAnswerVerifies(t *testing.T) {
	m := katBundleMap(t)
	manifest := m["manifest"].(map[string]any)
	if got := manifest["content_digest"].(string); got != katContentDigest {
		t.Errorf("KAT content_digest mismatch:\n got  %q\n want %q", got, katContentDigest)
	}
	if got := m["signature"].(map[string]any)["value"].(string); got != katSignature {
		t.Errorf("KAT signature mismatch:\n got  %q\n want %q", got, katSignature)
	}

	res := VerifyAuditBundle(m, katSecret)
	if !res.Valid {
		t.Fatalf("expected valid bundle, got errors: %v", res.Errors)
	}
	if !res.ContentDigestMatch || !res.ManifestSignatureValid {
		t.Errorf("expected both checks true: digest=%v sig=%v", res.ContentDigestMatch, res.ManifestSignatureValid)
	}
	if len(res.PerEvent) != 2 {
		t.Errorf("expected 2 per-event entries, got %d", len(res.PerEvent))
	}
}

func TestVerifyAuditBundleJSON_KnownAnswerVerifies(t *testing.T) {
	res, err := VerifyAuditBundleJSON(katBundleBytes(t), katSecret)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Valid {
		t.Fatalf("expected valid via JSON entrypoint, got errors: %v", res.Errors)
	}
}

func TestVerifyAuditBundle_WrongSecret(t *testing.T) {
	res := VerifyAuditBundle(katBundleMap(t), "not-the-secret")
	if res.Valid {
		t.Error("expected invalid with wrong secret")
	}
	if res.ManifestSignatureValid {
		t.Error("expected manifest signature invalid with wrong secret")
	}
	if !res.ContentDigestMatch {
		t.Error("content digest is secret-independent and should still match")
	}
}

func TestVerifyAuditBundle_PayloadTamperBreaksDigest(t *testing.T) {
	m := katBundleMap(t)
	events := m["events"].([]any)
	payload := events[0].(map[string]any)["payload"].(map[string]any)
	payload["n"] = json.Number("999")
	res := VerifyAuditBundle(m, katSecret)
	if res.Valid || res.ContentDigestMatch {
		t.Error("expected content-digest mismatch after payload tampering")
	}
	if !containsSubstr(res.Errors, "content_digest") {
		t.Errorf("expected a content_digest error, got %v", res.Errors)
	}
}

func TestVerifyAuditBundle_ReorderBreaksDigest(t *testing.T) {
	m := katBundleMap(t)
	events := m["events"].([]any)
	events[0], events[1] = events[1], events[0]
	res := VerifyAuditBundle(m, katSecret)
	if res.Valid || res.ContentDigestMatch {
		t.Error("expected content-digest mismatch after reordering events")
	}
}

func TestVerifyAuditBundle_ManifestTamperBreaksSignature(t *testing.T) {
	m := katBundleMap(t)
	m["manifest"].(map[string]any)["tenant_id"] = "attacker"
	res := VerifyAuditBundle(m, katSecret)
	if res.Valid || res.ManifestSignatureValid {
		t.Error("expected signature invalid after manifest tampering")
	}
}

func TestVerifyAuditBundle_DroppedEventDetected(t *testing.T) {
	m := katBundleMap(t)
	events := m["events"].([]any)
	m["events"] = events[:1]
	res := VerifyAuditBundle(m, katSecret)
	if res.Valid {
		t.Error("expected invalid after dropping an event")
	}
	if !containsSubstr(res.Errors, "event_count") {
		t.Errorf("expected an event_count error, got %v", res.Errors)
	}
}

func TestVerifyAuditBundle_VersionDowngradeFlagged(t *testing.T) {
	m := katBundleMap(t)
	m["aep_audit_version"] = "9.9.9"
	res := VerifyAuditBundle(m, katSecret)
	if res.Valid {
		t.Error("expected invalid on version mismatch")
	}
	if !containsSubstr(res.Errors, "aep_audit_version mismatch") {
		t.Errorf("expected a version-mismatch error, got %v", res.Errors)
	}
}

func TestVerifyAuditBundle_UnsupportedSigAlg(t *testing.T) {
	m := katBundleMap(t)
	m["signature"].(map[string]any)["alg"] = "rsa-sha256"
	res := VerifyAuditBundle(m, katSecret)
	if res.Valid {
		t.Error("expected invalid for unsupported signature algorithm")
	}
	if !containsSubstr(res.Errors, "Unsupported signature algorithm") {
		t.Errorf("expected an unsupported-alg error, got %v", res.Errors)
	}
}

func TestVerifyAuditBundle_ArraySignaturePresentLikeServer(t *testing.T) {
	// per_event.signature_present mirrors the server's typeof==="object", which
	// is true for a JSON array too.
	m := katBundleMap(t)
	m["events"].([]any)[0].(map[string]any)["signature"] = []any{}
	res := VerifyAuditBundle(m, katSecret)
	if !res.PerEvent[0].SignaturePresent {
		t.Error("array-typed signature should report present (server parity)")
	}
}

func TestVerifyAuditBundle_GracefulOnBadInput(t *testing.T) {
	if VerifyAuditBundle(nil, katSecret).Valid {
		t.Error("nil bundle should be invalid")
	}
	if VerifyAuditBundle(katBundleMap(t), "").Valid {
		t.Error("empty secret should be invalid")
	}
}

func containsSubstr(errs []string, sub string) bool {
	for _, e := range errs {
		if strings.Contains(e, sub) {
			return true
		}
	}
	return false
}
