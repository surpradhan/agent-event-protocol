"""Span-to-event mapping logic for OTEL → AEP conversion.

Maps OpenTelemetry ReadableSpan to AEP events with causation chain preservation.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from aep._event import create_event
from aep._types import EventType


def map_span_to_event(
    span: Any,
    resource: Any | dict,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Map an OTEL ReadableSpan to AEP event(s).

    Returns a tuple of (intermediate_events, final_event) where:
    - intermediate_events: list of events emitted during span (e.g., on start)
    - final_event: event emitted on span end
    """
    span_name = span.name or "unknown"
    span_kind = span.kind.name if hasattr(span.kind, "name") else "INTERNAL"
    attributes = dict(span.attributes) if span.attributes else {}
    trace_id = _format_trace_id(span.context.trace_id)
    span_id = _format_span_id(span.context.span_id)
    parent_span_id = _format_span_id(span.parent.span_id) if span.parent else None

    # Handle both dict and object resources
    if isinstance(resource, dict):
        service_name = resource.get("service.name", "unknown")
    elif resource and hasattr(resource, "attributes"):
        service_name = resource.attributes.get("service.name", "unknown")
    else:
        service_name = "unknown"

    source = f"agent://{service_name}"
    session_id = _derive_session_id(service_name, span.name)

    intermediate_events = []
    final_event = None

    payload = _build_payload(attributes, span_name, span_kind)

    if _is_task_span(span_name):
        if span.status.is_ok if hasattr(span.status, "is_ok") else True:
            final_type = EventType.TASK_COMPLETED
        else:
            final_type = EventType.TASK_FAILED
        final_event = create_event(
            source=source,
            type=final_type,
            session_id=session_id,
            trace_id=trace_id,
            payload=payload,
            causation_id=parent_span_id,
            subject=span_name,
        )

    elif _is_tool_span(span_name, span_kind):
        final_type = EventType.TOOL_RESULT
        final_event = create_event(
            source=source,
            type=final_type,
            session_id=session_id,
            trace_id=trace_id,
            payload=payload,
            causation_id=parent_span_id,
            subject=span_name,
        )

    elif _is_handoff_span(span_name):
        final_type = EventType.HANDOFF_COMPLETED
        final_event = create_event(
            source=source,
            type=final_type,
            session_id=session_id,
            trace_id=trace_id,
            payload=payload,
            causation_id=parent_span_id,
            subject=span_name,
        )

    elif _is_error_span(span):
        final_type = EventType.ERROR_RAISED
        final_event = create_event(
            source=source,
            type=final_type,
            session_id=session_id,
            trace_id=trace_id,
            payload=_build_error_payload(span, attributes),
            causation_id=parent_span_id,
            subject=span_name,
        )

    else:
        final_type = EventType.TASK_COMPLETED
        final_event = create_event(
            source=source,
            type=final_type,
            session_id=session_id,
            trace_id=trace_id,
            payload=payload,
            causation_id=parent_span_id,
            subject=span_name,
        )

    return intermediate_events, final_event


def _is_task_span(name: str) -> bool:
    """Check if span name indicates a task."""
    return "task" in name.lower()


def _is_tool_span(name: str, kind: str) -> bool:
    """Check if span name and kind indicate a tool call."""
    return "tool" in name.lower() and kind in ("CLIENT", "SERVER")


def _is_handoff_span(name: str) -> bool:
    """Check if span name indicates a handoff."""
    return "handoff" in name.lower()


def _is_error_span(span: Any) -> bool:
    """Check if span has error status."""
    if not hasattr(span, "status"):
        return False
    status = span.status
    if hasattr(status, "is_ok"):
        return not status.is_ok
    return False


def _build_payload(attributes: dict[str, Any], span_name: str, span_kind: str) -> dict[str, Any]:
    """Build AEP event payload from OTEL span attributes."""
    payload: dict[str, Any] = {
        "span_name": span_name,
        "span_kind": span_kind,
    }

    gen_ai_attrs = {k: v for k, v in attributes.items() if k.startswith("gen_ai.")}
    if gen_ai_attrs:
        payload["gen_ai"] = gen_ai_attrs

    user_attrs = {k: v for k, v in attributes.items() if not k.startswith("gen_ai.")}
    if user_attrs:
        payload["attributes"] = user_attrs

    return payload


def _build_error_payload(span: Any, attributes: dict[str, Any]) -> dict[str, Any]:
    """Build error event payload."""
    payload = _build_payload(attributes, span.name, span.kind.name if hasattr(span.kind, "name") else "INTERNAL")

    if hasattr(span, "status") and hasattr(span.status, "description"):
        payload["error_description"] = span.status.description

    if hasattr(span, "events") and span.events:
        exception_events = [e for e in span.events if e.name == "exception"]
        if exception_events:
            exc_event = exception_events[0]
            if exc_event.attributes:
                payload["exception"] = dict(exc_event.attributes)

    return payload


def _format_trace_id(trace_id: int | str) -> str:
    """Format trace ID as hex string."""
    if isinstance(trace_id, str):
        return trace_id
    return f"{trace_id:032x}"


def _format_span_id(span_id: int | str | None) -> str | None:
    """Format span ID as hex string, or None."""
    if span_id is None:
        return None
    if isinstance(span_id, str):
        return span_id
    return f"{span_id:016x}"


def _derive_session_id(service_name: str, span_name: str) -> str:
    """Derive a session ID from service name and span name."""
    import hashlib

    combined = f"{service_name}::{span_name}"
    hash_obj = hashlib.sha256(combined.encode())
    return f"ses_{hash_obj.hexdigest()[:16]}"
