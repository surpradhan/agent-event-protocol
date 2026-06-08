package aep

import (
	"testing"
)

// parityFixture builds the exact event used by the cross-language known-answer
// tests in the Node and Python SDKs, so all three SDKs (and the server) lock to
// the same signature bytes. The payload uses only strings and integers, so
// float-formatting differences do not affect these vectors.
func parityFixture() *Event {
	role := AgentRoleOrchestrator
	return &Event{
		SpecVersion: "0.2.0",
		ID:          "evt_fixedtest0001",
		Time:        "2026-06-05T12:00:00.000Z",
		Source:      "agent://node-parity",
		Type:        EventTypeTaskCreated,
		SessionID:   "ses_parity01",
		TraceID:     "trc_parity0001",
		AgentRole:   &role,
		Payload: map[string]any{
			"framework": "node",
			"nested":    map[string]any{"b": 2, "a": 1},
		},
	}
}

const (
	// Shared cross-language known-answer signature values (secret below).
	paritySecret  = "shared-secret-123"
	knownAnswerV1 = "zPZDN4bGfJF4MJlyWu9HQXpkr5SlaqOAD9JUEj3Sev0="
	knownAnswerV2 = "M3OGzpZ4+SX0MStNZ0wJtb+TV+h/xcy9yPIRC0VaoJQ="
)

// TestKnownAnswerV1 locks the Go v1 (shallow, envelope-only, base64) signature to
// the value produced by the server, Node, and Python SDKs.
func TestKnownAnswerV1(t *testing.T) {
	signed, err := SignEvent(parityFixture(), paritySecret)
	if err != nil {
		t.Fatalf("SignEvent failed: %v", err)
	}
	if signed.Signature.Canon != "" {
		t.Errorf("v1 must not set a canon marker, got %q", signed.Signature.Canon)
	}
	if signed.Signature.Value != knownAnswerV1 {
		t.Errorf("v1 KAT mismatch:\n got  %q\n want %q", signed.Signature.Value, knownAnswerV1)
	}
}

// TestKnownAnswerV2 locks the Go v2 (deep, payload-covering, base64) signature to
// the value produced by the server, Node, and Python SDKs — true cross-language
// parity.
func TestKnownAnswerV2(t *testing.T) {
	signed, err := SignEventV2(parityFixture(), paritySecret)
	if err != nil {
		t.Fatalf("SignEventV2 failed: %v", err)
	}
	if signed.Signature.Canon != "v2" {
		t.Errorf("v2 must set canon=\"v2\", got %q", signed.Signature.Canon)
	}
	if signed.Signature.Value != knownAnswerV2 {
		t.Errorf("v2 KAT mismatch:\n got  %q\n want %q", signed.Signature.Value, knownAnswerV2)
	}
}

// TestV2RoundTrip confirms a v2-signed event verifies under the version-aware
// verifier.
func TestV2RoundTrip(t *testing.T) {
	signed, _ := SignEventV2(parityFixture(), paritySecret)
	valid, err := VerifySignature(signed, paritySecret)
	if err != nil {
		t.Fatalf("VerifySignature failed: %v", err)
	}
	if !valid {
		t.Error("expected v2-signed event to verify")
	}
}

// TestV2DetectsPayloadTampering is the whole point of v2: nested payload changes
// invalidate the signature.
func TestV2DetectsPayloadTampering(t *testing.T) {
	signed, _ := SignEventV2(parityFixture(), paritySecret)

	// Mutate a nested payload value.
	signed.Payload = map[string]any{
		"framework": "node",
		"nested":    map[string]any{"b": 2, "a": 999},
	}

	valid, err := VerifySignature(signed, paritySecret)
	if err != nil {
		t.Fatalf("VerifySignature failed: %v", err)
	}
	if valid {
		t.Error("expected v2 signature to be invalid after nested-payload tampering")
	}
}

// TestVersionHonoured: a deep signature mislabelled as canon="v1" must be
// rejected — the verifier checks the shallow form only and the bytes won't match.
func TestVersionHonoured(t *testing.T) {
	signed, _ := SignEventV2(parityFixture(), paritySecret)
	// Lie about the version: the value is the deep digest, but claim v1.
	signed.Signature.Canon = "v1"

	valid, err := VerifySignature(signed, paritySecret)
	if err != nil {
		t.Fatalf("VerifySignature failed: %v", err)
	}
	if valid {
		t.Error("expected reject: v2 digest declared as canon=\"v1\"")
	}
}

