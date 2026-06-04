"""Span-to-event mapping logic for OTEL → AEP conversion.

Maps OpenTelemetry ReadableSpan to AEP events with causation chain preservation.
"""

from __future__ import annotations

from typing import Any

from aep._event import create_event
from aep._types import EventType


def map_span_to_event(
    span: Any,
    resource: Any | dict,
    source_prefix: str = "agent://",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Map an OTEL ReadableSpan to AEP event(s).

    Returns a tuple of (intermediate_events, final_event) where:
    - intermediate_events: list of events emitted during span (currently empty;
                           reserved for future span-start events)
    - final_event: event emitted on span end

    Args:
        span: OpenTelemetry ReadableSpan
        resource: Resource attributes (dict or object with .attributes)
        source_prefix: Prefix for event source URI (default: "agent://")
    """
    span_name = span.name or "unknown"
    span_kind = span.kind.name if hasattr(span.kind, "name") else "INTERNAL"
    attributes = dict(span.attributes) if span.attributes else {}
    trace_id = _format_trace_id(span.context.trace_id)

    # Safely extract parent span ID
    parent_span_id = None
    if span.parent and hasattr(span.parent, "span_id"):
        parent_span_id = _format_span_id(span.parent.span_id)

    # Handle both dict and object resources
    if isinstance(resource, dict):
        service_name = resource.get("service.name", "unknown")
    elif resource and hasattr(resource, "attributes"):
        service_name = resource.attributes.get("service.name", "unknown")
    else:
        service_name = "unknown"

    source = f"{source_prefix}{service_name}"
    # Derive session ID from trace context (prevents collisions across invocations)
    session_id = _derive_session_id(trace_id)

    # Currently only emit on span end; intermediate_events reserved for future expansion
    intermediate_events: list[dict[str, Any]] = []
    final_event = None

    payload = _build_payload(attributes, span_name, span_kind)

    # Priority order: error > handoff > tool > task > default
    # This ensures error conditions are not masked by other classification.
    if _is_error_span(span):
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

    elif _is_task_span(span_name):
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

    # Validate the generated event before returning
    from aep._validator import validate_event

    try:
        validate_event(final_event)
    except Exception as e:
        raise ValueError(f"Generated invalid AEP event: {e}") from e

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
    """Check if span represents an error event (not just failure).

    Maps to ERROR_RAISED only if:
    - Span has non-OK status, AND
    - Span name contains "error"

    (Task spans with error status map to TASK_FAILED, not ERROR_RAISED.
     Only spans explicitly named "error*" map to ERROR_RAISED.)
    """
    if not hasattr(span, "status"):
        return False
    status = span.status
    has_error_status = hasattr(status, "is_ok") and not status.is_ok
    has_error_name = "error" in span.name.lower() if span.name else False
    return has_error_status and has_error_name


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


def _derive_session_id(trace_id: str) -> str:
    """Derive a session ID from trace context.

    Uses the OTEL trace_id to ensure sessions group by distributed execution,
    not by span name. This prevents collisions across invocations while
    maintaining consistency across all spans in a trace.
    """
    # Use first 16 hex chars of trace_id (64 bits entropy)
    return f"ses_{trace_id[:16]}"
