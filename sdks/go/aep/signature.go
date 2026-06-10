package aep

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
)

// HMAC-SHA256 event signing + verification.
//
// Two canonicalization versions are supported (issue #59):
//
//   - v2 (deep, default) — canonicalFormV2: drop `signature`, then recursively
//     key-sort the WHOLE event (envelope AND nested payloads) before HMAC, so the
//     signature covers payload contents. This is the same deep rule the server
//     verifier (src/_canonical.js) and the Phase 14 audit bundle use. v2
//     signatures carry a `signature.canon: "v2"` marker. This is now the default
//     (issue #59 default flip) so payload tamper-evidence is on without opt-in.
//
//   - v1 (legacy) — canonicalForm: shallow, envelope-only. Drop the
//     `signature` field, sort the top-level keys, and serialize keeping ONLY the
//     top-level key names at every nesting level (replicating ECMAScript's
//     `JSON.stringify(copy, sortedKeys)` array-replacer behaviour). Nested
//     objects are therefore emptied (a `payload` serializes as `{}`). It covers
//     the envelope but NOT nested payloads. Byte-identical to the server, Node,
//     and Python SDK v1 forms — locked by a cross-language known-answer test.
//     Select it explicitly with SignEventV1.
//
// In BOTH versions the digest is base64-encoded (matching the server/Node/Python
// SDKs).
//
// History / behaviour change (issue #59): earlier Go SDK releases signed a
// *deep* canonical form and HEX-encoded the value — a form that matched neither
// the shared v1 (shallow) nor v2, and whose hex value never verified on the
// server (everyone else uses base64). That output was therefore non-interoperable
// in practice. A prior release aligned Go's v1 to the shared shallow+base64 form
// so Go finally interoperates on v1, and added an opt-in v2.
//
// Default flip (issue #59): SignEvent now defaults to v2 (deep, payload-covering,
// base64) so payload tamper-evidence is on without opt-in. Use SignEventV1 to
// sign the legacy envelope-only form (e.g. to talk to a server that predates
// version-aware verification). VerifySignature is version-aware and
// backward-compatible: it honours the `signature.canon` marker and treats an
// absent marker as transition mode (accept either form), matching the server.
//
// Compatibility: a v2-default emitter requires a v2-aware server (server PR #60+).
// The current server requires v2 and rejects legacy v1 with 401 (issue #65, v1
// retirement complete). SignEventV1 is retained only for talking to an older
// self-hosted server that predates signature.canon support.

// supportedCanon is the set of canonicalization version markers this SDK accepts.
var supportedCanon = map[string]bool{"v1": true, "v2": true}

// SignEvent signs an event with HMAC-SHA256 using the provided secret and the
// default (v2, deep, payload-covering, base64) canonical form. It records a
// `signature.canon: "v2"` marker. Returns the event with the Signature field
// populated.
//
// For the legacy envelope-only form, use SignEventV1.
func SignEvent(event *Event, secret string) (*Event, error) {
	return SignEventWithCanon(event, secret, "v2")
}

// SignEventV1 signs an event with the legacy v1 (shallow, envelope-only, base64)
// canonical form. It does NOT cover nested payload contents and carries no canon
// marker. Prefer SignEvent (v2) unless you must interoperate with a server that
// predates version-aware verification.
func SignEventV1(event *Event, secret string) (*Event, error) {
	return SignEventWithCanon(event, secret, "v1")
}

// SignEventV2 signs an event with the v2 (deep) canonical form, so the signature
// covers nested payload contents. It records a `signature.canon: "v2"` marker.
// Equivalent to the default SignEvent; kept as an explicit alias.
func SignEventV2(event *Event, secret string) (*Event, error) {
	return SignEventWithCanon(event, secret, "v2")
}

// SignEventWithCanon signs an event using the named canonicalization version
// ("v1" or "v2") and HMAC-SHA256, base64-encoding the digest. The "v2" form adds
// a `signature.canon` marker; "v1" (the legacy form) does not.
//
// Returns an ErrValidation if the event is nil, the secret is empty, or canon is
// not "v1"/"v2".
func SignEventWithCanon(event *Event, secret, canon string) (*Event, error) {
	if event == nil {
		return nil, NewValidationError("event cannot be nil", nil)
	}
	if secret == "" {
		return nil, NewValidationError("secret cannot be empty", nil)
	}
	if !supportedCanon[canon] {
		return nil, NewValidationError("unsupported canon "+strconv.Quote(canon)+" — expected \"v1\" or \"v2\"", nil)
	}

	canonical, err := canonicalFor(event, canon)
	if err != nil {
		return nil, NewValidationError("failed to create canonical form", err)
	}

	sig := hmac.New(sha256.New, []byte(secret))
	sig.Write([]byte(canonical))
	value := base64.StdEncoding.EncodeToString(sig.Sum(nil))

	event.Signature = &Signature{Alg: "hmac-sha256", Value: value}
	if canon == "v2" {
		event.Signature.Canon = "v2"
	}

	return event, nil
}

