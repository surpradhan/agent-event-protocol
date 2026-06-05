"""Integration tests for Anthropic Claude Agent SDK auto-instrumentation.

Two tests, matching the strategy agreed for this framework:

1. ``test_hermetic_query_hooks_emit_dag_to_server`` — fully hermetic (no API key,
   no network, no ``claude`` binary). It drives a **real** ``query()`` with a
   custom ``Transport`` that emulates the CLI control protocol: it replies to the
   SDK's ``initialize`` request, then sends scripted ``hook_callback`` control
   requests so the AEP hooks the instrumentor injected actually fire through the
   SDK's real control dispatch, then a terminal ``result``. Asserts the
   reconstructed DAG on a running AEP server. This exercises the genuine wiring
   (hook injection → SDK registration → SDK dispatch → our mapping) offline.

2. ``test_real_query_emits_to_server`` — runs a real ``query()`` against the real
   ``claude`` binary; auto-skips unless ``ANTHROPIC_API_KEY`` is set (the live
   path can't run in CI without a key, like 'auto-skip when server unreachable').

Skipping:
- The whole module skips if ``claude-agent-sdk`` is not installed.
- ``conftest.py`` skips every ``integration`` test when the AEP server is
  unreachable, so no per-test server guard is needed here.
"""

from __future__ import annotations

import asyncio
import json
import os
import time

import pytest

pytest.importorskip("claude_agent_sdk", reason="claude-agent-sdk not installed")

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query  # noqa: E402
from claude_agent_sdk._internal.transport import Transport  # noqa: E402

import aep  # noqa: E402
from aep.client import AEPClient  # noqa: E402
from aep.instrument import uninstrument  # noqa: E402


# ── Control-protocol fake transport (hermetic) ───────────────────────────────


class _ControlProtocolFakeTransport(Transport):
    """A Transport that emulates the CLI control protocol offline.

    Replies to the SDK's ``initialize`` control request (learning the hook
    callback ids the SDK assigned), then sends a scripted sequence of
    ``hook_callback`` control requests — each gated on the SDK's control response
    so hooks fire sequentially — and finally a ``result`` message. No subprocess,
    no network, no API key.

    NOTE: This is intentionally coupled to the SDK's internal control-protocol
    wire format (verified against claude-agent-sdk 0.2.x). It is a test fixture,
    not part of the shipped SDK.
    """

    def __init__(self, script: list[tuple[str, dict]], session_id: str):
        self._script = script
        self._sid = session_id
        self._cb_ids: dict[str, str] = {}
        self._gates: dict[str, asyncio.Event] = {}
        self._init_future: asyncio.Future | None = None
        self._ready = False

    async def connect(self) -> None:
        self._init_future = asyncio.get_event_loop().create_future()
        self._ready = True

    async def close(self) -> None:
        self._ready = False

    def is_ready(self) -> bool:
        return self._ready

    async def end_input(self) -> None:
        pass

    async def write(self, data: str) -> None:
        for line in data.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            mtype = msg.get("type")
            if mtype == "control_request" and (msg.get("request") or {}).get("subtype") == "initialize":
                if self._init_future is not None and not self._init_future.done():
                    self._init_future.set_result(msg)
            elif mtype == "control_response":
                rid = (msg.get("response") or {}).get("request_id")
                gate = self._gates.get(rid)
                if gate is not None:
                    gate.set()
            # user messages / other writes are ignored

    async def read_messages(self):
        # 1) Wait for the SDK's initialize request, learn callback ids, reply.
        init_req = await self._init_future  # type: ignore[arg-type]
        hooks_cfg = (init_req.get("request") or {}).get("hooks") or {}
        for event, matchers in hooks_cfg.items():
            for matcher in matchers or []:
                ids = matcher.get("hookCallbackIds") or []
                if ids:
                    self._cb_ids[event] = ids[0]
                    break
        yield {
            "type": "control_response",
            "response": {"request_id": init_req["request_id"], "subtype": "success", "response": {}},
        }
        # 2) Fire each scripted hook via a control request; gate on its response.
        for i, (event, hook_input) in enumerate(self._script):
            cbid = self._cb_ids.get(event)
            if cbid is None:
                continue
            rid = f"cli_{i}"
            self._gates[rid] = asyncio.Event()
            yield {
                "type": "control_request",
                "request_id": rid,
                "request": {
                    "subtype": "hook_callback",
                    "callback_id": cbid,
                    "input": hook_input,
                    "tool_use_id": hook_input.get("tool_use_id"),
                },
            }
            await self._gates[rid].wait()
        # 3) Terminal result — ends the run.
        yield {
            "type": "result",
            "subtype": "success",
            "duration_ms": 0,
            "duration_api_ms": 0,
            "is_error": False,
            "num_turns": 1,
            "session_id": self._sid,
            "total_cost_usd": 0.0,
            "result": "done",
            "usage": {},
        }


