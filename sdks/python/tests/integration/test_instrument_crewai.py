"""Integration test for CrewAI auto-instrumentation.

Runs a real ``Crew.kickoff()`` with ``aep.instrument()`` enabled and verifies the
events land in a running AEP server with the expected causation structure.

The crew is deliberately run **without an LLM API key**, so the agent execution
fails fast — but the crew/task/handoff lifecycle still fires on CrewAI's event
bus, which is what we assert is recorded by the server (orchestrator task,
crew → agent handoff, a multi-session workflow on one trace). This keeps the test
hermetic: no model calls, no network beyond the AEP server.

Skipping:
- The whole module skips if ``crewai`` is not installed.
- ``conftest.py`` skips every ``integration`` test when the AEP server is
  unreachable, so no per-test server guard is needed here.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest

pytest.importorskip("crewai", reason="crewai not installed")

from crewai import Agent, Crew, Task  # noqa: E402

try:  # LLM lives at top level in crewai>=1.0
    from crewai import LLM  # noqa: E402
except ImportError:  # pragma: no cover - older layouts
    from crewai.llm import LLM  # type: ignore  # noqa: E402

import aep  # noqa: E402
from aep.client import AEPClient  # noqa: E402
from aep.instrument import uninstrument  # noqa: E402


@pytest.fixture
def instrumented():
    """Enable CrewAI instrumentation for one test, then tear it down cleanly."""
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")
    assert aep.instrument(
        server_url=server_url, api_key=api_key, frameworks=["crewai"]
    ), "instrument() failed"
    try:
        yield server_url, api_key
    finally:
        uninstrument()


def test_crew_kickoff_emits_dag_to_server(instrumented):
    server_url, api_key = instrumented

    # Unique marker so we can find this run's orchestrator among existing sessions;
    # the orchestrator source is "agent://<crew name>".
    marker = uuid.uuid4().hex[:8]

    # No OPENAI_API_KEY → the agent's LLM call fails fast; the crew/task/handoff
    # lifecycle still fires and is what we verify landed in the server.
    os.environ.pop("OPENAI_API_KEY", None)

    agent = Agent(
        role="researcher",
        goal="research the topic",
        backstory="a diligent researcher",
        llm=LLM(model="gpt-4o-mini"),
        verbose=False,
    )
    task = Task(description="research AEP", expected_output="notes", agent=agent)
    crew = Crew(agents=[agent], tasks=[task], name=f"itest-{marker}", verbose=False)

    try:
        crew.kickoff()
    except Exception:
        # Expected: the LLM call fails without a key. The lifecycle events still fired.
        pass

    assert aep.flush(timeout=10.0)  # emission is buffered; wait for the POSTs
    time.sleep(0.5)  # allow ingest to settle

    with AEPClient(server_url=server_url, api_key=api_key) as client:
        sessions = client.get_sessions(limit=100).get("sessions", [])
        orch = next(
            (
                s
                for s in sessions
                if s.get("agent_role") == "orchestrator"
                and marker in str(s.get("source", ""))
            ),
            None,
        )
        assert orch is not None, "orchestrator session not recorded by server"

        events = client.get_session_events(orch["session_id"], limit=200).get("events", [])
        types = {e["type"] for e in events}
        # Orchestrator session carries its own task lifecycle plus the handoff to
        # the researcher sub-agent.
        assert "task.created" in types
        assert "handoff.started" in types

        # The workflow view should report more than one session (crew + agent).
        workflow = client.get_workflow(orch["trace_id"])
        assert workflow.get("session_count", 0) >= 2
