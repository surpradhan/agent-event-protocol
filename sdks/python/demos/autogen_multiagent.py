"""AutoGen AgentChat multi-agent workflow with AEP auto-instrumentation.

Phase 12d headline demo. A single ``aep.instrument()`` call makes an unmodified
AutoGen ``RoundRobinGroupChat`` team run emit a full AEP event DAG — with **no
other code changes** to the team. The team becomes the orchestrator, each agent
that speaks becomes a sub-agent ``task.*`` reached via a ``handoff.*`` off the
team, and every tool an agent calls becomes a ``tool.called`` / ``tool.result``
pair — all sharing one ``trace_id``.

Team topology (round-robin)::

    team (orchestrator)
      ├─ handoff ─► researcher  ── web_search tool ──┐
      └─ handoff ─► writer                           ▼
                                              (final report, "DONE")

To keep the demo self-contained — runnable in CI and offline with **no LLM API
key** — each agent is driven by ``autogen_ext``'s ``ReplayChatCompletionClient``
with a fixed script: the researcher's first turn is a real ``web_search`` tool
call, and the writer ends the run with ``DONE``. The AutoGen team, its async
event stream, and the AEP instrumentation are all the genuine article; only the
model is replayed. To run against a real model instead, set ``AEP_DEMO_OPENAI=1``
(and an ``OPENAI_API_KEY``) and the demo will use an OpenAI model client.

After running, the demo queries the AEP server and prints the recorded session
tree so you can see the causation chain. If the server is down it still runs the
team and explains how to view results once a server is up.

Run::

    pip install -e "sdks/python[autogen]"
    python demos/autogen_multiagent.py

Set AEP_INGEST_URL / AEP_API_KEY if the server is not at http://localhost:8787.
"""

from __future__ import annotations

import asyncio
import os
import time

import aep

try:
    from autogen_agentchat.agents import AssistantAgent
    from autogen_agentchat.conditions import MaxMessageTermination, TextMentionTermination
    from autogen_agentchat.teams import RoundRobinGroupChat
    from autogen_core import FunctionCall
    from autogen_core.models import (
        CreateResult,
        ModelFamily,
        ModelInfo,
        RequestUsage,
    )
    from autogen_ext.models.replay import ReplayChatCompletionClient
except ImportError:
    raise SystemExit(
        "AutoGen AgentChat is required for this demo. Install it with:\n"
        '  pip install -e "sdks/python[autogen]"'
    )


# ── Tool (emits a tool.called / tool.result pair when the agent uses it) ─────


def web_search(query: str) -> str:
    """Search the web for the given query and return a short result summary."""
    return f"42 sources found for '{query}'"


# ── Offline replay model clients so the demo runs without an API key ─────────


def _model_info(function_calling: bool) -> "ModelInfo":
    return ModelInfo(
        vision=False,
        function_calling=function_calling,
        json_output=False,
        family=ModelFamily.UNKNOWN,
        structured_output=False,
    )


def _researcher_client():
    """A replay client whose first turn is a real ``web_search`` tool call."""
    if os.environ.get("AEP_DEMO_OPENAI") == "1":
        from autogen_ext.models.openai import OpenAIChatCompletionClient

        return OpenAIChatCompletionClient(model="gpt-4o-mini")

    usage = RequestUsage(prompt_tokens=1, completion_tokens=1)
    return ReplayChatCompletionClient(
        [
            CreateResult(
                finish_reason="function_calls",
                content=[
                    FunctionCall(
                        id="call_research_1",
                        name="web_search",
                        arguments='{"query": "AI agent observability"}',
                    )
                ],
                usage=usage,
                cached=False,
            ),
        ],
        model_info=_model_info(function_calling=True),
    )


def _writer_client():
    """A replay client that writes the final report and signals ``DONE``."""
    if os.environ.get("AEP_DEMO_OPENAI") == "1":
        from autogen_ext.models.openai import OpenAIChatCompletionClient

        return OpenAIChatCompletionClient(model="gpt-4o-mini")

    return ReplayChatCompletionClient(
        ["REPORT — AI agent observability: 42 sources, clear themes, ready to ship. DONE"],
        model_info=_model_info(function_calling=False),
    )


# ── Team (no AEP code here on purpose) ───────────────────────────────────────


def build_team() -> "RoundRobinGroupChat":
    """Assemble a 2-agent round-robin research team. No AEP code here."""
    researcher = AssistantAgent(
        "researcher",
        model_client=_researcher_client(),
        tools=[web_search],
        reflect_on_tool_use=False,
        description="A diligent web researcher.",
    )
    writer = AssistantAgent(
        "writer",
        model_client=_writer_client(),
        description="A crisp technical writer.",
    )
    return RoundRobinGroupChat(
        [researcher, writer],
        termination_condition=TextMentionTermination("DONE") | MaxMessageTermination(8),
        name="research-team",
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

    # The entire integration: one line, before running the team.
    if not aep.instrument(server_url=server_url, api_key=api_key, frameworks=["autogen"]):
        print("AEP instrumentation could not be enabled (see warnings above).")

    team = build_team()

    print("\n=== Running 2-agent AutoGen team ===\n")
    result = await team.run(task="Research 'AI agent observability' and write a short report.")

    print("\n=== Done ===")
    print("stop reason:", result.stop_reason)

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
