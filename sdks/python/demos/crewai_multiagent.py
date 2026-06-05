"""CrewAI multi-agent workflow with AEP auto-instrumentation.

Phase 12c headline demo. A single ``aep.instrument()`` call makes an unmodified
CrewAI ``Crew.kickoff()`` emit a full AEP event DAG — with **no other code
changes** to the crew. The crew becomes the orchestrator, each task its assigned
agent runs becomes a sub-agent ``task.*`` reached via a ``handoff.*`` off the
crew, and every tool the agents call becomes a ``tool.called`` / ``tool.result``
pair — all sharing one ``trace_id``.

Crew topology (sequential)::

    crew (orchestrator)
      ├─ handoff ─► researcher  ── web_search tool ──┐
      ├─ handoff ─► analyst     ── word_count tool ──┤
      └─ handoff ─► writer                           ▼
                                              (final report)

To keep the demo self-contained — runnable in CI and offline with **no LLM API
key** — each agent is given a tiny scripted stub LLM (``_ScriptLLM``) that drives
a real tool call and then returns a final answer. The CrewAI execution, event
bus, and AEP instrumentation are all the genuine article; only the model is
stubbed. To run against a real model instead, set ``AEP_DEMO_OPENAI=1`` (and an
``OPENAI_API_KEY``) and the demo will use CrewAI's default LLM.

After running, the demo queries the AEP server and prints the recorded session
tree so you can see the causation chain. If the server is down it still runs the
crew and explains how to view results once a server is up.

Run::

    pip install -e "sdks/python[crewai]"
    python demos/crewai_multiagent.py

Set AEP_INGEST_URL / AEP_API_KEY if the server is not at http://localhost:8787.
"""

from __future__ import annotations

import os
import time

import aep

try:
    from crewai import Agent, Crew, Task
    from crewai.tools import tool
except ImportError:
    raise SystemExit(
        "CrewAI is required for this demo. Install it with:\n"
        '  pip install -e "sdks/python[crewai]"'
    )


# ── Tools (each emits a tool.called / tool.result pair when an agent uses it) ─


@tool("web_search")
def web_search(query: str) -> str:
    """Search the web for the given query and return a short result summary."""
    return f"42 sources found for '{query}'"


@tool("word_count")
def word_count(text: str) -> str:
    """Count the number of words in the given text."""
    return str(len(text.split()))


# ── Offline stub LLM so the demo runs without an API key ─────────────────────


def _build_llm(script: list[str]):
    """Return a scripted offline LLM, or CrewAI's default LLM if asked for a real one."""
    if os.environ.get("AEP_DEMO_OPENAI") == "1":
        from crewai import LLM

        return LLM(model="gpt-4o-mini")

    from crewai.llms.base_llm import BaseLLM

    class _ScriptLLM(BaseLLM):
        """Replays a fixed list of responses, one per call (clamps on the last).

        Just enough to drive CrewAI's ReAct loop deterministically: an ``Action``
        response triggers a real tool call; a ``Final Answer`` ends the task.
        """

        def __init__(self, responses: list[str]) -> None:
            super().__init__(model="aep-demo-stub")
            self._responses = list(responses)
            self._i = 0

        def call(self, messages, tools=None, callbacks=None, available_functions=None,
                 from_task=None, from_agent=None, response_model=None):
            response = self._responses[min(self._i, len(self._responses) - 1)]
            self._i += 1
            return response

        def supports_function_calling(self) -> bool:
            return False

    return _ScriptLLM(script)


# ── Crew (no AEP code here on purpose) ───────────────────────────────────────


def build_crew() -> Crew:
    """Assemble a 3-agent sequential research crew. No AEP code here."""
    researcher = Agent(
        role="researcher",
        goal="gather sources on the topic",
        backstory="A diligent web researcher.",
        tools=[web_search],
        llm=_build_llm([
            'Thought: I should search the web.\n'
            'Action: web_search\nAction Input: {"query": "AI agent observability"}',
            "Thought: I have enough.\nFinal Answer: Found 42 sources on AI agent observability.",
        ]),
        verbose=False,
    )
    analyst = Agent(
        role="analyst",
        goal="analyze the gathered material",
        backstory="A sharp analyst who quantifies findings.",
        tools=[word_count],
        llm=_build_llm([
            'Thought: Let me measure the summary.\n'
            'Action: word_count\nAction Input: {"text": "agent observability is a growing field"}',
            "Thought: Done.\nFinal Answer: The summary is concise (6 words); themes are clear.",
        ]),
        verbose=False,
    )
    writer = Agent(
        role="writer",
        goal="write the final report",
        backstory="A crisp technical writer.",
        llm=_build_llm([
            "Thought: I can write the report now.\n"
            "Final Answer: REPORT — AI agent observability: 42 sources, clear themes, ready to ship.",
        ]),
        verbose=False,
    )

    research_task = Task(
        description="Research the topic 'AI agent observability'.",
        expected_output="A list of sources.",
        agent=researcher,
    )
    analysis_task = Task(
        description="Analyze the research findings.",
        expected_output="A short analysis.",
        agent=analyst,
    )
    writing_task = Task(
        description="Write the final report from the analysis.",
        expected_output="A polished report.",
        agent=writer,
    )

    return Crew(
        agents=[researcher, analyst, writer],
        tasks=[research_task, analysis_task, writing_task],
        name="research-crew",
        verbose=False,
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


def main() -> None:
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")

    # The entire integration: one line, before running the crew.
    if not aep.instrument(server_url=server_url, api_key=api_key, frameworks=["crewai"]):
        print("AEP instrumentation could not be enabled (see warnings above).")

    crew = build_crew()

    print("\n=== Running 3-agent CrewAI workflow ===\n")
    result = crew.kickoff()

    print("\n=== Done ===")
    print("final:", str(result)[:200])

    aep.flush(timeout=10.0)  # emission is buffered on a background thread
    time.sleep(0.3)
    print("\n=== AEP workflow (from server) ===")
    _print_workflow(server_url, api_key)
    print("\nOpen the dashboard to replay the causation DAG: "
          f"{server_url}/dashboard")


if __name__ == "__main__":
    main()