// TestTransitionModeAcceptsUnmarkedDeep: an unmarked (canon absent) deep
// signature must verify under transition mode — this is the latent Go-SDK interop
// path from issue #59 (deep digest, no marker), now accepted by base64.
func TestTransitionModeAcceptsUnmarkedDeep(t *testing.T) {
	signed, _ := SignEventV2(parityFixture(), paritySecret)
	// Strip the marker → transition mode (accept either form).
	signed.Signature.Canon = ""

	valid, err := VerifySignature(signed, paritySecret)
	if err != nil {
		t.Fatalf("VerifySignature failed: %v", err)
	}
	if !valid {
		t.Error("expected transition mode to accept an unmarked deep signature")
	}
}

// TestTransitionModeAcceptsV1: an unmarked shallow (v1) signature also verifies
// under transition mode.
func TestTransitionModeAcceptsV1(t *testing.T) {
	signed, _ := SignEvent(parityFixture(), paritySecret) // v1, no marker
	valid, err := VerifySignature(signed, paritySecret)
	if err != nil {
		t.Fatalf("VerifySignature failed: %v", err)
	}
	if !valid {
		t.Error("expected transition mode to accept an unmarked v1 signature")
	}
}

// TestUnknownCanonRejectedOnVerify: a non-"v1"/"v2" marker is rejected with an
// error and never panics.
func TestUnknownCanonRejectedOnVerify(t *testing.T) {
	signed, _ := SignEventV2(parityFixture(), paritySecret)
	signed.Signature.Canon = "v3"

	valid, err := VerifySignature(signed, paritySecret)
	if err == nil {
		t.Error("expected an error for unknown canon")
	}
	if valid {
		t.Error("expected invalid for unknown canon")
	}
	if _, ok := err.(*ErrValidation); !ok {
		t.Errorf("expected ErrValidation, got %T", err)
	}
}

// TestUnknownCanonRejectedOnSign: signing with an unsupported canon errors.
func TestUnknownCanonRejectedOnSign(t *testing.T) {
	_, err := SignEventWithCanon(parityFixture(), paritySecret, "v3")
	if err == nil {
		t.Fatal("expected an error signing with unsupported canon")
	}
	if _, ok := err.(*ErrValidation); !ok {
		t.Errorf("expected ErrValidation, got %T", err)
	}
}

// TestBadBase64NeverPanics: a malformed signature value is a plain mismatch, not
// a panic or error.
func TestBadBase64NeverPanics(t *testing.T) {
	signed, _ := SignEventV2(parityFixture(), paritySecret)
	signed.Signature.Value = "!!!not-base64!!!"

	valid, err := VerifySignature(signed, paritySecret)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if valid {
		t.Error("expected invalid for a non-base64 signature value")
	}
}

// specialCharFixture builds an event whose envelope (subject) and payload contain
// the characters that diverge between Go's encoding/json and ECMAScript
// JSON.stringify / Python json.dumps(ensure_ascii=False): the HTML-significant
// <, >, & (Go escapes by default), U+2028/U+2029 line/paragraph separators (Go
// escapes even with SetEscapeHTML(false)), the named control escapes, a generic
// control char, and an astral (surrogate-pair) emoji. All special chars use Go
// escape sequences so the bytes exactly match the JS fixture the vectors below
// were derived from.
func specialCharFixture() *Event {
	subj := "a<b>&c d e"
	return &Event{
		SpecVersion: "0.2.0",
		ID:          "evt_special01",
		Time:        "2026-06-05T12:00:00.000Z",
		Source:      "agent://x",
		Type:        EventTypeTaskCreated,
		SessionID:   "ses_s",
		TraceID:     "trc_s",
		Subject:     &subj,
		Payload: map[string]any{
			"html": "1<2 && 3>2",
			"k&v":  "x",
			"sep":  "p q r",
			"ctrl": "tab\tnl\nx\b\fy",
			"uni":  "λ→\U0001f600", // λ → 😀
		},
	}
}

