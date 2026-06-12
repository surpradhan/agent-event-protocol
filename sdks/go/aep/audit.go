package aep

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"strings"
)

// audit.go — offline verification of tamper-evident audit bundles (Phase 14 add-on).
//
// Mirrors the server's verifyAuditBundle (src/audit.js): recompute the content
// digest from the bundle's events and the HMAC signature from its manifest,
// comparing both constant-time. A compliance reviewer can verify a bundle from
// GET /sessions/:id/audit-bundle (or `aep audit export`) entirely offline using
// only the bundle JSON and the audit signing secret.
//
// Canonical forms are byte-identical to the server: events use the v2 deep
// canonical form (the same canonicalJSON used by v2 per-event signatures) and the
// manifest uses the same deep, recursively key-sorted JSON. Cross-language parity
// is locked by a shared known-answer bundle fixture
// (tests/fixtures/audit/kat-bundle.json) the server + Python/Node SDKs verify too.

var supportedDigestAlgs = map[string]bool{"sha256": true, "sha512": true}

const defaultDigestAlg = "sha256"

// AuditPerEvent is the per-event summary in an AuditVerification.
type AuditPerEvent struct {
	Index            int    `json:"index"`
	ID               string `json:"id"`
	SignaturePresent bool   `json:"signature_present"`
}

// AuditVerification is the result of VerifyAuditBundle.
type AuditVerification struct {
	Valid                  bool            `json:"valid"`
	Errors                 []string        `json:"errors"`
	ContentDigestMatch     bool            `json:"content_digest_match"`
	ManifestSignatureValid bool            `json:"manifest_signature_valid"`
	PerEvent               []AuditPerEvent `json:"per_event"`
}

func auditFail(err string) AuditVerification {
	return AuditVerification{Valid: false, Errors: []string{err}, PerEvent: []AuditPerEvent{}}
}

// VerifyAuditBundleJSON parses raw bundle JSON (numbers preserved exactly via
// json.Number) and verifies it. Convenience over VerifyAuditBundle.
func VerifyAuditBundleJSON(data []byte, secret string) (AuditVerification, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var bundle map[string]any
	if err := dec.Decode(&bundle); err != nil {
		return auditFail("Bundle is not valid JSON"), err
	}
	return VerifyAuditBundle(bundle, secret), nil
}

