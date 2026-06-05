"""Integration tests for AutoGen AgentChat auto-instrumentation.

Run a real ``RoundRobinGroupChat`` team with ``aep.instrument()`` enabled and
verify the events land in a running AEP server with the expected causation
structure. Both tests are hermetic — they drive the team with ``autogen_ext``'s
``ReplayChatCompletionClient`` (a scripted offline model), so there are **no real
model calls and no API key needed**; the AutoGen team, its async event stream,
and the AEP instrumentation are genuine.

- ``test_team_run_emits_dag_to_server`` runs a 2-agent team and asserts the
  server recorded an orchestrator task, a team → agent handoff, and a
  multi-session workflow on one trace.
- ``test_tool_call_emits_clean_called_result_pair_to_server`` drives a real
  ``web_search`` tool call (the researcher's scripted first turn is a function
  call) so the ``ToolCallRequestEvent`` / ``ToolCallExecutionEvent`` pair fires
  on the real stream, and asserts the server recorded a linked
  ``tool.called`` → ``tool.result`` pair.

Skipping:
- The whole module skips if ``autogen-agentchat`` / ``autogen-ext`` is not installed.
- ``conftest.py`` skips every ``integration`` test when the AEP server is
  unreachable, so no per-test server guard is needed here.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest

pytest.importorskip("autogen_agentchat", reason="autogen-agentchat not installed")
pytest.importorskip("autogen_ext", reason="autogen-ext not installed")

from autogen_agentchat.agents import AssistantAgent  # noqa: E402
from autogen_agentchat.conditions import (  # noqa: E402
    MaxMessageTermination,
    TextMentionTermination,
)
from autogen_agentchat.teams import RoundRobinGroupChat  # noqa: E402
from autogen_core import FunctionCall  # noqa: E402
from autogen_core.models import (  # noqa: E402
    CreateResult,
    ModelFamily,
    ModelInfo,
    RequestUsage,
)
from autogen_ext.models.replay import ReplayChatCompletionClient  # noqa: E402

import aep  # noqa: E402
from aep.client import AEPClient  # noqa: E402
from aep.instrument import uninstrument  # noqa: E402


def _model_info(function_calling: bool) -> ModelInfo:
    return ModelInfo(
        vision=False,
        function_calling=function_calling,
        json_output=False,
        family=ModelFamily.UNKNOWN,
        structured_output=False,
    )


@pytest.fixture
def instrumented():
    """Enable AutoGen instrumentation for one test, then tear it down cleanly."""
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")
    assert aep.instrument(
        server_url=server_url, api_key=api_key, frameworks=["autogen"]
    ), "instrument() failed"
    try:
        yield server_url, api_key
    finally:
        uninstrument()


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


async def test_team_run_emits_dag_to_server(instrumented):
    server_url, api_key = instrumented
    marker = uuid.uuid4().hex[:8]

    researcher = AssistantAgent(
        "researcher",
        model_client=ReplayChatCompletionClient(
            ["Researcher: gathered the sources."],
            model_info=_model_info(function_calling=False),
        ),
        description="a diligent researcher",
    )
    writer = AssistantAgent(
        "writer",
        model_client=ReplayChatCompletionClient(
            ["Writer: report complete. DONE"],
            model_info=_model_info(function_calling=False),
        ),
        description="a crisp writer",
    )
    team = RoundRobinGroupChat(
        [researcher, writer],
        termination_condition=TextMentionTermination("DONE") | MaxMessageTermination(8),
        name=f"itest-{marker}",
    )

    await team.run(task="research and write")

    assert aep.flush(timeout=10.0)  # emission is buffered; wait for the POSTs
    time.sleep(0.5)  # allow ingest to settle

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

        events = client.get_session_events(orch["session_id"], limit=200).get("events", [])
        types = {e["type"] for e in events}
        # Orchestrator session carries its own task lifecycle plus handoffs to the
        # sub-agents.
        assert "task.created" in types
        assert "handoff.started" in types

        # The workflow view should report more than one session (team + agents).
        workflow = client.get_workflow(orch["trace_id"])
        assert workflow.get("session_count", 0) >= 2


async def test_tool_call_emits_clean_called_result_pair_to_server(instrumented):
    """A real tool call through AutoGen's real event stream lands as a linked
    ``tool.called`` → ``tool.result`` pair on the server.

    The researcher's scripted first turn is a ``web_search`` function call, so the
    ``ToolCallRequestEvent`` / ``ToolCallExecutionEvent`` pair actually fires on
    the stream. AutoGen matches the execution to its request by ``call_id``, so we
    assert the recorded pair's causation links resolve cleanly.
    """
    server_url, api_key = instrumented
    marker = uuid.uuid4().hex[:8]

    def web_search(query: str) -> str:
        """Search the web and return a short summary."""
        return f"42 sources found for '{query}'"

    usage = RequestUsage(prompt_tokens=1, completion_tokens=1)
    researcher = AssistantAgent(
        "researcher",
        model_client=ReplayChatCompletionClient(
            [
                CreateResult(
                    finish_reason="function_calls",
                    content=[
                        FunctionCall(
                            id="call_1",
                            name="web_search",
                            arguments='{"query": "AI agent observability"}',
                        )
                    ],
                    usage=usage,
                    cached=False,
                ),
            ],
            model_info=_model_info(function_calling=True),
        ),
        tools=[web_search],
        reflect_on_tool_use=False,
        description="a diligent researcher",
    )
    writer = AssistantAgent(
        "writer",
        model_client=ReplayChatCompletionClient(
            ["Writer: done. DONE"],
            model_info=_model_info(function_calling=False),
        ),
        description="a crisp writer",
    )
    team = RoundRobinGroupChat(
        [researcher, writer],
        termination_condition=TextMentionTermination("DONE") | MaxMessageTermination(8),
        name=f"itool-{marker}",
    )

    await team.run(task="research the topic and write it up")

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

        # Tools live on the sub-agent (researcher) session, not the orchestrator's.
        workflow = client.get_workflow(orch["trace_id"])
        all_events = []
        for sid in _walk_sessions(workflow.get("tree", [])):
            all_events += client.get_session_events(sid, limit=200).get("events", [])

        called = [e for e in all_events if e["type"] == "tool.called"]
        result = [e for e in all_events if e["type"] == "tool.result"]
        assert called, "no tool.called recorded — did the tool fire on the stream?"
        assert result, "no tool.result recorded — the tool pair did not close"

        by_id = {e["id"]: e for e in all_events}
        for res in result:
            cause = by_id.get(res.get("causation_id"))
            assert cause is not None, "tool.result has a dangling causation_id"
            assert cause["type"] == "tool.called"
            assert res["session_id"] == cause["session_id"]
        assert any(e["payload"].get("tool_name") == "web_search" for e in called)
