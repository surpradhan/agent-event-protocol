from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ._types import CORE_EVENT_TYPES, AgentRole

SPEC_VERSION = "0.2.0"
_VALID_ROLES = {r.value for r in AgentRole}


def create_event(
    source: str,
    type: str,
    session_id: str,
    trace_id: str,
    payload: dict[str, Any],
    *,
    id: str | None = None,
    time: str | None = None,
    parent_session_id: str | None = None,
    agent_role: str | None = None,
    causation_id: str | None = None,
    subject: str | None = None,
    idempotency_key: str | None = None,
    schema: str | None = None,
    content_type: str | None = None,
    signature: dict[str, Any] | None = None,
    tenant: str | None = None,
    labels: dict[str, str] | None = None,
    extensions: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a spec-compliant AEP v0.2.0 event envelope.

    Mirrors src/createEvent.js. Returns a plain dict ready for JSON serialisation.
    Auto-generates ``id`` (``evt_<uuid_hex>``) and ``time`` (UTC ISO-8601) when omitted.
    """
    if type not in CORE_EVENT_TYPES:
        raise ValueError(
            f"Unsupported event type: {type!r}. "
            f"Must be one of: {', '.join(CORE_EVENT_TYPES)}"
        )

    if agent_role is not None and agent_role not in _VALID_ROLES:
        raise ValueError(
            f"Invalid agent_role {agent_role!r}. "
            f"Must be one of: {', '.join(sorted(_VALID_ROLES))}"
        )

    event: dict[str, Any] = {
        "specversion": SPEC_VERSION,
        "id": id if id is not None else f"evt_{uuid.uuid4().hex}",
        "time": time if time is not None else _now_iso(),
        "source": source,
        "type": type,
        "session_id": session_id,
        "trace_id": trace_id,
        "payload": payload,
    }

    optional: dict[str, Any] = {
        "parent_session_id": parent_session_id,
        "agent_role": agent_role,
        "subject": subject,
        "causation_id": causation_id,
        "idempotency_key": idempotency_key,
        "schema": schema,
        "content_type": content_type,
        "signature": signature,
        "tenant": tenant,
        "labels": labels,
        "extensions": extensions,
    }
    for key, value in optional.items():
        if value is not None:
            event[key] = value

    return event


def _now_iso() -> str:
    dt = datetime.now(tz=timezone.utc)
    ms = dt.microsecond // 1000
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{ms:03d}Z"
