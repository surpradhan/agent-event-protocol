"""Python port of examples/demos/subagent-research-demo.js.

Demonstrates a multi-agent research workflow using AEP v0.2.0:

  orchestrator  (ses_orch_*)
  ├─ sub-agent: web retrieval      (ses_ret_web_*)
  ├─ sub-agent: arXiv retrieval    (ses_ret_arxiv_*)
  └─ sub-agent: patent retrieval   (ses_ret_patents_*)

All sessions share a single trace_id.  After emitting, the demo exercises:
  GET /sessions/:id/tree   — reconstructs the orchestrator's descendant tree
  GET /workflows/:traceId  — full multi-agent workflow view
  GET /metrics             — shows workflow_count / max_tree_depth

Run::

    python demos/subagent_research.py

Set AEP_INGEST_URL and AEP_API_KEY environment variables if the server is not
running at http://localhost:8787.
"""

from __future__ import annotations

import json
import os
import uuid

from aep import create_event
from aep.client import AEPClient

# ── session IDs — UUID-based to prevent collisions in CI or rapid reruns ───────

_uid = uuid.uuid4().hex[:12]
ORCH_SESSION = f"ses_orch_{_uid}"
WEB_SESSION = f"ses_ret_web_{_uid}"
ARXIV_SESSION = f"ses_ret_arxiv_{_uid}"
PATENT_SESSION = f"ses_ret_patents_{_uid}"
TRACE_ID = f"trc_multiagent_{_uid}"

# ── shared envelope bases ──────────────────────────────────────────────────────

def _base(session_id: str, source: str, agent_role: str, parent_session_id: str | None = None):
    kwargs: dict = dict(source=source, session_id=session_id, trace_id=TRACE_ID, agent_role=agent_role)
    if parent_session_id:
        kwargs["parent_session_id"] = parent_session_id
    return kwargs


ORCH = _base(ORCH_SESSION, "agent://research-orchestrator", "orchestrator")
WEB = _base(WEB_SESSION, "agent://retrieval-web", "subagent", ORCH_SESSION)
ARXIV = _base(ARXIV_SESSION, "agent://retrieval-arxiv", "subagent", ORCH_SESSION)
PATENT = _base(PATENT_SESSION, "agent://retrieval-patents", "subagent", ORCH_SESSION)


# ── event builders ─────────────────────────────────────────────────────────────

def build_orchestrator_start():
    e1 = create_event(
        **ORCH,
        type="task.created",
        payload={
            "objective": "Comprehensive landscape report: AI agent observability",
            "subtasks": ["web-search", "arxiv-search", "patent-search"],
            "output_format": "executive-briefing",
        },
    )
    e2 = create_event(
        **ORCH,
        type="handoff.started",
        causation_id=e1["id"],
        payload={
            "from_agent": "research-orchestrator",
            "to_team": "retrieval-subagents",
            "handoff_reason": "parallel retrieval across web, arXiv, and patents",
            "sub_sessions": [WEB_SESSION, ARXIV_SESSION, PATENT_SESSION],
        },
    )
    return e1, e2


def build_web_retrieval_events(causation_id: str):
    e1 = create_event(
        **WEB,
        type="task.created",
        causation_id=causation_id,
        payload={"query": "AI agent observability vendors 2025", "source_type": "web"},
    )
    e2 = create_event(
        **WEB,
        type="tool.called",
        causation_id=e1["id"],
        payload={
            "$schema": "https://aep.dev/schemas/payloads/tool-called.schema.json",
            "tool_name": "web.search",
            "arguments": {"query": "AI agent observability vendors 2025", "limit": 10},
        },
    )
    e3 = create_event(
        **WEB,
        type="tool.result",
        causation_id=e2["id"],
        payload={
            "tool_name": "web.search",
            "output": {"hits": 8, "urls": [
                "https://example.com/vendor-a",
                "https://example.com/vendor-b",
                "https://example.com/vendor-c",
            ]},
        },
    )
    e4 = create_event(
        **WEB,
        type="task.completed",
        causation_id=e3["id"],
        payload={
            "result_count": 8,
            "top_snippet": "Vendors differentiate on replay, policy controls, and multi-agent tracing",
        },
    )
    return [e1, e2, e3, e4]


def build_arxiv_retrieval_events(causation_id: str):
    e1 = create_event(
        **ARXIV,
        type="task.created",
        causation_id=causation_id,
        payload={"query": "LLM agent tracing observability", "source_type": "arxiv"},
    )
    e2 = create_event(
        **ARXIV,
        type="tool.called",
        causation_id=e1["id"],
        payload={
            "tool_name": "arxiv.search",
            "arguments": {"query": "LLM agent tracing observability", "max_results": 5},
        },
    )
    e3 = create_event(
        **ARXIV,
        type="tool.result",
        causation_id=e2["id"],
        payload={
            "tool_name": "arxiv.search",
            "output": {"papers": [
                {"title": "Trace-Aware LLM Agents", "arxiv_id": "2401.00001"},
                {"title": "Observability for Multi-Agent Systems", "arxiv_id": "2402.00002"},
            ]},
        },
    )
    e4 = create_event(
        **ARXIV,
        type="task.completed",
        causation_id=e3["id"],
        payload={
            "result_count": 2,
            "key_finding": "Distributed tracing with W3C TraceContext is the dominant academic proposal",
        },
    )
    return [e1, e2, e3, e4]


