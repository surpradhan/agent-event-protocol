"""Integration tests for CrewAI auto-instrumentation.

Run a real ``Crew.kickoff()`` with ``aep.instrument()`` enabled and verify the
events land in a running AEP server with the expected causation structure.

- ``test_crew_kickoff_emits_dag_to_server`` runs the crew **without an LLM API
  key**, so the agent execution fails fast — but the crew/task/handoff lifecycle
  still fires on CrewAI's event bus, which is what we assert was recorded
  (orchestrator task, crew → agent handoff, a multi-session workflow on one trace).
- ``test_tool_call_emits_clean_called_result_pair_to_server`` drives a real tool
  call with a tiny offline scripted LLM so the ``ToolUsage`` events actually fire,
  and asserts the server recorded a linked ``tool.called`` → ``tool.result`` pair.

Both keep the test hermetic: no real model calls, no network beyond the AEP server.

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


# ── Tool pair through the real bus (offline scripted LLM) ────────────────────


def _walk_sessions(tree_node):
    """Yield every session_id in a workflow tree (or forest)."""
    if isinstance(tree_node, list):
        for n in tree_node:
            yield from _walk_sessions(n)
        return
    sess = tree_node.get("session", tree_node)
    sid = sess.get("session_id")
    if sid:
        yield sid
    for child in tree_node.get("children", []):
        yield from _walk_sessions(child)


def test_tool_call_emits_clean_called_result_pair_to_server(instrumented):
    """A real tool call through CrewAI's real bus lands as a linked tool pair.

    Unlike the no-key test above (which never reaches a tool), this drives a
    deterministic tool call with a tiny offline scripted LLM — so the
    ``ToolUsageStarted``/``Finished`` events actually fire on CrewAI's bus and we
    can assert the server recorded a ``tool.called`` → ``tool.result`` pair whose
    causation links resolve. This is the mapping most exposed to CrewAI event
    drift, so we verify it end-to-end rather than only in unit fakes.
    """
    base = pytest.importorskip(
        "crewai.llms.base_llm", reason="crewai BaseLLM not available"
    )
    from crewai.tools import tool as crew_tool

    server_url, api_key = instrumented
    marker = uuid.uuid4().hex[:8]
    os.environ.pop("OPENAI_API_KEY", None)

    @crew_tool("web_search")
    def web_search(query: str) -> str:
        """Search the web and return a short summary."""
        return f"42 sources found for '{query}'"

    class _ScriptLLM(base.BaseLLM):
        """Replays a fixed script: drive one tool call, then a final answer."""

        def __init__(self, responses):
            super().__init__(model="aep-itest-stub")
            self._responses = list(responses)
            self._i = 0

        def call(self, messages, tools=None, callbacks=None, available_functions=None,
                 from_task=None, from_agent=None, response_model=None):
            resp = self._responses[min(self._i, len(self._responses) - 1)]
            self._i += 1
            return resp

        def supports_function_calling(self) -> bool:
            return False

    agent = Agent(
        role="researcher",
        goal="gather sources",
        backstory="a diligent researcher",
        tools=[web_search],
        llm=_ScriptLLM([
            'Thought: search.\nAction: web_search\n'
            'Action Input: {"query": "AI agent observability"}',
            "Thought: done.\nFinal Answer: Found 42 sources.",
        ]),
        verbose=False,
    )
    task = Task(description="research the topic", expected_output="sources", agent=agent)
    crew = Crew(agents=[agent], tasks=[task], name=f"itool-{marker}", verbose=False)

    try:
        crew.kickoff()
    except Exception:
        # Even if the scripted loop doesn't fully satisfy CrewAI, the tool fired.
        pass

    assert aep.flush(timeout=10.0)
    time.sleep(0.5)

    with AEPClient(server_url=server_url, api_key=api_key) as client:
        sessions = client.get_sessions(limit=200).get("sessions", [])
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

        # Gather events across every session in the trace (tools live on the
        # sub-agent/task session, not the orchestrator's).
        workflow = client.get_workflow(orch["trace_id"])
        all_events = []
        for sid in _walk_sessions(workflow.get("tree", [])):
            all_events += client.get_session_events(sid, limit=200).get("events", [])

        called = [e for e in all_events if e["type"] == "tool.called"]
        result = [e for e in all_events if e["type"] == "tool.result"]
        assert called, "no tool.called recorded — did the tool fire on the bus?"
        assert result, "no tool.result recorded — the tool pair did not close"

        # Every result chains off a real tool.called on the same session: a clean,
        # non-dangling pair (the exact fragility flagged in review).
        by_id = {e["id"]: e for e in all_events}
        for res in result:
            cause = by_id.get(res.get("causation_id"))
            assert cause is not None, "tool.result has a dangling causation_id"
            assert cause["type"] == "tool.called"
            assert res["session_id"] == cause["session_id"]
