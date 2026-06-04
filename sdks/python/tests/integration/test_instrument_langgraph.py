"""Integration test for LangGraph auto-instrumentation.

Runs a real two-node LangGraph graph with ``aep.instrument()`` enabled and
verifies the events land in a running AEP server with the expected causation
structure.

Skipping:
- The whole module skips if ``langgraph`` is not installed.
- ``conftest.py`` skips every ``integration`` test (via
  ``pytest_collection_modifyitems``) when the AEP server is unreachable, so no
  per-test server guard is needed here.
"""

from __future__ import annotations

import os
import time
import uuid
from typing import TypedDict

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed")

from langgraph.graph import END, START, StateGraph  # noqa: E402

import aep  # noqa: E402
from aep.client import AEPClient  # noqa: E402
from aep.instrument import uninstrument  # noqa: E402


@pytest.fixture
def instrumented():
    """Enable instrumentation for one test, then tear it down cleanly."""
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")
    assert aep.instrument(server_url=server_url, api_key=api_key), "instrument() failed"
    try:
        yield server_url, api_key
    finally:
        uninstrument()


def test_langgraph_run_emits_dag_to_server(instrumented):
    server_url, api_key = instrumented

    class S(TypedDict):
        value: int

    # Unique marker so we can find this run's orchestrator among existing sessions.
    marker = uuid.uuid4().hex[:8]

    g = StateGraph(S)
    g.add_node("increment", lambda s: {"value": s["value"] + 1})
    g.add_node("double", lambda s: {"value": s["value"] * 2})
    g.add_edge(START, "increment")
    g.add_edge("increment", "double")
    g.add_edge("double", END)
    app = g.compile()
    app.name = f"itest-{marker}"

    result = app.invoke({"value": 5})
    assert result["value"] == 12  # (5 + 1) * 2

    time.sleep(0.5)  # allow ingest to settle

    with AEPClient(server_url=server_url, api_key=api_key) as client:
        sessions = client.get_sessions(limit=100).get("sessions", [])
        # Our orchestrator source is "agent://itest-<marker>".
        orch = next(
            (
                s
                for s in sessions
                if s.get("agent_role") == "orchestrator" and marker in str(s.get("source", ""))
            ),
            None,
        )
        assert orch is not None, "orchestrator session not recorded by server"

        events = client.get_session_events(orch["session_id"], limit=200).get("events", [])
        types = {e["type"] for e in events}
        # Orchestrator session carries its own task lifecycle plus the handoffs.
        assert "task.created" in types
        assert "task.completed" in types
        assert "handoff.started" in types

        # The workflow view should report more than one session (orchestrator + nodes).
        workflow = client.get_workflow(orch["trace_id"])
        assert workflow.get("session_count", 0) >= 2
