"""LangGraph multi-agent workflow with AEP auto-instrumentation.

Phase 12b headline demo. A single ``aep.instrument()`` call makes a 10-node
LangGraph research workflow emit a full AEP event DAG — with **no other code
changes** to the graph. Each node becomes a sub-agent ``task.*``, every
node a ``handoff.*`` off the orchestrator, and tool calls a ``tool.called`` /
``tool.result`` pair, all sharing one ``trace_id``.

Graph topology (10 nodes)::

    orchestrator
      ├─ web_research ─────┐
      ├─ academic_research ┤
      └─ patent_research ──┤
                           ▼
                     synthesize ──► fact_check ──► risk_review
                           │                            │
                           └────────────► editor ◄──────┘
                                            │
                                          publish

After running, the demo queries the AEP server and prints the recorded session
tree so you can see the causation chain. If the server is down it still runs the
graph and explains how to view results once a server is up.

Run::

    pip install -e "sdks/python[langgraph]"
    python demos/langgraph_multiagent.py

Set AEP_INGEST_URL / AEP_API_KEY if the server is not at http://localhost:8787.
"""

from __future__ import annotations

import os
import time
from typing import Annotated, TypedDict

import aep

try:
    from langgraph.graph import END, START, StateGraph
    from langgraph.graph.message import add_messages  # noqa: F401  (ensures langgraph>=0.1)
except ImportError:
    raise SystemExit(
        "LangGraph is required for this demo. Install it with:\n"
        '  pip install -e "sdks/python[langgraph]"'
    )


# ── Shared graph state ───────────────────────────────────────────────────────
# Lists use a reducer so parallel branches can append concurrently without
# clobbering each other (LangGraph merges via the annotated reducer).


def _extend(left: list, right: list) -> list:
    return (left or []) + (right or [])


class ResearchState(TypedDict, total=False):
    topic: str
    findings: Annotated[list, _extend]
    draft: str
    issues: Annotated[list, _extend]
    final: str


# ── Nodes (each is a "sub-agent") ────────────────────────────────────────────


def orchestrator(state: ResearchState) -> dict:
    print(f"[orchestrator] kicking off research on: {state['topic']}")
    return {"findings": []}


def web_research(state: ResearchState) -> dict:
    time.sleep(0.05)
    print("[web_research] searching the web")
    return {"findings": [f"web: 42 sources on {state['topic']}"]}


def academic_research(state: ResearchState) -> dict:
    time.sleep(0.05)
    print("[academic_research] searching papers")
    return {"findings": [f"academic: 12 papers on {state['topic']}"]}


def patent_research(state: ResearchState) -> dict:
    time.sleep(0.05)
    print("[patent_research] searching patents")
    return {"findings": [f"patent: 3 filings on {state['topic']}"]}


def synthesize(state: ResearchState) -> dict:
    print(f"[synthesize] merging {len(state.get('findings', []))} findings")
    return {"draft": "DRAFT: " + " | ".join(state.get("findings", []))}


def fact_check(state: ResearchState) -> dict:
    time.sleep(0.05)
    print("[fact_check] verifying claims")
    issues = [] if state.get("draft") else ["empty draft"]
    return {"issues": issues}


def risk_review(state: ResearchState) -> dict:
    time.sleep(0.05)
    print("[risk_review] checking for risks")
    return {"issues": []}


def editor(state: ResearchState) -> dict:
    print("[editor] polishing the draft")
    blocking = state.get("issues", [])
    if blocking:
        return {"final": f"REVISE — open issues: {blocking}"}
    return {"final": state.get("draft", "").replace("DRAFT:", "REPORT:")}


def publish(state: ResearchState) -> dict:
    print("[publish] distributing report")
    return {}


def build_graph():
    """Assemble the 10-node research graph. No AEP code here on purpose."""
    g = StateGraph(ResearchState)
    for name, fn in [
        ("orchestrator", orchestrator),
        ("web_research", web_research),
        ("academic_research", academic_research),
        ("patent_research", patent_research),
        ("synthesize", synthesize),
        ("fact_check", fact_check),
        ("risk_review", risk_review),
        ("editor", editor),
        ("publish", publish),
    ]:
        g.add_node(name, fn)

    g.add_edge(START, "orchestrator")
    # Fan out to three researchers in parallel.
    for r in ("web_research", "academic_research", "patent_research"):
        g.add_edge("orchestrator", r)
        g.add_edge(r, "synthesize")
    # Synthesis fans out to two reviewers, then both feed the editor.
    g.add_edge("synthesize", "fact_check")
    g.add_edge("synthesize", "risk_review")
    g.add_edge("fact_check", "editor")
    g.add_edge("risk_review", "editor")
    g.add_edge("editor", "publish")
    g.add_edge("publish", END)
    return g


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

    # The entire integration: one line, before running the graph.
    if not aep.instrument(server_url=server_url, api_key=api_key):
        print("AEP instrumentation could not be enabled (see warnings above).")

    graph = build_graph()
    app = graph.compile()
    app.name = "research-orchestration"

    print("\n=== Running 10-node LangGraph workflow ===\n")
    result = app.invoke({"topic": "AI agent observability"})

    print("\n=== Done ===")
    print("final:", result.get("final"))

    time.sleep(0.5)  # let async emits flush
    print("\n=== AEP workflow (from server) ===")
    _print_workflow(server_url, api_key)
    print("\nOpen the dashboard to replay the causation DAG: "
          f"{server_url}/dashboard")


if __name__ == "__main__":
    main()
