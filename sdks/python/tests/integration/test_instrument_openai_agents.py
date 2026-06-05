"""Integration tests for OpenAI Agents SDK auto-instrumentation.

Run a real ``Runner.run`` with ``aep.instrument()`` enabled and verify the events
land in a running AEP server with the expected causation structure. Both tests are
hermetic — they drive the run with a scripted offline ``Model`` (a subclass that
returns canned ``ModelResponse``s), so there are **no real model calls and no API
key needed**; the Agents SDK runner, its tracing pipeline, and the AEP
instrumentation are genuine.

- ``test_agent_run_emits_dag_to_server`` runs a 2-agent handoff (triage →
  spanish) and asserts the server recorded an orchestrator task, a handoff, and a
  multi-session workflow on one trace.
- ``test_tool_call_emits_clean_called_result_pair_to_server`` drives a real
  ``get_weather`` tool call (the triage agent's scripted first turn is a function
  call) so a real ``function`` span fires, and asserts the server recorded a
  linked ``tool.called`` → ``tool.result`` pair on the agent's session.

Skipping:
- The whole module skips if ``openai-agents`` is not installed.
- ``conftest.py`` skips every ``integration`` test when the AEP server is
  unreachable, so no per-test server guard is needed here.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest

pytest.importorskip("agents", reason="openai-agents not installed")

from agents import Agent, Model, ModelResponse, Runner, function_tool  # noqa: E402
from agents.tracing import set_trace_processors  # noqa: E402
from agents.usage import Usage  # noqa: E402
from openai.types.responses import (  # noqa: E402
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)

import aep  # noqa: E402
from aep.client import AEPClient  # noqa: E402
from aep.instrument import uninstrument  # noqa: E402


def _message(text: str) -> ResponseOutputMessage:
    return ResponseOutputMessage(
        id="msg",
        content=[ResponseOutputText(text=text, type="output_text", annotations=[])],
        role="assistant",
        status="completed",
        type="message",
    )


def _tool_call(name: str, arguments: str, call_id: str) -> ResponseFunctionToolCall:
    return ResponseFunctionToolCall(
        arguments=arguments, call_id=call_id, name=name, type="function_call", id="fc_" + call_id
    )


class _ScriptedModel(Model):
    """An offline ``Model`` that returns a fixed sequence of outputs, one per turn.

    The whole run shares one instance, so the script advances across agents — the
    supported way to exercise the runner without a live LLM or API key.
    """

    def __init__(self, script: list[list]):
        self._i = 0
        self._script = script

    async def get_response(self, *args, **kwargs) -> ModelResponse:
        output = self._script[self._i] if self._i < len(self._script) else [_message("done")]
        self._i += 1
        return ModelResponse(output=output, usage=Usage(), response_id=None)

    async def stream_response(self, *args, **kwargs):  # pragma: no cover - unused
        raise NotImplementedError


@pytest.fixture
def instrumented():
    """Enable OpenAI Agents instrumentation for one test, then tear it down.

    Clears the SDK's default trace exporter first so the offline run does not try
    to upload traces to OpenAI's backend (which would emit 401 noise); ``aep``'s
    processor is then registered alongside the (now empty) pipeline.
    """
    set_trace_processors([])
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")
    assert aep.instrument(
        server_url=server_url, api_key=api_key, frameworks=["openai-agents"]
    ), "instrument() failed"
    try:
        yield server_url, api_key
    finally:
        uninstrument()
        set_trace_processors([])


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


async def test_agent_run_emits_dag_to_server(instrumented):
    server_url, api_key = instrumented
    marker = uuid.uuid4().hex[:8]

    # Names use underscores (hyphens are sanitized in the handoff tool name) and a
    # hex marker so concurrent runs stay distinguishable on the server.
    spanish_name = f"spanish_{marker}"
    triage_name = f"triage_{marker}"
    model = _ScriptedModel([
        [_tool_call(f"transfer_to_{spanish_name}", "{}", "h1")],  # triage hands off
        [_message("Hola! Informe completo.")],                    # spanish answers
    ])
    spanish = Agent(name=spanish_name, instructions="Respond in Spanish.", model=model)
    triage = Agent(
        name=triage_name,
        instructions="Hand off to the Spanish agent.",
        model=model,
        handoffs=[spanish],
    )

    await Runner.run(triage, "Necesito ayuda en español")

    assert aep.flush(timeout=10.0)  # emission is buffered; wait for the POSTs
    time.sleep(0.5)  # allow ingest to settle

    with AEPClient(server_url=server_url, api_key=api_key) as client:
        sessions = client.get_sessions(limit=200).get("sessions", [])
        # The orchestrator (workflow root) source carries no marker, so locate the
        # run via a marked sub-agent session and pivot on its trace_id.
        sub = next(
            (s for s in sessions if marker in str(s.get("source", ""))), None
        )
        assert sub is not None, "no sub-agent session recorded by server"

        workflow = client.get_workflow(sub["trace_id"])
        assert workflow.get("session_count", 0) >= 2  # workflow + agents

        all_events = []
        for sid in _walk_sessions(workflow.get("tree", [])):
            all_events += client.get_session_events(sid, limit=200).get("events", [])
        types = {e["type"] for e in all_events}
        assert "task.created" in types
        assert "handoff.started" in types
        assert "handoff.completed" in types
        # The spanish sub-agent records the real handoff source in its payload.
        spanish_open = next(
            (
                e
                for e in all_events
                if e["type"] == "task.created" and "spanish" in str(e.get("source", ""))
            ),
            None,
        )
        assert spanish_open is not None
        assert spanish_open["payload"].get("handoff_from") == triage_name

        # The whole trace tree (orchestrator + agents) is internally consistent.
        by_id = {e["id"]: e for e in all_events}
        dangling = [
            e["id"]
            for e in all_events
            if e.get("causation_id") and e["causation_id"] not in by_id
        ]
        assert not dangling, "dangling causation links within the workflow tree"


async def test_tool_call_emits_clean_called_result_pair_to_server(instrumented):
    """A real tool call through the Agents SDK runner lands as a linked
    ``tool.called`` → ``tool.result`` pair on the server."""
    server_url, api_key = instrumented
    marker = uuid.uuid4().hex[:8]

    @function_tool
    def get_weather(city: str) -> str:
        """Return the weather for a city."""
        return f"42 sunny days in {city}"

    model = _ScriptedModel([
        [_tool_call("get_weather", '{"city": "Paris"}', "call_1")],  # tool call
        [_message("It is sunny. DONE")],                              # final answer
    ])
    agent = Agent(
        name=f"weather-{marker}",
        instructions="Use the weather tool.",
        model=model,
        tools=[get_weather],
    )

    await Runner.run(agent, "What's the weather in Paris?")

    assert aep.flush(timeout=10.0)
    time.sleep(0.5)

    with AEPClient(server_url=server_url, api_key=api_key) as client:
        sessions = client.get_sessions(limit=200).get("sessions", [])
        sub = next((s for s in sessions if marker in str(s.get("source", ""))), None)
        assert sub is not None, "no agent session recorded by server"

        workflow = client.get_workflow(sub["trace_id"])
        all_events = []
        for sid in _walk_sessions(workflow.get("tree", [])):
            all_events += client.get_session_events(sid, limit=200).get("events", [])

        called = [e for e in all_events if e["type"] == "tool.called"]
        result = [e for e in all_events if e["type"] == "tool.result"]
        assert called, "no tool.called recorded — did the tool fire?"
        assert result, "no tool.result recorded — the tool pair did not close"

        by_id = {e["id"]: e for e in all_events}
        for res in result:
            cause = by_id.get(res.get("causation_id"))
            assert cause is not None, "tool.result has a dangling causation_id"
            assert cause["type"] == "tool.called"
            assert res["session_id"] == cause["session_id"]
        assert any(e["payload"].get("tool_name") == "get_weather" for e in called)
