from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any, Literal

# Canonicalization versions understood by this module (issue #59).
#
# • v2 (deep, default) — canonicalize_v2: a deep, recursively key-sorted form
#   covering the whole event including nested payloads, byte-identical to the
#   server's ``canonicalizeV2`` (src/_canonical.js). v2 signatures carry a
#   ``signature.canon: "v2"`` marker. This is now the DEFAULT so payload
#   tamper-evidence is on without opt-in.
# • v1 (legacy) — _canonicalize: shallow, envelope-only. The array-replacer-style
#   rule drops nested object contents (``payload`` → ``{}``). Identical across the
#   Node, Python, Go SDKs and the server; covers the envelope but NOT nested
#   payloads. Select it explicitly with ``canon="v1"``.
#
# ``sign_event`` defaults to v2 (issue #59 default flip); pass ``canon="v1"`` for
# the legacy envelope-only form. ``verify_signature`` honours the marker and
# treats an absent marker as transition mode (accept either form), matching the
# server.
#
# Compatibility: a v2-default emitter requires a v2-aware server (server PR #60+);
# an older server that predates ``signature.canon`` support would reject v2. The
# server keeps accepting v1 during the transition, so ``canon="v1"`` remains
# available for talking to legacy servers.
_SUPPORTED_CANON = frozenset({"v1", "v2"})


def sign_event(
    event: dict[str, Any], secret: str, *, canon: Literal["v1", "v2"] = "v2"
) -> dict[str, Any]:
    """Add an HMAC-SHA256 signature to *event* in-place and return it.

    Args:
        event: the event envelope (mutated in place).
        secret: the HMAC shared secret.
        canon: canonicalization version — ``"v2"`` (default, deep, covers nested
            payloads, records a ``signature.canon`` marker) or ``"v1"`` (legacy,
            envelope-only, no marker).

    Raises:
        ValueError: if *canon* is not ``"v1"`` or ``"v2"``. (Fail loudly on a
            typo rather than silently signing the wrong/unmarked form — the
            verifier is strict about the marker, so the emitter is too.)

    The v2 path uses :func:`canonicalize_v2`; the v1 path mirrors the
    canonical-form algorithm in src/signature.js (shallow-copy, drop
    ``signature``, sort top-level keys, JSON-encode).
    """
    if canon not in _SUPPORTED_CANON:
        raise ValueError(f"Unsupported canon {canon!r} — expected 'v1' or 'v2'")
    canonical = canonicalize_v2(event) if canon == "v2" else _canonicalize(event)
    digest = hmac.new(
        secret.encode("utf-8"),
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    signature: dict[str, str] = {
        "alg": "hmac-sha256",
        "value": base64.b64encode(digest).decode("utf-8"),
    }
    if canon == "v2":
        signature["canon"] = "v2"
    event["signature"] = signature
    return event


def verify_signature(event: dict[str, Any], secret: str) -> dict[str, bool | str]:
    """Verify the HMAC-SHA256 signature on an event envelope.

    Version-aware (issue #59): honours ``signature.canon`` — ``"v2"`` verifies
    against the deep form only, ``"v1"`` against the shallow form only, and an
    absent marker is transition mode (accepted if it matches *either* form, so
    legacy shallow emitters and unmarked deep ones both keep working). Mirrors
    ``verifySignature()`` in src/signature.js. Uses :func:`hmac.compare_digest`
    for timing-safe comparison.

    Timing note: in transition mode an unmarked event may run a second HMAC +
    constant-time compare when the first form does not match. Each compare is
    constant-time; the extra round only reveals "the v1 form didn't match", never
    key material — so it is not a forgery oracle. A marked sig does one round.

    Returns:
        ``{"valid": True}`` on success, or ``{"valid": False, "error": "<reason>"}``
        on failure. Never raises — all error paths return ``valid=False``.
    """
    if not isinstance(event, dict):
        return {"valid": False, "error": "Event is missing a 'signature' field"}
    sig = event.get("signature")
    if not isinstance(sig, dict):
        return {"valid": False, "error": "Event is missing a 'signature' field"}
    if sig.get("alg") != "hmac-sha256":
        return {
            "valid": False,
            "error": f"Unsupported signature algorithm {sig.get('alg')!r} — expected 'hmac-sha256'",
        }
    value = sig.get("value")
    if not isinstance(value, str) or not value:
        return {"valid": False, "error": "signature.value is missing or not a string"}

    canon = sig.get("canon")
    if canon is not None and (not isinstance(canon, str) or canon not in _SUPPORTED_CANON):
        return {
            "valid": False,
            "error": f"Unsupported signature canonicalization {canon!r} — expected 'v1' or 'v2'",
        }

    try:
        provided_digest = base64.b64decode(value)
    except Exception:
        return {"valid": False, "error": "Signature mismatch"}

    # Absent marker → transition mode: accept either form.
    forms: tuple[str, ...] = (
        ("v2",) if canon == "v2" else ("v1",) if canon == "v1" else ("v1", "v2")
    )
    for form in forms:
        canonical = canonicalize_v2(event) if form == "v2" else _canonicalize(event)
        expected_digest = hmac.new(
            secret.encode("utf-8"),
            canonical.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        if hmac.compare_digest(expected_digest, provided_digest):
            return {"valid": True}

    return {"valid": False, "error": "Signature mismatch"}


def _canonicalize(event: dict[str, Any]) -> str:
    """Return the **v1** canonical JSON string used as the HMAC input.

    Mirrors ``canonicalize()`` in src/signature.js exactly:
    * Removes the ``signature`` field.
    * Sorts all top-level keys alphabetically.
    * Recursively filters nested object keys to only those in the top-level
      sorted key set (replicating ``JSON.stringify(copy, sortedKeys)`` behaviour).

    Envelope-only: nested payload contents are dropped. Kept byte-identical for
    cross-SDK v1 parity.
    """
    copy = {k: v for k, v in event.items() if k != "signature"}
    sorted_keys = sorted(copy.keys())
    key_set = frozenset(sorted_keys)

    def _filter(obj: Any) -> Any:
        if isinstance(obj, dict):
            return {k: _filter(v) for k, v in obj.items() if k in key_set}
        if isinstance(obj, list):
            return [_filter(item) for item in obj]
        return obj

    filtered = {k: _filter(copy[k]) for k in sorted_keys}
    return json.dumps(filtered, separators=(",", ":"), ensure_ascii=False)


def canonicalize_v2(event: dict[str, Any]) -> str:
    """Return the **v2** (deep) canonical JSON string used as the HMAC input.

    Drops the ``signature`` field, then JSON-encodes the whole event with keys
    sorted recursively at every level (``sort_keys=True``) and no whitespace.
    Unlike :func:`_canonicalize`, nested payloads ARE included, so a v2 signature
    covers payload contents.

    Byte-identical to the server's ``canonicalizeV2`` (src/_canonical.js) and the
    Node SDK's for JSON values shared across runtimes (strings, integers,
    booleans, nested objects/arrays). Float edge cases (e.g. ``1.0`` / ``1e-7``)
    serialize differently across Node/Python/Go and are reconciled as v2 rollout
    proceeds — see issue #59.

    The whole ``signature`` object is dropped before hashing, so the
    ``signature.canon`` marker is intentionally outside HMAC coverage (a hint,
    not an authenticated assertion).
    """
    copy = {k: v for k, v in event.items() if k != "signature"}
    return json.dumps(copy, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
