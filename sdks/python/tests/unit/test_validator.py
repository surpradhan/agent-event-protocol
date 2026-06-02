"""Unit tests for aep._validator.validate_event()."""

import pytest

from aep import validate_event


# ── helpers ────────────────────────────────────────────────────────────────────

def _valid_event(**overrides):
    base = {
        "specversion": "0.2.0",
        "id": "evt_abc123",
        "time": "2026-01-01T00:00:00.000Z",
        "source": "agent://test",
        "type": "task.created",
        "session_id": "ses_001",
        "trace_id": "trc_001",
        "payload": {},
    }
    base.update(overrides)
    return base


def _without(key: str):
    ev = _valid_event()
    del ev[key]
    return ev


# ── happy path ─────────────────────────────────────────────────────────────────

def test_valid_minimal_event():
    result = validate_event(_valid_event())
    assert result["valid"] is True
    assert result["errors"] == []


def test_valid_with_optional_fields():
    result = validate_event(_valid_event(
        agent_role="orchestrator",
        parent_session_id="ses_parent",
        causation_id="evt_prev",
        labels={"env": "test"},
    ))
    assert result["valid"] is True


def test_valid_all_event_types():
    from aep import CORE_EVENT_TYPES
    for t in CORE_EVENT_TYPES:
        result = validate_event(_valid_event(type=t))
        assert result["valid"] is True, f"Expected valid for type {t!r}: {result['errors']}"


# ── missing required fields ────────────────────────────────────────────────────

@pytest.mark.parametrize("field", [
    "specversion", "id", "time", "source", "type", "session_id", "trace_id", "payload"
])
def test_missing_required_field(field):
    result = validate_event(_without(field))
    assert result["valid"] is False
    assert len(result["errors"]) > 0


# ── wrong specversion ──────────────────────────────────────────────────────────

def test_wrong_specversion():
    result = validate_event(_valid_event(specversion="0.1.0"))
    assert result["valid"] is False
    assert any("specversion" in e or "pattern" in e for e in result["errors"])


# ── unknown event type ─────────────────────────────────────────────────────────

def test_unknown_event_type():
    result = validate_event(_valid_event(type="custom.invented"))
    assert result["valid"] is False
    assert any("type" in e.lower() or "core" in e.lower() for e in result["errors"])


# ── payload $schema handling ───────────────────────────────────────────────────

def test_unknown_payload_schema_ref_warns_but_valid():
    result = validate_event(_valid_event(
        payload={"$schema": "https://example.com/unknown.schema.json", "data": 1}
    ))
    assert result["valid"] is True
    warnings = [e for e in result["errors"] if e.startswith("[warn]")]
    assert len(warnings) == 1
    assert "could not be resolved" in warnings[0]


def test_known_payload_schema_valid_payload():
    # tool-called.schema.json exists in schemas/payloads/
    result = validate_event(_valid_event(
        type="tool.called",
        payload={
            "$schema": "https://aep.dev/schemas/payloads/tool-called.schema.json",
            "tool_name": "web.search",
            "arguments": {"query": "test"},
        }
    ))
    assert result["valid"] is True
    # No blocking errors (warnings may exist)
    blocking = [e for e in result["errors"] if not e.startswith("[warn]")]
    assert blocking == []


def test_known_payload_schema_invalid_payload():
    # tool-called.schema.json requires tool_name and arguments
    result = validate_event(_valid_event(
        type="tool.called",
        payload={
            "$schema": "https://aep.dev/schemas/payloads/tool-called.schema.json",
            # Missing required tool_name and arguments
        }
    ))
    assert result["valid"] is False
    assert any("payload" in e and "from $schema" in e for e in result["errors"])


# ── error format ───────────────────────────────────────────────────────────────

def test_return_shape():
    result = validate_event(_valid_event())
    assert "valid" in result
    assert "errors" in result
    assert isinstance(result["valid"], bool)
    assert isinstance(result["errors"], list)


def test_errors_are_strings():
    result = validate_event(_without("session_id"))
    for e in result["errors"]:
        assert isinstance(e, str)


def test_invalid_input_not_dict():
    result = validate_event("not a dict")  # type: ignore[arg-type]
    assert result["valid"] is False
    assert len(result["errors"]) > 0
