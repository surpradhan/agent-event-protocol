"""Agent Event Protocol (AEP) Python SDK — v0.2.0.

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

from aep._event import create_event
from aep._signature import sign_event, verify_signature
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

__version__ = "0.2.0"

__all__ = [
    "AgentRole",
    "AEPAuthError",
    "AEPClient",
    "AEPConnectionError",
    "AEPError",
    "AEPNotFoundError",
    "AEPRateLimitError",
    "AEPServerError",
    "AEPValidationError",
    "AsyncAEPClient",
    "CORE_EVENT_TYPES",
    "EventType",
    "create_event",
    "sign_event",
    "validate_event",
    "verify_signature",
]
