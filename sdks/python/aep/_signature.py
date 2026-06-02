from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any


def sign_event(event: dict[str, Any], secret: str) -> dict[str, Any]:
    """Add an HMAC-SHA256 signature to *event* in-place and return it.

    Mirrors the canonical-form algorithm in src/signature.js:
    1. Shallow-copy the event and remove the ``signature`` key.
    2. Collect all top-level key names and sort them alphabetically.
    3. Build a JSON string that includes only those keys at every nesting level
       (matching ``JSON.stringify(copy, sortedKeys)`` in Node.js).
    4. Compute ``HMAC-SHA256(canonical_string, secret)`` and base64-encode.
    5. Attach ``event["signature"] = {"alg": "hmac-sha256", "value": <b64>}``.
    """
    canonical = _canonicalize(event)
    digest = hmac.new(
        secret.encode("utf-8"),
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    event["signature"] = {
        "alg": "hmac-sha256",
        "value": base64.b64encode(digest).decode("utf-8"),
    }
    return event


def verify_signature(event: dict[str, Any], secret: str) -> dict[str, bool | str]:
    """Verify the HMAC-SHA256 signature on an event envelope.

    Mirrors ``verifySignature()`` in src/signature.js. Uses :func:`hmac.compare_digest`
    for timing-safe comparison to prevent timing-oracle attacks.

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

    canonical = _canonicalize(event)
    expected_digest = hmac.new(
        secret.encode("utf-8"),
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).digest()

    try:
        provided_digest = base64.b64decode(value)
    except Exception:
        return {"valid": False, "error": "Signature mismatch"}

    if not hmac.compare_digest(expected_digest, provided_digest):
        return {"valid": False, "error": "Signature mismatch"}

    return {"valid": True}


def _canonicalize(event: dict[str, Any]) -> str:
    """Return the canonical JSON string used as the HMAC input.

    Mirrors ``canonicalize()`` in src/signature.js exactly:
    * Removes the ``signature`` field.
    * Sorts all top-level keys alphabetically.
    * Recursively filters nested object keys to only those in the top-level
      sorted key set (replicating ``JSON.stringify(copy, sortedKeys)`` behaviour).
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