// VerifyAuditBundle verifies an already-parsed audit bundle offline. Pass the
// bundle as decoded from JSON (a map[string]any). Decoding with json.Number
// (see VerifyAuditBundleJSON) is recommended for exact number canonicalization.
func VerifyAuditBundle(bundle map[string]any, secret string) AuditVerification {
	if bundle == nil {
		return auditFail("Bundle is not an object")
	}
	if secret == "" {
		return auditFail("A non-empty secret is required to verify (set AUDIT_SIGNING_SECRET)")
	}

	manifest, manifestOK := bundle["manifest"].(map[string]any)
	rawEvents, eventsOK := bundle["events"].([]any)
	signature, signatureOK := bundle["signature"].(map[string]any)

	var errs []string
	if !eventsOK {
		errs = append(errs, "Bundle is missing an `events` array")
	}
	if !manifestOK {
		errs = append(errs, "Bundle is missing a `manifest` object")
	}
	if !signatureOK {
		errs = append(errs, "Bundle is missing a `signature` object")
	}

	// --- content digest check ---
	contentDigestMatch := false
	if manifestOK {
		declaredAlg := defaultDigestAlg
		if a, ok := manifest["content_digest_alg"].(string); ok {
			declaredAlg = a
		}
		if !supportedDigestAlgs[declaredAlg] {
			errs = append(errs, fmt.Sprintf("Unsupported content_digest_alg '%s'", declaredAlg))
		} else {
			recomputed := auditContentDigest(rawEvents, declaredAlg)
			cd, _ := manifest["content_digest"].(string)
			contentDigestMatch = cd != "" &&
				subtle.ConstantTimeCompare([]byte(cd), []byte(recomputed)) == 1
			if !contentDigestMatch {
				errs = append(errs, "content_digest does not match the bundled events (events were modified, reordered, added, or dropped)")
			}
		}
		// event_count cross-check.
		if ec, ok := auditAsInt(manifest["event_count"]); !ok {
			errs = append(errs, "manifest.event_count is missing or not a number")
		} else if ec != len(rawEvents) {
			errs = append(errs, fmt.Sprintf("manifest.event_count (%d) does not match the number of bundled events (%d)", ec, len(rawEvents)))
		}
	}

	// --- manifest signature check ---
	manifestSignatureValid := false
	if manifestOK && signatureOK {
		alg, _ := signature["alg"].(string)
		val, valOK := signature["value"].(string)
		if alg != "hmac-sha256" {
			errs = append(errs, fmt.Sprintf("Unsupported signature algorithm '%s' — expected 'hmac-sha256'", alg))
		} else if !valOK {
			errs = append(errs, "signature.value is missing or not a string")
		} else {
			expected := auditManifestSignature(manifest, secret)
			manifestSignatureValid = auditConstantTimeBase64Equal(val, expected)
			if !manifestSignatureValid {
				errs = append(errs, "manifest signature is invalid (manifest was modified or the wrong secret was used)")
			}
		}
	}

	// --- version cross-check (the top-level copy is unsigned) ---
	if manifestOK {
		if topVer, ok := bundle["aep_audit_version"].(string); ok {
			if mVer, _ := manifest["aep_audit_version"].(string); topVer != mVer {
				errs = append(errs, fmt.Sprintf("aep_audit_version mismatch: bundle '%s' vs signed manifest '%s'", topVer, mVer))
			}
		}
	}

	perEvent := make([]AuditPerEvent, len(rawEvents))
	for i, e := range rawEvents {
		pe := AuditPerEvent{Index: i}
		if m, ok := e.(map[string]any); ok {
			// ID is advisory; a non-string id leaves it "" (Go's static type).
			pe.ID, _ = m["id"].(string)
			// Match the server's `typeof e.signature === "object"`: true for a
			// JSON object OR array.
			switch m["signature"].(type) {
			case map[string]any, []any:
				pe.SignaturePresent = true
			}
		}
		perEvent[i] = pe
	}

	if errs == nil {
		errs = []string{}
	}
	return AuditVerification{
		Valid:                  len(errs) == 0 && contentDigestMatch && manifestSignatureValid,
		Errors:                 errs,
		ContentDigestMatch:     contentDigestMatch,
		ManifestSignatureValid: manifestSignatureValid,
		PerEvent:               perEvent,
	}
}

// auditContentDigest hex-encodes the digest over the canonical, newline-joined
// v2 serialization of the ordered events.
func auditContentDigest(events []any, alg string) string {
	var h hash.Hash
	switch alg {
	case "sha512":
		h = sha512.New()
	default:
		h = sha256.New()
	}
	parts := make([]string, len(events))
	for i, e := range events {
		parts[i] = auditCanonicalEvent(e)
	}
	h.Write([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(h.Sum(nil))
}

// auditCanonicalEvent is the v2 canonical form of one event: drop the transport
// `signature` field, then deep-stable serialize (same as canonicalizeV2).
func auditCanonicalEvent(ev any) string {
	m, ok := ev.(map[string]any)
	if !ok {
		return canonicalJSON(ev)
	}
	cp := make(map[string]any, len(m))
	for k, v := range m {
		if k != "signature" {
			cp[k] = v
		}
	}
	return canonicalJSON(cp)
}

func auditManifestSignature(manifest any, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonicalJSON(manifest)))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// auditAsInt coerces a JSON number (float64 or json.Number) to an int. Booleans
// and non-numbers return ok=false.
func auditAsInt(v any) (int, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0, false
		}
		return int(i), true
	case float64:
		return int(n), true
	default:
		return 0, false
	}
}

// auditConstantTimeBase64Equal compares two base64 strings constant-time, never
// panicking on undecodable input.
func auditConstantTimeBase64Equal(a, b string) bool {
	ab, err1 := base64.StdEncoding.DecodeString(a)
	bb, err2 := base64.StdEncoding.DecodeString(b)
	if err1 != nil || err2 != nil || len(ab) != len(bb) {
		return false
	}
	return subtle.ConstantTimeCompare(ab, bb) == 1
}