// VerifySignature verifies an event's HMAC-SHA256 signature using the provided
// secret. Returns true if the signature is valid, false otherwise.
//
// Version-aware (issue #59): honours `signature.canon` — "v2" verifies against
// the deep form only, "v1" against the shallow form only, and an ABSENT marker is
// transition mode (accepted if it matches EITHER form, so legacy shallow emitters
// and unmarked deep ones both keep working). Mirrors verifySignature() in
// src/signature.js. Uses a constant-time compare (hmac.Equal) and never panics.
//
// Returns an ErrValidation only for structural problems (nil event, missing
// signature, unsupported algorithm/canon, empty secret); a well-formed event
// whose signature simply does not match returns (false, nil).
func VerifySignature(event *Event, secret string) (bool, error) {
	if event == nil {
		return false, NewValidationError("cannot verify signature: event is nil", nil)
	}
	if event.Signature == nil {
		return false, NewValidationError("cannot verify signature: event has no signature field (unsigned events cannot be verified)", nil)
	}
	if event.Signature.Alg != "hmac-sha256" {
		return false, NewValidationError("unsupported signature algorithm", nil)
	}
	if event.Signature.Value == "" {
		return false, NewValidationError("signature.value is missing", nil)
	}
	if secret == "" {
		return false, NewValidationError("secret cannot be empty", nil)
	}

	canon := event.Signature.Canon
	if canon != "" && !supportedCanon[canon] {
		return false, NewValidationError("unsupported signature canonicalization "+strconv.Quote(canon)+" — expected \"v1\" or \"v2\"", nil)
	}

	providedDigest, err := base64.StdEncoding.DecodeString(event.Signature.Value)
	if err != nil {
		// A non-base64 value cannot match a base64 expected digest. Treat as a
		// plain mismatch rather than an error (mirrors the server/Python SDK).
		return false, nil
	}

	// Absent marker → transition mode: accept either form.
	var forms []string
	switch canon {
	case "v2":
		forms = []string{"v2"}
	case "v1":
		forms = []string{"v1"}
	default:
		forms = []string{"v1", "v2"}
	}

	for _, form := range forms {
		canonical, err := canonicalFor(event, form)
		if err != nil {
			return false, NewValidationError("failed to create canonical form", err)
		}
		sig := hmac.New(sha256.New, []byte(secret))
		sig.Write([]byte(canonical))
		expectedDigest := sig.Sum(nil)
		if hmac.Equal(providedDigest, expectedDigest) {
			return true, nil
		}
	}

	return false, nil
}

// canonicalFor dispatches to the v1 or v2 canonical form.
func canonicalFor(event *Event, canon string) (string, error) {
	if canon == "v2" {
		return canonicalFormV2(event)
	}
	return canonicalForm(event)
}

