"""Integration tests for AEPClient against a live AEP server.

These tests are skipped automatically when the AEP server is not reachable.
Start the server with ``npm run ingest`` from the repo root, then run:

    AEP_INGEST_URL=http://localhost:8787 pytest tests/integration/
"""

import os
import uuid

import pytest

from aep import CORE_EVENT_TYPES, create_event
from aep.client import AEPClient
from aep.exceptions import AEPNotFoundError, AEPValidationError

_SERVER_URL = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
_API_KEY = os.environ.get("AEP_API_KEY")
# Server-reachability check and skip logic live in conftest.py so they run
# once per session rather than at import time during pytest collection.


@pytest.fixture(scope="module")
def client():
    with AEPClient(server_url=_SERVER_URL, api_key=_API_KEY) as c:
        yield c


def _new_session():
    ts = uuid.uuid4().hex[:8]
    return f"ses_inttest_{ts}", f"trc_inttest_{ts}"


# ── emit ───────────────────────────────────────────────────────────────────────

def test_emit_new_event(client):
    session_id, trace_id = _new_session()
    event = create_event(
        source="agent://integration-test",
        type="task.created",
        session_id=session_id,
        trace_id=trace_id,
        payload={"task": "test"},
    )
    result = client.emit(event)
    assert result.get("accepted") is True
    assert result.get("duplicate") is False
    assert result.get("id") == event["id"]


def test_emit_duplicate_event(client):
    session_id, trace_id = _new_session()
    event = create_event(
        source="agent://integration-test",
        type="task.created",
        session_id=session_id,
        trace_id=trace_id,
        payload={"task": "test"},
    )
    client.emit(event)
    result = client.emit(event)  # Same event ID
    assert result.get("duplicate") is True


def test_emit_invalid_event_raises(client):
    # Missing required fields
    with pytest.raises(AEPValidationError) as exc_info:
        client.emit({"type": "task.created"})
    assert len(exc_info.value.errors) > 0


# ── sessions ───────────────────────────────────────────────────────────────────

def test_get_sessions_returns_list(client):
    result = client.get_sessions(limit=10)
    assert "sessions" in result
    assert isinstance(result["sessions"], list)


def test_get_session_events(client):
    session_id, trace_id = _new_session()
    event = create_event(
        source="agent://integration-test",
        type="task.created",
        session_id=session_id,
        trace_id=trace_id,
        payload={"task": "event-list-test"},
    )
    client.emit(event)

    result = client.get_session_events(session_id)
    assert "events" in result
    assert any(e["id"] == event["id"] for e in result["events"])


def test_get_session_tree(client):
    session_id, trace_id = _new_session()
    event = create_event(
        source="agent://integration-test",
        type="task.created",
        session_id=session_id,
        trace_id=trace_id,
        payload={},
    )
    client.emit(event)

    tree = client.get_session_tree(session_id)
    assert tree.get("session_id") == session_id or "session" in tree


def test_get_session_tree_not_found(client):
    with pytest.raises(AEPNotFoundError):
        client.get_session_tree("ses_does_not_exist_xyz")


# ── workflows ──────────────────────────────────────────────────────────────────

def test_get_workflow_multi_session(client):
    ts = uuid.uuid4().hex[:8]
    orch_session = f"ses_orch_{ts}"
    sub_session = f"ses_sub_{ts}"
    trace_id = f"trc_multi_{ts}"

    events = [
        create_event(
            source="agent://orchestrator",
            type="task.created",
            session_id=orch_session,
            trace_id=trace_id,
            payload={"role": "orchestrator"},
            agent_role="orchestrator",
        ),
        create_event(
            source="agent://subagent",
            type="task.created",
            session_id=sub_session,
            trace_id=trace_id,
            payload={"role": "subagent"},
            agent_role="subagent",
            parent_session_id=orch_session,
        ),
    ]
    client.emit_batch(events)

    workflow = client.get_workflow(trace_id)
    assert workflow.get("trace_id") == trace_id
    assert workflow.get("session_count", 0) >= 2
    assert "tree" in workflow


def test_get_workflow_not_found(client):
    with pytest.raises(AEPNotFoundError):
        client.get_workflow("trc_does_not_exist_xyz")


# ── metrics ────────────────────────────────────────────────────────────────────

def test_get_metrics(client):
    result = client.get_metrics()
    assert "received" in result or "sessions" in result


# ── health ─────────────────────────────────────────────────────────────────────

def test_health(client):
    result = client.health()
    assert result.get("ok") is True or "service" in result
