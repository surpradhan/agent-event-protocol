from __future__ import annotations

import json
import pathlib
import threading
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from ._types import CORE_EVENT_TYPES

# Schemas are bundled inside the package under aep/schemas/ so this works both
# in the monorepo (editable install) and as a standalone pip-installed package.
_SCHEMAS_DIR = pathlib.Path(__file__).parent / "schemas"
_ENVELOPE_SCHEMA_PATH = _SCHEMAS_DIR / "aep-envelope.schema.json"
_PAYLOAD_SCHEMAS_DIR = _SCHEMAS_DIR / "payloads"

_envelope_validator: Draft202012Validator | None = None
_payload_schema_cache: dict[str, Draft202012Validator | None] = {}
_validator_lock = threading.Lock()


def _get_envelope_validator() -> Draft202012Validator:
    global _envelope_validator
    if _envelope_validator is not None:
        return _envelope_validator
    with _validator_lock:
        if _envelope_validator is not None:  # re-check after acquiring lock
            return _envelope_validator
        with open(_ENVELOPE_SCHEMA_PATH, encoding="utf-8") as fh:
            schema = json.load(fh)
        _envelope_validator = Draft202012Validator(schema)
    return _envelope_validator


def _resolve_payload_validator(schema_ref: str) -> Draft202012Validator | None:
    # Fast path: check cache without lock (GIL-safe on CPython for dict reads).
    if schema_ref in _payload_schema_cache:
        return _payload_schema_cache[schema_ref]

    with _validator_lock:
        # Double-checked locking: another thread may have populated the cache
        # between the fast-path check above and acquiring the lock.
        if schema_ref in _payload_schema_cache:
            return _payload_schema_cache[schema_ref]

        # Resolve and write to cache while holding the lock so concurrent
        # callers for the same ref don't each do redundant I/O.
        result = _load_payload_schema(schema_ref)
        _payload_schema_cache[schema_ref] = result
        return result


def _load_payload_schema(schema_ref: str) -> Draft202012Validator | None:
    """Resolve *schema_ref* to a validator. Returns ``None`` if unresolvable."""
    if not _PAYLOAD_SCHEMAS_DIR.exists():
        return None

    basename = schema_ref.split("/")[-1]
    candidate = _PAYLOAD_SCHEMAS_DIR / basename
    if not candidate.exists():
        if not basename.endswith(".schema.json"):
            candidate = _PAYLOAD_SCHEMAS_DIR / (basename + ".schema.json")
        if not candidate.exists():
            return None

    try:
        with open(candidate, encoding="utf-8") as fh:
            schema = json.load(fh)
        return Draft202012Validator(schema)
    except (OSError, SchemaError, ValueError):
        return None


def _sanitize(value: Any, max_len: int = 100) -> str:
    s = str(value or "")[:max_len]
    return (
        s.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )


def validate_event(event: dict[str, Any]) -> dict[str, bool | list[str]]:
    """Validate *event* against the AEP v0.2.0 envelope schema.

    Mirrors ``validateEvent()`` in src/validator.js.

    Returns:
        ``{"valid": bool, "errors": list[str]}``
        Entries prefixed with ``[warn]`` are non-blocking warnings.
    """
    validator = _get_envelope_validator()
    errors: list[str] = []

    schema_errors = sorted(validator.iter_errors(event), key=lambda e: list(e.absolute_path))
    for err in schema_errors:
        path = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "/"
        errors.append(f"{path} {err.message}")
    schema_ok = len(schema_errors) == 0

    type_ok = isinstance(event, dict) and event.get("type") in CORE_EVENT_TYPES
    if not type_ok:
        raw = event.get("type") if isinstance(event, dict) else None
        errors.append(f"type must be one of core v0.2 types; received '{_sanitize(raw)}'")

    # Optional payload schema validation
    payload_schema_ref: str | None = None
    if isinstance(event, dict):
        payload = event.get("payload")
        if isinstance(payload, dict):
            payload_schema_ref = payload.get("$schema")

    if payload_schema_ref:
        pv = _resolve_payload_validator(payload_schema_ref)
        if pv is not None:
            payload_errors = list(pv.iter_errors(event.get("payload", {})))
            for err in payload_errors:
                path = "payload" + (
                    "/" + "/".join(str(p) for p in err.absolute_path)
                    if err.absolute_path
                    else ""
                )
                errors.append(
                    f"{path} {err.message} (from $schema: {_sanitize(payload_schema_ref)})"
                )
        else:
            errors.append(
                f"[warn] payload.$schema '{_sanitize(payload_schema_ref)}' "
                "could not be resolved; payload accepted as-is"
            )

    blocking = [e for e in errors if not e.startswith("[warn]")]
    valid = schema_ok and type_ok and len(blocking) == 0
    return {"valid": valid, "errors": errors}
