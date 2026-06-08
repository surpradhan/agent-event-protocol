"""Unit tests for aep._signature.sign_event() and _canonicalize()."""

import base64
import hashlib
import hmac
import json

import pytest

from aep._signature import _canonicalize, canonicalize_v2, sign_event, verify_signature


# ── helpers ────────────────────────────────────────────────────────────────────

def _minimal_event(**overrides):
    base = {
        "specversion": "0.2.0",
        "id": "evt_abc123",
        "time": "2026-01-01T00:00:00.000Z",
        "source": "agent://test",
        "type": "task.created",
        "session_id": "ses_001",
        "trace_id": "trc_001",
        "payload": {"msg": "hello"},
    }
    base.update(overrides)
    return base


def _expected_hmac(canonical: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


# ── canonicalize ───────────────────────────────────────────────────────────────

def test_canonicalize_is_valid_json():
    event = _minimal_event()
    canon = _canonicalize(event)
    parsed = json.loads(canon)
    assert isinstance(parsed, dict)


def test_canonicalize_excludes_signature():
    event = _minimal_event(signature={"alg": "hmac-sha256", "value": "xyz"})
    canon = _canonicalize(event)
    parsed = json.loads(canon)
    assert "signature" not in parsed


def test_canonicalize_top_level_keys_sorted():
    event = _minimal_event()
    canon = _canonicalize(event)
    parsed = json.loads(canon)
    keys = list(parsed.keys())
    assert keys == sorted(keys), "Top-level keys must be sorted alphabetically"


def test_canonicalize_no_whitespace():
    event = _minimal_event()
    canon = _canonicalize(event)
    assert " " not in canon


def test_canonicalize_deterministic():
    event = _minimal_event()
    # Python dicts are ordered but let's verify regardless
    assert _canonicalize(event) == _canonicalize(event)


def test_canonicalize_nested_filtered():
    # Nested keys that don't appear in top-level sorted_keys are excluded
    # This mirrors JSON.stringify(copy, sortedKeys) in Node.js
    event = _minimal_event(payload={"msg": "hello", "nested_only_key": "should_be_excluded"})
    canon = _canonicalize(event)
    parsed = json.loads(canon)
    # "nested_only_key" is not a top-level event key → filtered out from payload
    assert "nested_only_key" not in parsed.get("payload", {})
    # "msg" is also not a top-level key → filtered too
    assert "msg" not in parsed.get("payload", {})


# ── sign_event ─────────────────────────────────────────────────────────────────

def test_sign_event_adds_signature():
    event = _minimal_event()
    result = sign_event(event, "test-secret")
    assert "signature" in result
    assert result["signature"]["alg"] == "hmac-sha256"
    assert isinstance(result["signature"]["value"], str)


def test_sign_event_returns_event():
    event = _minimal_event()
    returned = sign_event(event, "secret")
    assert returned is event  # mutates and returns same object


def test_sign_event_value_is_base64():
    event = _minimal_event()
    sign_event(event, "secret")
    # Should not raise
    decoded = base64.b64decode(event["signature"]["value"])
    assert len(decoded) == 32  # SHA-256 produces 32 bytes


def test_sign_event_correct_hmac():
    event = _minimal_event()
    secret = "my-signing-secret"
    # Compute expected: sign a fresh copy without signature
    expected_canon = _canonicalize(event)
    expected_value = _expected_hmac(expected_canon, secret)

    sign_event(event, secret)
    assert event["signature"]["value"] == expected_value


def test_different_secrets_produce_different_signatures():
    e1 = _minimal_event()
    e2 = _minimal_event()
    sign_event(e1, "secret-a")
    sign_event(e2, "secret-b")
    assert e1["signature"]["value"] != e2["signature"]["value"]


def test_different_events_produce_different_signatures():
    e1 = _minimal_event(id="evt_aaa")
    e2 = _minimal_event(id="evt_bbb")
    sign_event(e1, "shared-secret")
    sign_event(e2, "shared-secret")
    assert e1["signature"]["value"] != e2["signature"]["value"]


def test_sign_event_does_not_include_prior_signature_in_canonical():
    event = _minimal_event()
    secret = "secret"

    # Sign once
    sign_event(event, secret)
    first_sig = event["signature"]["value"]

    # Re-sign with same secret — the pre-existing signature must be excluded
    # from the canonical form so the result must be the same
    sign_event(event, secret)
    assert event["signature"]["value"] == first_sig


# ── verify_signature ───────────────────────────────────────────────────────────

def test_verify_valid_signature():
    event = _minimal_event()
    sign_event(event, "secret")
    result = verify_signature(event, "secret")
    assert result["valid"] is True
    assert "error" not in result


def test_verify_wrong_secret():
    event = _minimal_event()
    sign_event(event, "correct-secret")
    result = verify_signature(event, "wrong-secret")
    assert result["valid"] is False
    assert "mismatch" in result["error"].lower()


def test_verify_tampered_payload():
    event = _minimal_event()
    sign_event(event, "secret")
    event["type"] = "task.failed"  # tamper after signing
    result = verify_signature(event, "secret")
    assert result["valid"] is False


def test_verify_missing_signature():
    event = _minimal_event()  # no signature field
    result = verify_signature(event, "secret")
    assert result["valid"] is False
    assert "missing" in result["error"].lower()


def test_verify_wrong_algorithm():
    event = _minimal_event()
    event["signature"] = {"alg": "rsa-sha256", "value": "abc"}
    result = verify_signature(event, "secret")
    assert result["valid"] is False
    assert "algorithm" in result["error"].lower() or "rsa-sha256" in result["error"]


def test_verify_invalid_base64_value():
    event = _minimal_event()
    event["signature"] = {"alg": "hmac-sha256", "value": "!!!not-base64!!!"}
    result = verify_signature(event, "secret")
    assert result["valid"] is False


def test_verify_missing_signature_value():
    event = _minimal_event()
    event["signature"] = {"alg": "hmac-sha256"}  # no value
    result = verify_signature(event, "secret")
    assert result["valid"] is False


def test_verify_timing_safe_never_raises():
    """verify_signature must never raise — all bad inputs return valid=False."""
    bad_inputs = [
        {},
        {"signature": None},
        {"signature": "not-a-dict"},
        {"signature": {"alg": "hmac-sha256", "value": ""}},
        "not-a-dict",   # non-dict event
        None,           # None event
        42,             # int
    ]
    for event in bad_inputs:
        result = verify_signature(event, "secret")  # type: ignore[arg-type]
        assert result["valid"] is False, f"Expected valid=False for {event!r}"


def test_sign_then_verify_roundtrip():
    """Full round-trip: sign with Python, verify with Python."""
    event = _minimal_event()
    sign_event(event, "roundtrip-secret")
    result = verify_signature(event, "roundtrip-secret")
    assert result["valid"] is True


# ── v2 (deep) canonicalization — issue #59 ───────────────────────────────────────

# The SAME fixed event + secret used by the Node SDK's v2 parity test, and the
# v2 known-answer produced by the SERVER reference impl (src/_canonical.js
# canonicalizeV2 + HMAC). Locks Python's v2 form byte-identically to the server
# and the Node SDK — true cross-language v2 parity.
#
# NB: the field values below (e.g. payload.framework == "node", the source/ids)
# are deliberately IDENTICAL to the Node SDK fixture — they are part of the
# signed bytes that produce _V2_REFERENCE_SIGNATURE, so this Python test and the
# Node test sign the exact same event. Do NOT "fix" the "node" naming: changing
# any value here would change the canonical bytes and invalidate the shared
# cross-language known-answer vector.
_V2_SECRET = "shared-secret-123"
_V2_FIXED_EVENT = {
    "specversion": "0.2.0",
    "id": "evt_fixedtest0001",
    "time": "2026-06-05T12:00:00.000Z",
    "source": "agent://node-parity",
    "type": "task.created",
    "session_id": "ses_parity01",
    "trace_id": "trc_parity0001",
    "payload": {"framework": "node", "nested": {"b": 2, "a": 1}},
    "agent_role": "orchestrator",
}
_V2_REFERENCE_SIGNATURE = "M3OGzpZ4+SX0MStNZ0wJtb+TV+h/xcy9yPIRC0VaoJQ="


def test_v1_remains_the_default():
    event = _minimal_event()
    sign_event(event, "secret")
    assert "canon" not in event["signature"]  # no marker on the default path


def test_sign_event_rejects_unsupported_canon():
    # A typo like "V2" must fail loudly instead of silently signing unmarked v1.
    for bad in ("V2", "v3", "", "deep"):
        with pytest.raises(ValueError, match="Unsupported canon"):
            sign_event(_minimal_event(), "secret", canon=bad)  # type: ignore[arg-type]


def test_v2_signs_byte_identically_to_server_reference():
    event = dict(_V2_FIXED_EVENT)
    sign_event(event, _V2_SECRET, canon="v2")
    assert event["signature"]["alg"] == "hmac-sha256"
    assert event["signature"]["canon"] == "v2"
    assert event["signature"]["value"] == _V2_REFERENCE_SIGNATURE


def test_v2_canonical_includes_deep_sorted_payload():
    canon = canonicalize_v2(dict(_V2_FIXED_EVENT))
    assert '"payload":{"framework":"node","nested":{"a":1,"b":2}}' in canon
    assert '"signature"' not in canon


def test_v2_detects_nested_payload_tampering():
    event = dict(_V2_FIXED_EVENT)
    sign_event(event, _V2_SECRET, canon="v2")
    assert verify_signature(event, _V2_SECRET)["valid"] is True
    # mutate a NESTED payload value — v1 would miss this; v2 must catch it.
    event["payload"] = {"framework": "node", "nested": {"b": 2, "a": 999}}
    assert verify_signature(event, _V2_SECRET)["valid"] is False


def test_v2_signed_with_v1_marker_does_not_verify():
    event = dict(_V2_FIXED_EVENT)
    sign_event(event, _V2_SECRET, canon="v2")
    event["signature"]["canon"] = "v1"  # mislabel → server checks shallow only
    assert verify_signature(event, _V2_SECRET)["valid"] is False


def test_unmarked_deep_signature_verifies_transition_mode():
    event = dict(_V2_FIXED_EVENT)
    sign_event(event, _V2_SECRET, canon="v2")
    del event["signature"]["canon"]  # simulate an unmarked deep emitter (Go-style)
    assert verify_signature(event, _V2_SECRET)["valid"] is True


def test_unknown_canon_rejected():
    event = dict(_V2_FIXED_EVENT)
    sign_event(event, _V2_SECRET, canon="v2")
    event["signature"]["canon"] = "v9"
    result = verify_signature(event, _V2_SECRET)
    assert result["valid"] is False
    assert "canonicalization" in result["error"].lower()


def test_non_string_canon_rejected_never_raises():
    # A non-string / unsupported marker must be rejected cleanly (no raise). Note
    # ``None`` is NOT here: absent/None means "no marker" → transition mode.
    for bad in (123, [], {}, ""):
        event = dict(_V2_FIXED_EVENT)
        sign_event(event, _V2_SECRET, canon="v2")
        event["signature"]["canon"] = bad
        result = verify_signature(event, _V2_SECRET)
        assert result["valid"] is False, f"canon={bad!r} should be invalid"
