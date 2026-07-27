"""Agent Event Protocol (AEP) Python SDK — v0.6.0.

Quick start::

    from aep import create_event, AEPClient

    event = create_event(
        source="agent://my-agent",
        type="task.created",
        session_id="ses_001",
        trace_id="trc_001",
        payload={"task": "summarise document"},
    )

    with AEPClient() as client:
        result = client.emit(event)
"""

from aep._audit import verify_audit_bundle
from aep._event import create_event
from aep._signature import canonicalize_v2, sign_event, verify_signature
from aep._types import CORE_EVENT_TYPES, AgentRole, EventType
from aep._validator import validate_event
from aep.async_client import AsyncAEPClient
from aep.client import AEPClient
from aep.exceptions import (
    AEPAuthError,
    AEPConnectionError,
    AEPError,
    AEPNotFoundError,
    AEPRateLimitError,
    AEPServerError,
    AEPValidationError,
)
from aep.instrument import flush, instrument, uninstrument

__version__ = "0.6.0"

__all__ = [
    "CORE_EVENT_TYPES",
    "AEPAuthError",
    "AEPClient",
    "AEPConnectionError",
    "AEPError",
    "AEPNotFoundError",
    "AEPRateLimitError",
    "AEPServerError",
    "AEPValidationError",
    "AgentRole",
    "AsyncAEPClient",
    "EventType",
    "canonicalize_v2",
    "create_event",
    "flush",
    "instrument",
    "sign_event",
    "uninstrument",
    "validate_event",
    "verify_audit_bundle",
    "verify_signature",
]
