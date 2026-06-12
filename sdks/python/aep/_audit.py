"""Offline verification of tamper-evident audit bundles (Phase 14 add-on).

Mirrors the server's ``verifyAuditBundle`` (``src/audit.js``): recompute the
content digest from the bundle's events and the HMAC signature from its manifest,
comparing both constant-time. This lets a compliance reviewer verify a bundle
produced by ``GET /sessions/:id/audit-bundle`` (or ``aep audit export``) entirely
offline — no server, no database — using only the bundle JSON and the audit
signing secret.

The canonical forms are byte-identical to the server: events use the v2 deep
canonical form (:func:`aep.canonicalize_v2`), and the manifest uses the same deep,
recursively key-sorted JSON. Cross-language parity is locked by a shared
known-answer bundle fixture (``tests/fixtures/audit/kat-bundle.json``) that the
server, this SDK, and the Go/Node SDKs all verify identically.

This module only **verifies** — building/signing bundles stays server-side (the
signing secret lives on the server).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

from ._signature import canonicalize_v2

_SUPPORTED_DIGEST_ALGS = frozenset({"sha256", "sha512"})
_DEFAULT_DIGEST_ALG = "sha256"


def _stable_stringify(value: Any) -> str:
    """Deep, recursively key-sorted, whitespace-free JSON — the manifest's HMAC
    input, byte-identical to the server's ``stableStringify`` (src/_canonical.js)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _serialize_events(events: list[Any]) -> str:
    return "\n".join(canonicalize_v2(e) for e in events)


def _content_digest(events: list[Any], alg: str) -> str:
    h = hashlib.new(alg)
    h.update(_serialize_events(events).encode("utf-8"))
    return h.hexdigest()


def _manifest_signature(manifest: Any, secret: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        _stable_stringify(manifest).encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def _fail(error: str) -> dict[str, Any]:
    return {
        "valid": False,
        "errors": [error],
        "content_digest_match": False,
        "manifest_signature_valid": False,
        "per_event": [],
    }


def verify_audit_bundle(bundle: Any, secret: str) -> dict[str, Any]:
    """Verify an audit bundle offline.

    :param bundle: a bundle produced by the server's ``buildAuditBundle`` (or a
        tampered one) — the parsed JSON object.
    :param secret: the audit signing secret (``AUDIT_SIGNING_SECRET``).
    :returns: a dict with ``valid`` (bool), ``errors`` (list[str]),
        ``content_digest_match`` (bool), ``manifest_signature_valid`` (bool), and
        ``per_event`` (list of ``{index, id, signature_present}``).
    """
    if not isinstance(bundle, dict):
        return _fail("Bundle is not an object")
    if not isinstance(secret, str) or not secret:
        return _fail("A non-empty secret is required to verify (set AUDIT_SIGNING_SECRET)")

    manifest = bundle.get("manifest")
    events = bundle.get("events")
    signature = bundle.get("signature")
    event_list: list[Any] = events if isinstance(events, list) else []

    errors: list[str] = []
    if not isinstance(events, list):
        errors.append("Bundle is missing an `events` array")
    if not isinstance(manifest, dict):
        errors.append("Bundle is missing a `manifest` object")
    if not isinstance(signature, dict):
        errors.append("Bundle is missing a `signature` object")

    # --- content digest check ---
    content_digest_match = False
    if isinstance(manifest, dict):
        declared_alg = manifest.get("content_digest_alg", _DEFAULT_DIGEST_ALG)
        if declared_alg not in _SUPPORTED_DIGEST_ALGS:
            errors.append(f"Unsupported content_digest_alg {declared_alg!r}")
        else:
            recomputed = _content_digest(event_list, declared_alg)
            cd = manifest.get("content_digest")
            content_digest_match = isinstance(cd, str) and hmac.compare_digest(cd, recomputed)
            if not content_digest_match:
                errors.append(
                    "content_digest does not match the bundled events "
                    "(events were modified, reordered, added, or dropped)"
                )
        # event_count cross-check (bool is an int subclass — exclude it).
        ec = manifest.get("event_count")
        if not isinstance(ec, int) or isinstance(ec, bool):
            errors.append("manifest.event_count is missing or not a number")
        elif ec != len(event_list):
            errors.append(
                f"manifest.event_count ({ec}) does not match the number of "
                f"bundled events ({len(event_list)})"
            )

    # --- manifest signature check ---
    manifest_signature_valid = False
    if isinstance(manifest, dict) and isinstance(signature, dict):
        if signature.get("alg") != "hmac-sha256":
            errors.append(
                f"Unsupported signature algorithm {signature.get('alg')!r} — "
                "expected 'hmac-sha256'"
            )
        elif not isinstance(signature.get("value"), str):
            errors.append("signature.value is missing or not a string")
        else:
            expected = _manifest_signature(manifest, secret)
            manifest_signature_valid = hmac.compare_digest(signature["value"], expected)
            if not manifest_signature_valid:
                errors.append(
                    "manifest signature is invalid (manifest was modified or the "
                    "wrong secret was used)"
                )

    # --- version cross-check (the top-level copy is unsigned) ---
    if (
        isinstance(manifest, dict)
        and bundle.get("aep_audit_version") is not None
        and bundle.get("aep_audit_version") != manifest.get("aep_audit_version")
    ):
        errors.append(
            f"aep_audit_version mismatch: bundle {bundle.get('aep_audit_version')!r} "
            f"vs signed manifest {manifest.get('aep_audit_version')!r}"
        )

    per_event = [
        {
            "index": i,
            "id": e.get("id") if isinstance(e, dict) else None,
            "signature_present": isinstance(e, dict) and isinstance(e.get("signature"), dict),
        }
        for i, e in enumerate(event_list)
    ]

    return {
        "valid": len(errors) == 0 and content_digest_match and manifest_signature_valid,
        "errors": errors,
        "content_digest_match": content_digest_match,
        "manifest_signature_valid": manifest_signature_valid,
        "per_event": per_event,
    }