// eventToMap serializes the event to JSON (so omitempty/field tags apply) with
// the signature field removed, then decodes it back to a generic map for
// canonicalization. Using json.Number preserves integer/float distinctions in
// the source bytes rather than coercing everything to float64.
func eventToMap(event *Event) (map[string]any, error) {
	eventCopy := *event
	eventCopy.Signature = nil

	data, err := json.Marshal(eventCopy)
	if err != nil {
		return nil, err
	}

	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

// canonicalForm produces the **v1** canonical JSON string: envelope-only, with
// nested object contents dropped. It replicates ECMAScript's
// `JSON.stringify(copy, sortedKeys)` array-replacer behaviour, where the sorted
// TOP-LEVEL key names act as a whitelist applied at every nesting level (so a
// `payload` object serializes as `{}`). Kept byte-identical for cross-SDK parity.
func canonicalForm(event *Event) (string, error) {
	m, err := eventToMap(event)
	if err != nil {
		return "", err
	}

	keySet := make(map[string]bool, len(m))
	for k := range m {
		keySet[k] = true
	}
	return canonicalJSONFiltered(m, keySet), nil
}

// canonicalFormV2 produces the **v2** (deep) canonical JSON string covering the
// whole event including nested payloads, byte-identical to the server's
// canonicalizeV2 (src/_canonical.js) for JSON values shared across runtimes.
func canonicalFormV2(event *Event) (string, error) {
	m, err := eventToMap(event)
	if err != nil {
		return "", err
	}
	return canonicalJSON(m), nil
}

// canonicalJSON recursively serializes a value with object keys sorted at every
// level and no whitespace (the v2 deep form).
func canonicalJSON(v any) string {
	return canonicalValue(v, nil)
}

// canonicalJSONFiltered serializes like canonicalJSON but, at every object level,
// keeps only keys present in keySet (the v1 array-replacer behaviour). A nil
// keySet means "keep everything" (the v2 form).
func canonicalJSONFiltered(v any, keySet map[string]bool) string {
	return canonicalValue(v, keySet)
}

// canonicalValue is the shared recursive serializer. If keySet is non-nil it acts
// as a key whitelist applied at every object level (v1); if nil, all keys are
// kept (v2). Object keys are emitted in sorted order in both cases.
func canonicalValue(v any, keySet map[string]bool) string {
	switch val := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(val))
		for k := range val {
			if keySet == nil || keySet[k] {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)

		var parts []string
		for _, k := range keys {
			parts = append(parts, ecmaQuote(k)+":"+canonicalValue(val[k], keySet))
		}
		return "{" + strings.Join(parts, ",") + "}"

	case []any:
		parts := make([]string, 0, len(val))
		for _, item := range val {
			parts = append(parts, canonicalValue(item, keySet))
		}
		return "[" + strings.Join(parts, ",") + "]"

	case string:
		return ecmaQuote(val)

	case json.Number:
		return canonicalNumber(string(val))

	case float64:
		return ecmaFormatFloat(val)

	case bool:
		if val {
			return "true"
		}
		return "false"

	case nil:
		return "null"

	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

const hexDigits = "0123456789abcdef"

// ecmaQuote serializes a Go string as a JSON string literal byte-for-byte
// identical to ECMAScript `JSON.stringify` (and Python `json.dumps` with
// `ensure_ascii=False`): only `"`, `\`, the named control escapes (`\b \f \n \r
// \t`), and other control characters (< U+0020, as lowercase `\u00xx`) are
// escaped. Everything else — including `<`, `>`, `&`, U+2028, U+2029, and all
// printable/astral Unicode — is emitted raw as UTF-8.
//
// This deliberately replaces `encoding/json`'s Marshal for canonical strings and
// object keys: Go's encoder HTML-escapes `<`, `>`, `&` by default AND escapes
// U+2028/U+2029 even with `SetEscapeHTML(false)`, both of which break
// cross-runtime canonical byte parity with the server/Node/Python (issue #59).
//
// Edge case: lone surrogates / invalid UTF-8 are emitted as raw U+FFFD (Go's
// `for range` substitution) rather than `\udXXX` escapes like JS — unreachable in
// practice, since events reaching the verifier have round-tripped through JSON
// parsing and so cannot carry a lone surrogate.
func ecmaQuote(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[(r>>4)&0xf])
				b.WriteByte(hexDigits[r&0xf])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// canonicalNumber renders a json.Number using ECMAScript Number-to-string
// semantics, so the canonical bytes match JSON.stringify across runtimes.
func canonicalNumber(s string) string {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		// Should not happen for JSON-sourced numbers; fall back to the literal.
		return s
	}
	return ecmaFormatFloat(f)
}

// ecmaFormatFloat renders a float64 exactly as ECMAScript's Number::toString
// (and thus JSON.stringify) would, so canonical bytes match the Node/server v2
// form. It implements the ECMA-262 Number-to-string algorithm on top of Go's
// shortest round-trippable formatting.
//
// NaN/±Inf cannot appear in JSON-parsed events (JSON.stringify renders them as
// null); we mirror that with "null" for completeness.
func ecmaFormatFloat(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		// JSON.stringify(-0) === "0"
		return "0"
	}

	neg := math.Signbit(f)
	if neg {
		f = -f
	}

	// Shortest round-trippable scientific form, e.g. "1.23456e+02" or "1e-07".
	es := strconv.FormatFloat(f, 'e', -1, 64)

	mantStr := es
	exp := 0
	if i := strings.IndexByte(es, 'e'); i >= 0 {
		mantStr = es[:i]
		exp, _ = strconv.Atoi(es[i+1:])
	}
	// Significant digits = mantissa without the decimal point.
	digits := strings.Replace(mantStr, ".", "", 1)
	k := len(digits) // number of significant digits
	n := exp + 1     // ECMA's decimal point position: value = digits * 10^(n-k)

	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}

	switch {
	case n >= k && n <= 21:
		// Integer with trailing zeros, no decimal point.
		b.WriteString(digits)
		b.WriteString(strings.Repeat("0", n-k))
	case 0 < n && n <= 21:
		// Decimal point falls inside the digit string.
		b.WriteString(digits[:n])
		b.WriteByte('.')
		b.WriteString(digits[n:])
	case -6 < n && n <= 0:
		// 0.00…digits
		b.WriteString("0.")
		b.WriteString(strings.Repeat("0", -n))
		b.WriteString(digits)
	default:
		// Exponential form.
		b.WriteByte(digits[0])
		if k > 1 {
			b.WriteByte('.')
			b.WriteString(digits[1:])
		}
		b.WriteByte('e')
		e := n - 1
		if e >= 0 {
			b.WriteByte('+')
		} else {
			b.WriteByte('-')
			e = -e
		}
		b.WriteString(strconv.Itoa(e))
	}

	return b.String()
}