def _walk_sessions(node):
    if isinstance(node, list):
        for n in node:
            yield from _walk_sessions(n)
        return
    sess = node.get("session", node)
    if sess.get("session_id"):
        yield sess["session_id"]
    for c in node.get("children", []):
        yield from _walk_sessions(c)


@pytest.fixture
def instrumented():
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")
    assert aep.instrument(
        server_url=server_url, api_key=api_key, frameworks=["claude-agent"]
    ), "instrument() failed"
    try:
        yield server_url, api_key
    finally:
        uninstrument()


async def test_hermetic_query_hooks_emit_dag_to_server(instrumented):
    server_url, api_key = instrumented
    import uuid

    marker = uuid.uuid4().hex[:8]
    sid = f"ses-{marker}"
    # A scripted turn: root tool, then a sub-agent that runs a tool and errors on
    # a second tool, then the sub-agent stops.
    script = [
        ("UserPromptSubmit", {"session_id": sid, "prompt": "do the thing"}),
        ("PreToolUse", {"session_id": sid, "agent_id": "main", "tool_use_id": "t1", "tool_name": "Read", "tool_input": {"path": f"/{marker}"}}),
        ("PostToolUse", {"session_id": sid, "agent_id": "main", "tool_use_id": "t1", "tool_name": "Read", "tool_input": {}, "tool_response": "contents"}),
        ("SubagentStart", {"session_id": sid, "agent_id": "sub1", "agent_type": f"reviewer-{marker}"}),
        ("PreToolUse", {"session_id": sid, "agent_id": "sub1", "tool_use_id": "t2", "tool_name": "Grep", "tool_input": {"q": "TODO"}}),
        ("PostToolUseFailure", {"session_id": sid, "agent_id": "sub1", "tool_use_id": "t2", "tool_name": "Grep", "tool_input": {}, "error": "grep failed"}),
        ("SubagentStop", {"session_id": sid, "agent_id": "sub1", "agent_type": f"reviewer-{marker}"}),
        ("Stop", {"session_id": sid, "stop_hook_active": False}),
    ]
    transport = _ControlProtocolFakeTransport(script, sid)

    async for msg in query(prompt="do the thing", options=ClaudeAgentOptions(), transport=transport):
        if isinstance(msg, ResultMessage):
            break

    assert aep.flush(timeout=10.0)
    time.sleep(0.5)

    with AEPClient(server_url=server_url, api_key=api_key) as client:
        sessions = client.get_sessions(limit=200).get("sessions", [])
        sub = next((s for s in sessions if marker in str(s.get("source", ""))), None)
        assert sub is not None, "no sub-agent session recorded by server"

        workflow = client.get_workflow(sub["trace_id"])
        assert workflow.get("session_count", 0) >= 2  # root + sub-agent

        all_events = []
        for sid_ in _walk_sessions(workflow.get("tree", [])):
            all_events += client.get_session_events(sid_, limit=200).get("events", [])
        types = {e["type"] for e in all_events}
        assert "task.created" in types
        assert "handoff.started" in types
        assert "handoff.completed" in types

        called = [e for e in all_events if e["type"] == "tool.called"]
        result = [e for e in all_events if e["type"] == "tool.result"]
        errored = [e for e in all_events if e["type"] == "error.raised"]
        assert any(e["payload"].get("tool_name") == "Read" for e in called)
        assert result, "no tool.result for the root Read tool"
        assert any(e["payload"].get("tool_name") == "Grep" for e in errored)

        by_id = {e["id"]: e for e in all_events}
        dangling = [e["id"] for e in all_events if e.get("causation_id") and e["causation_id"] not in by_id]
        assert not dangling, "dangling causation links within the workflow tree"


async def test_real_query_emits_to_server(instrumented):
    """A real ``query()`` against the live ``claude`` binary. Auto-skips unless
    ANTHROPIC_API_KEY is set (CI has no key, so only runs locally)."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        pytest.skip("ANTHROPIC_API_KEY not set — skipping real Claude Agent run")

    server_url, api_key = instrumented
    import uuid

    marker = uuid.uuid4().hex[:8]
    got_any = False
    async for _msg in query(
        prompt=f"Say the word {marker} and nothing else.",
        options=ClaudeAgentOptions(max_turns=1),
    ):
        got_any = True
    assert got_any

    assert aep.flush(timeout=15.0)
    time.sleep(0.5)

    with AEPClient(server_url=server_url, api_key=api_key) as client:
        sessions = client.get_sessions(limit=200).get("sessions", [])
        orch = next((s for s in sessions if s.get("agent_role") == "orchestrator"), None)
        assert orch is not None, "no orchestrator session recorded by server"