def build_patent_retrieval_events(causation_id: str):
    e1 = create_event(
        **PATENT,
        type="task.created",
        causation_id=causation_id,
        payload={"query": "AI agent execution tracing logging", "source_type": "patents"},
    )
    e2 = create_event(
        **PATENT,
        type="tool.called",
        causation_id=e1["id"],
        payload={
            "tool_name": "patent.search",
            "arguments": {"query": "AI agent execution tracing", "jurisdiction": "US", "limit": 5},
        },
    )
    e3 = create_event(
        **PATENT,
        type="tool.result",
        causation_id=e2["id"],
        payload={
            "tool_name": "patent.search",
            "output": {"results": [
                {"title": "Method for distributed agent telemetry", "patent_id": "US20250000001"}
            ]},
        },
    )
    e4 = create_event(
        **PATENT,
        type="task.completed",
        causation_id=e3["id"],
        payload={
            "result_count": 1,
            "coverage": "thin — patent landscape still early",
        },
    )
    return [e1, e2, e3, e4]


def build_orchestrator_synthesis(handoff_id: str, sub_results: list):
    e_mem = create_event(
        **ORCH,
        type="memory.write",
        causation_id=handoff_id,
        payload={
            "note_id": "synthesis-memo-1",
            "sources": sub_results,
            "summary": "Web: 8 vendors; arXiv: distributed-trace proposals dominant; Patents: thin landscape",
        },
    )
    e_done_handoff = create_event(
        **ORCH,
        type="handoff.completed",
        causation_id=e_mem["id"],
        payload={
            "from_team": "retrieval-subagents",
            "to_agent": "research-orchestrator",
            "status": "all_sub_agents_complete",
        },
    )
    e_complete = create_event(
        **ORCH,
        type="task.completed",
        causation_id=e_done_handoff["id"],
        payload={
            "deliverable": "5-page executive briefing",
            "confidence": "high",
            "sub_sessions_used": [WEB_SESSION, ARXIV_SESSION, PATENT_SESSION],
        },
    )
    return [e_mem, e_done_handoff, e_complete]


# ── tree printer ───────────────────────────────────────────────────────────────

def print_tree(node: dict, indent: int = 0) -> None:
    pad = "  " * indent
    session = node.get("session", node)
    session_id = session.get("session_id", "?")
    role = f" [{session.get('agent_role')}]" if session.get("agent_role") else ""
    count = session.get("event_count", "?")
    print(f"{pad}├─ {session_id}{role}  ({count} events)")
    for child in node.get("children", []):
        print_tree(child, indent + 1)


# ── main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")

    # 1. Build all events
    orch_start, orch_handoff = build_orchestrator_start()
    web_events = build_web_retrieval_events(orch_handoff["id"])
    arxiv_events = build_arxiv_retrieval_events(orch_handoff["id"])
    patent_events = build_patent_retrieval_events(orch_handoff["id"])
    synth_events = build_orchestrator_synthesis(
        orch_handoff["id"],
        [
            {"session": WEB_SESSION, "result": web_events[-1]["payload"]},
            {"session": ARXIV_SESSION, "result": arxiv_events[-1]["payload"]},
            {"session": PATENT_SESSION, "result": patent_events[-1]["payload"]},
        ],
    )

    all_events = [
        orch_start, orch_handoff,
        *web_events, *arxiv_events, *patent_events,
        *synth_events,
    ]

    # 2. Emit
    with AEPClient(server_url=server_url, api_key=api_key) as client:
        results = client.emit_batch(all_events)

        print("\n=== Emit results ===")
        print(json.dumps({
            "scenario": "subagent-research",
            "topology": {
                "orchestrator": ORCH_SESSION,
                "subagents": {
                    "web": WEB_SESSION,
                    "arxiv": ARXIV_SESSION,
                    "patents": PATENT_SESSION,
                },
            },
            "trace_id": TRACE_ID,
            "results": results,
        }, indent=2))

        # 3. Session tree
        print(f"\n=== GET /sessions/{ORCH_SESSION}/tree ===")
        tree = client.get_session_tree(ORCH_SESSION)
        print_tree(tree)
        print(json.dumps(tree, indent=2))

        # 4. Workflow view
        print(f"\n=== GET /workflows/{TRACE_ID} ===")
        workflow = client.get_workflow(TRACE_ID)
        print(f"trace_id:      {workflow['trace_id']}")
        print(f"session_count: {workflow['session_count']}")
        print("Workflow tree:")
        for root in workflow.get("tree", []):
            print_tree(root)

        # 5. Metrics
        print("\n=== GET /metrics ===")
        metrics = client.get_metrics()
        print(json.dumps({
            k: metrics[k]
            for k in ("session_count", "workflow_count", "subagent_session_count",
                       "max_tree_depth", "accepted", "received")
            if k in metrics
        }, indent=2))


if __name__ == "__main__":
    main()
