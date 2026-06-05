"""OpenAI Agents SDK multi-agent workflow with AEP auto-instrumentation.

Phase 12e headline demo. A single ``aep.instrument()`` call makes an unmodified
OpenAI Agents SDK ``Runner.run`` emit a full AEP event DAG — with **no other code
changes** to the agents. The run's trace becomes the orchestrator, each agent
becomes a sub-agent ``task.*`` reached via a ``handoff.*`` off the workflow root,
and every tool an agent calls becomes a ``tool.called`` / ``tool.result`` pair —
all sharing one ``trace_id``. The real handoff source is preserved on the
handed-to agent's payload as ``handoff_from``.

Topology::

    workflow (orchestrator)
      ├─ handoff ─► triage   ── get_weather tool ──┐
      └─ handoff ─► spanish  ◄── handoff_from: triage
                                 (final answer, in Spanish)

To keep the demo self-contained — runnable in CI and offline with **no LLM API
key** — the run is driven by a scripted offline ``Model`` that returns canned
responses: triage calls ``get_weather`` then hands off to the Spanish agent,
which writes the final answer. The Agents SDK runner, its tracing pipeline, and
the AEP instrumentation are all the genuine article; only the model is scripted.
To run against a real model instead, set ``AEP_DEMO_OPENAI=1`` (and an
``OPENAI_API_KEY``) and the demo will let each agent use its default model.

After running, the demo queries the AEP server and prints the recorded session
tree so you can see the causation chain. If the server is down it still runs the
agents and explains how to view results once a server is up.

Run::

    pip install -e "sdks/python[openai-agents]"
    python demos/openai_agents_multiagent.py

Set AEP_INGEST_URL / AEP_API_KEY if the server is not at http://localhost:8787.
"""

from __future__ import annotations

import asyncio
import os
import time

import aep

try:
    from agents import Agent, Model, ModelResponse, Runner, function_tool
    from agents.tracing import set_trace_processors
    from agents.usage import Usage
    from openai.types.responses import (
        ResponseFunctionToolCall,
        ResponseOutputMessage,
        ResponseOutputText,
    )
except ImportError:
    raise SystemExit(
        "The OpenAI Agents SDK is required for this demo. Install it with:\n"
        '  pip install -e "sdks/python[openai-agents]"'
    )


# ── Tool (emits a tool.called / tool.result pair when the agent uses it) ─────


@function_tool
def get_weather(city: str) -> str:
    """Return a short weather summary for the given city."""
    return f"It is sunny in {city}, 24°C."


# ── Offline scripted model so the demo runs without an API key ───────────────


def _message(text: str) -> "ResponseOutputMessage":
    return ResponseOutputMessage(
        id="msg",
        content=[ResponseOutputText(text=text, type="output_text", annotations=[])],
        role="assistant",
        status="completed",
        type="message",
    )


def _tool_call(name: str, arguments: str, call_id: str) -> "ResponseFunctionToolCall":
    return ResponseFunctionToolCall(
        arguments=arguments, call_id=call_id, name=name, type="function_call", id="fc_" + call_id
    )


class _ScriptedModel(Model):
    """An offline ``Model`` returning a fixed sequence of outputs, one per turn."""

    def __init__(self, script):
        self._i = 0
        self._script = script

    async def get_response(self, *args, **kwargs):
        output = self._script[self._i] if self._i < len(self._script) else [_message("done")]
        self._i += 1
        return ModelResponse(output=output, usage=Usage(), response_id=None)

    async def stream_response(self, *args, **kwargs):  # pragma: no cover - unused
        raise NotImplementedError


# ── Agents (no AEP code here on purpose) ─────────────────────────────────────


def build_triage_agent() -> "Agent":
    """Assemble a triage agent that calls a tool then hands off to a Spanish
    agent. No AEP code here."""
    use_real_model = os.environ.get("AEP_DEMO_OPENAI") == "1"
    model = None if use_real_model else _ScriptedModel(
        [
            [_tool_call("get_weather", '{"city": "Paris"}', "call_1")],  # triage: tool
            [_tool_call("transfer_to_spanish_agent", "{}", "handoff_1")],  # triage: handoff
            [_message("¡Hola! Hace sol en París, 24°C.")],               # spanish: answer
        ]
    )
    spanish = Agent(
        name="spanish_agent",
        instructions="You only respond in Spanish.",
        model=model,
    )
    return Agent(
        name="triage_agent",
        instructions="Check the weather, then hand off to the Spanish agent.",
        model=model,
        tools=[get_weather],
        handoffs=[spanish],
    )


# ── Server-side verification (best effort) ──────────────────────────────────


def _print_workflow(server_url: str, api_key: str | None) -> None:
    from aep.client import AEPClient

    try:
        with AEPClient(server_url=server_url, api_key=api_key) as client:
            sessions = client.get_sessions(limit=50).get("sessions", [])
            orch = next(
                (s for s in sessions if s.get("agent_role") == "orchestrator"), None
            )
            if not orch:
                print("No orchestrator session found yet — is the server running?")
                return
            print(f"\nOrchestrator session: {orch['session_id']}")
            tree = client.get_session_tree(orch["session_id"])

            def walk(node, depth=0):
                sess = node.get("session", node)
                role = sess.get("agent_role", "?")
                print(
                    f"  {'  ' * depth}└─ {sess.get('session_id', '?')} "
                    f"[{role}] ({sess.get('event_count', '?')} events)"
                )
                for child in node.get("children", []):
                    walk(child, depth + 1)

            walk(tree)
    except Exception as e:
        print(f"\nServer verification skipped ({e}).")
        print("Start a server with `npm run ingest`, then re-run to see the DAG.")


async def main() -> None:
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")

    # Offline demo: clear the SDK's default trace exporter so the run does not try
    # to upload traces to OpenAI's backend. (Skip this when using a real model.)
    if os.environ.get("AEP_DEMO_OPENAI") != "1":
        set_trace_processors([])

    # The entire integration: one line, before running the agents.
    if not aep.instrument(
        server_url=server_url, api_key=api_key, frameworks=["openai-agents"]
    ):
        print("AEP instrumentation could not be enabled (see warnings above).")

    triage = build_triage_agent()

    print("\n=== Running OpenAI Agents handoff workflow ===\n")
    result = await Runner.run(triage, "¿Qué tiempo hace en París? Respóndeme en español.")

    print("\n=== Done ===")
    print("final output:", result.final_output)

    aep.flush(timeout=10.0)  # emission is buffered on a background thread
    time.sleep(0.3)
    print("\n=== AEP workflow (from server) ===")
    _print_workflow(server_url, api_key)
    print(
        "\nOpen the dashboard to replay the causation DAG: "
        f"{server_url}/dashboard"
    )


if __name__ == "__main__":
    asyncio.run(main())