const (
	// Server-derived cross-language vectors for specialCharFixture (secret above).
	// v1 covers the envelope (incl. the special-char subject); v2 also covers the
	// special-char payload. These pin byte parity with the server/Node/Python for
	// <, >, &, U+2028/U+2029, control chars, and astral codepoints.
	specialKnownAnswerV1 = "L3fdoku4FOb5tR5Hr/3U5Vmmk/7UZlf67mW83999DOI="
	specialKnownAnswerV2 = "tVtj/rav+ocjUpP6SssCMc9k0phC0FUd62YJZFiSizc="
)

// TestKnownAnswerSpecialCharsV1 locks Go's v1 signature for an event with
// HTML-significant and separator characters in the envelope to the server value.
// Guards against encoding/json HTML-escaping <, >, & (issue #59 review finding).
func TestKnownAnswerSpecialCharsV1(t *testing.T) {
	signed, err := SignEvent(specialCharFixture(), paritySecret)
	if err != nil {
		t.Fatalf("SignEvent failed: %v", err)
	}
	if signed.Signature.Value != specialKnownAnswerV1 {
		t.Errorf("special-char v1 KAT mismatch:\n got  %q\n want %q", signed.Signature.Value, specialKnownAnswerV1)
	}
}

// TestKnownAnswerSpecialCharsV2 locks Go's v2 signature for an event with special
// characters in BOTH the envelope and the payload to the server value — the full
// byte-parity guard for the custom ECMAScript string encoder.
func TestKnownAnswerSpecialCharsV2(t *testing.T) {
	signed, err := SignEventV2(specialCharFixture(), paritySecret)
	if err != nil {
		t.Fatalf("SignEventV2 failed: %v", err)
	}
	if signed.Signature.Value != specialKnownAnswerV2 {
		t.Errorf("special-char v2 KAT mismatch:\n got  %q\n want %q", signed.Signature.Value, specialKnownAnswerV2)
	}
}

// TestEcmaQuote checks the custom string encoder against ECMAScript
// JSON.stringify output for the characters that differ from encoding/json.
func TestEcmaQuote(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"a<b>&c", `"a<b>&c"`},                             // <, >, & emitted raw (not < etc.)
		{"1<2 && 3>2", `"1<2 && 3>2"`},                     //
		{"p q r", "\"p q r\""},                             // U+2028/U+2029 emitted raw
		{"a\"b\\c", `"a\"b\\c"`},                           // quote + backslash escaped
		{"tab\tnl\n", `"tab\tnl\n"`},                       // named control escapes
		{"x\bz\f", `"x\bz\f"`},                             //
		{string([]rune{0x01, 0x1f}), "\"\\u0001\\u001f\""}, // other control chars -> lowercase \u00xx
		{"λ→\U0001f600", "\"λ→\U0001f600\""},               // printable/astral raw
	}
	for _, c := range cases {
		if got := ecmaQuote(c.in); got != c.want {
			t.Errorf("ecmaQuote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestECMANumberFormatting documents the v2 cross-language number-formatting
// contract: Go's ecmaFormatFloat must match ECMAScript Number::toString /
// JSON.stringify for the values exercised here, so deep canonical bytes agree
// with the Node/server v2 form. If any case below diverges, v2 byte-parity is
// broken for events carrying that value — fix the formatter, do not silently
// loosen the test.
func TestECMANumberFormatting(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{2, "2"},
		{100, "100"},
		{-0.5, "-0.5"},
		{0.1, "0.1"},
		{98.6, "98.6"},
		{3.14, "3.14"},
		{123456.789, "123456.789"},
		{1e-7, "1e-7"},
		{0.0000001, "1e-7"},
		{1e-6, "0.000001"},
		{1.5e-10, "1.5e-10"},
		{1.23e-8, "1.23e-8"},
		{1e21, "1e+21"},
		{1e22, "1e+22"},
		{1e20, "100000000000000000000"},
		{5e-324, "5e-324"},
		{1.7976931348623157e308, "1.7976931348623157e+308"},
	}
	for _, c := range cases {
		got := ecmaFormatFloat(c.in)
		if got != c.want {
			t.Errorf("ecmaFormatFloat(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
