"""Unit tests for aep._event.create_event()."""

import re

import pytest

from aep import CORE_EVENT_TYPES, create_event


# ── helpers ────────────────────────────────────────────────────────────────────

_REQUIRED = dict(
    source="agent://test",
    type="task.created",
    session_id="ses_001",
    trace_id="trc_001",
    payload={"msg": "hello"},
)

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def make(**overrides):
    return create_event(**{**_REQUIRED, **overrides})


# ── core envelope ──────────────────────────────────────────────────────────────

def test_specversion():
    event = make()
    assert event["specversion"] == "0.2.0"


def test_required_fields_present():
    event = make()
    for key in ("specversion", "id", "time", "source", "type", "session_id", "trace_id", "payload"):
        assert key in event


def test_auto_generated_id_format():
    event = make()
    assert event["id"].startswith("evt_")
    assert len(event["id"]) == 4 + 32  # "evt_" + 32 hex chars


def test_auto_generated_id_is_unique():
    ids = {make()["id"] for _ in range(20)}
    assert len(ids) == 20


def test_auto_generated_time_is_iso8601():
    event = make()
    assert ISO_RE.match(event["time"]), f"time {event['time']!r} doesn't match ISO 8601"


def test_explicit_id_preserved():
    event = make(id="evt_custom_id")
    assert event["id"] == "evt_custom_id"


def test_explicit_time_preserved():
    event = make(time="2026-01-01T00:00:00.000Z")
    assert event["time"] == "2026-01-01T00:00:00.000Z"


def test_payload_included():
    event = make(payload={"key": "value", "count": 42})
    assert event["payload"] == {"key": "value", "count": 42}


# ── all 12 core event types ────────────────────────────────────────────────────

@pytest.mark.parametrize("event_type", CORE_EVENT_TYPES)
def test_all_event_types_accepted(event_type):
    event = make(type=event_type)
    assert event["type"] == event_type


# ── optional fields ────────────────────────────────────────────────────────────

def test_optional_fields_omitted_when_none():
    event = make()
    for key in ("parent_session_id", "agent_role", "causation_id", "subject",
                "idempotency_key", "schema", "content_type", "signature",
                "tenant", "labels", "extensions"):
        assert key not in event


def test_agent_role_included_when_set():
    event = make(agent_role="orchestrator")
    assert event["agent_role"] == "orchestrator"


def test_parent_session_id_included_when_set():
    event = make(agent_role="subagent", parent_session_id="ses_parent_001")
    assert event["parent_session_id"] == "ses_parent_001"
    assert event["agent_role"] == "subagent"


def test_causation_id_included():
    event = make(causation_id="evt_abc")
    assert event["causation_id"] == "evt_abc"


def test_labels_included():
    event = make(labels={"env": "prod", "region": "us-east-1"})
    assert event["labels"] == {"env": "prod", "region": "us-east-1"}


def test_extensions_included():
    event = make(extensions={"custom": "data"})
    assert event["extensions"] == {"custom": "data"}


def test_all_optional_fields_set():
    event = create_event(
        source="agent://test",
        type="tool.called",
        session_id="ses_002",
        trace_id="trc_002",
        payload={"tool_name": "web.search", "arguments": {}},
        parent_session_id="ses_001",
        agent_role="subagent",
        causation_id="evt_prev",
        subject="topic:research",
        idempotency_key="idem_001",
        schema="https://example.com/schema",
        content_type="application/json",
        tenant="acme",
        labels={"env": "test"},
        extensions={"meta": "extra"},
    )
    assert event["parent_session_id"] == "ses_001"
    assert event["agent_role"] == "subagent"
    assert event["causation_id"] == "evt_prev"
    assert event["subject"] == "topic:research"
    assert event["idempotency_key"] == "idem_001"
    assert event["schema"] == "https://example.com/schema"
    assert event["content_type"] == "application/json"
    assert event["tenant"] == "acme"
    assert event["labels"] == {"env": "test"}
    assert event["extensions"] == {"meta": "extra"}


# ── validation errors ──────────────────────────────────────────────────────────

def test_invalid_type_raises():
    with pytest.raises(ValueError, match="Unsupported event type"):
        create_event(
            source="agent://test",
            type="not.a.real.type",
            session_id="ses_001",
            trace_id="trc_001",
            payload={},
        )


def test_invalid_agent_role_raises():
    with pytest.raises(ValueError, match="Invalid agent_role"):
        make(agent_role="robot")


@pytest.mark.parametrize("role", ["orchestrator", "subagent", "standalone"])
def test_valid_agent_roles(role):
    event = make(agent_role=role)
    assert event["agent_role"] == role
