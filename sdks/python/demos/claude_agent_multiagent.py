"""Anthropic Claude Agent SDK multi-agent workflow with AEP auto-instrumentation.

Phase 12f headline demo. A single ``aep.instrument()`` call makes an unmodified
Claude Agent SDK ``query()`` emit a full AEP event DAG — with **no other code
changes**. AEP injects observer hooks into ``ClaudeAgentOptions.hooks``; the
top-level agent becomes the orchestrator, each ``Task`` sub-agent becomes a
sub-agent ``task.*`` reached via a ``handoff.*``, and every tool call becomes a
``tool.called`` / ``tool.result`` pair (or ``error.raised``) — all sharing one
``trace_id``.

Topology::

    claude-agent (orchestrator)
      ├─ Read tool ─────────────────────────────────┐
      └─ handoff ─► reviewer (sub-agent)             ▼
                      ├─ Grep tool                (final result)
                      └─ Bash tool (fails -> error.raised)

To keep the demo self-contained — runnable in CI and **offline with no API key
and no ``claude`` binary** — it drives a real ``query()`` through a custom
``Transport`` that emulates the CLI control protocol and replays a scripted
sequence of hook events. The SDK runner, its hook registration, and the AEP hook
injection are all genuine; only the transport is synthetic. To run against the
real ``claude`` binary instead, set ``AEP_DEMO_ANTHROPIC=1`` (and an
``ANTHROPIC_API_KEY``).

After running, the demo queries the AEP server and prints the recorded session
tree so you can see the causation chain. If the server is down it still runs and
explains how to view results once a server is up.

Run::

    pip install -e "sdks/python[claude-agent]"
    python demos/claude_agent_multiagent.py

Set AEP_INGEST_URL / AEP_API_KEY if the server is not at http://localhost:8787.
"""

from __future__ import annotations

import asyncio
import json
import os
import time

import aep

try:
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query
    from claude_agent_sdk._internal.transport import Transport
except ImportError:
    raise SystemExit(
        "The Claude Agent SDK is required for this demo. Install it with:\n"
        '  pip install -e "sdks/python[claude-agent]"'
    )


SESSION_ID = "demo-session"

# The scripted multi-agent turn (event_name, hook_input) replayed offline.
SCRIPT = [
    ("UserPromptSubmit", {"session_id": SESSION_ID, "prompt": "Review the repo."}),
    ("PreToolUse", {"session_id": SESSION_ID, "agent_id": "main", "tool_use_id": "t1", "tool_name": "Read", "tool_input": {"path": "README.md"}}),
    ("PostToolUse", {"session_id": SESSION_ID, "agent_id": "main", "tool_use_id": "t1", "tool_name": "Read", "tool_input": {}, "tool_response": "# Project ..."}),
    ("SubagentStart", {"session_id": SESSION_ID, "agent_id": "rev1", "agent_type": "reviewer"}),
    ("PreToolUse", {"session_id": SESSION_ID, "agent_id": "rev1", "tool_use_id": "t2", "tool_name": "Grep", "tool_input": {"pattern": "TODO"}}),
    ("PostToolUse", {"session_id": SESSION_ID, "agent_id": "rev1", "tool_use_id": "t2", "tool_name": "Grep", "tool_input": {}, "tool_response": "3 matches"}),
    ("PreToolUse", {"session_id": SESSION_ID, "agent_id": "rev1", "tool_use_id": "t3", "tool_name": "Bash", "tool_input": {"command": "pytest"}}),
    ("PostToolUseFailure", {"session_id": SESSION_ID, "agent_id": "rev1", "tool_use_id": "t3", "tool_name": "Bash", "tool_input": {}, "error": "1 test failed"}),
    ("SubagentStop", {"session_id": SESSION_ID, "agent_id": "rev1", "agent_type": "reviewer"}),
    ("Stop", {"session_id": SESSION_ID, "stop_hook_active": False}),
]


class _ReplayTransport(Transport):
    """Offline Transport that replays scripted hook events through the SDK's real
    control protocol (no subprocess, no network, no API key)."""

    def __init__(self, script, session_id):
        self._script = script
        self._sid = session_id
        self._cb_ids = {}
        self._gates = {}
        self._init_future = None
        self._ready = False

    async def connect(self):
        self._init_future = asyncio.get_event_loop().create_future()
        self._ready = True

    async def close(self):
        self._ready = False

    def is_ready(self):
        return self._ready

    async def end_input(self):
        pass

    async def write(self, data):
        for line in data.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("type") == "control_request" and (msg.get("request") or {}).get("subtype") == "initialize":
                if self._init_future and not self._init_future.done():
                    self._init_future.set_result(msg)
            elif msg.get("type") == "control_response":
                rid = (msg.get("response") or {}).get("request_id")
                if rid in self._gates:
                    self._gates[rid].set()

    async def read_messages(self):
        init_req = await self._init_future
        for event, matchers in ((init_req.get("request") or {}).get("hooks") or {}).items():
            for m in matchers or []:
                ids = m.get("hookCallbackIds") or []
                if ids:
                    self._cb_ids[event] = ids[0]
                    break
        yield {"type": "control_response", "response": {"request_id": init_req["request_id"], "subtype": "success", "response": {}}}
        for i, (event, hook_input) in enumerate(self._script):
            cbid = self._cb_ids.get(event)
            if cbid is None:
                continue
            rid = f"cli_{i}"
            self._gates[rid] = asyncio.Event()
            yield {"type": "control_request", "request_id": rid, "request": {"subtype": "hook_callback", "callback_id": cbid, "input": hook_input, "tool_use_id": hook_input.get("tool_use_id")}}
            await self._gates[rid].wait()
        yield {"type": "result", "subtype": "success", "duration_ms": 0, "duration_api_ms": 0, "is_error": False, "num_turns": 1, "session_id": self._sid, "total_cost_usd": 0.0, "result": "done", "usage": {}}


def _print_workflow(server_url, api_key):
    from aep.client import AEPClient

    try:
        with AEPClient(server_url=server_url, api_key=api_key) as client:
            sessions = client.get_sessions(limit=50).get("sessions", [])
            orch = next((s for s in sessions if s.get("agent_role") == "orchestrator"), None)
            if not orch:
                print("No orchestrator session found yet — is the server running?")
                return
            print(f"\nOrchestrator session: {orch['session_id']}")
            tree = client.get_session_tree(orch["session_id"])

            def walk(node, depth=0):
                sess = node.get("session", node)
                print(f"  {'  ' * depth}└─ {sess.get('session_id', '?')} "
                      f"[{sess.get('agent_role', '?')}] ({sess.get('event_count', '?')} events)")
                for child in node.get("children", []):
                    walk(child, depth + 1)

            walk(tree)
    except Exception as e:
        print(f"\nServer verification skipped ({e}).")
        print("Start a server with `npm run ingest`, then re-run to see the DAG.")


async def main():
    server_url = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
    api_key = os.environ.get("AEP_API_KEY")

    # The entire integration: one line, before running the agent.
    if not aep.instrument(server_url=server_url, api_key=api_key, frameworks=["claude-agent"]):
        print("AEP instrumentation could not be enabled (see warnings above).")

    print("\n=== Running Claude Agent SDK workflow ===\n")
    if os.environ.get("AEP_DEMO_ANTHROPIC") == "1":
        # Real run against the claude binary (needs ANTHROPIC_API_KEY).
        async for msg in query(prompt="Review the repo and summarize TODOs.",
                               options=ClaudeAgentOptions(max_turns=2)):
            pass
    else:
        # Offline: replay scripted hooks through a real query() + fake transport.
        transport = _ReplayTransport(SCRIPT, SESSION_ID)
        async for msg in query(prompt="Review the repo.", options=ClaudeAgentOptions(), transport=transport):
            if isinstance(msg, ResultMessage):
                break

    print("=== Done ===")
    aep.flush(timeout=10.0)
    time.sleep(0.3)
    print("\n=== AEP workflow (from server) ===")
    _print_workflow(server_url, api_key)
    print(f"\nOpen the dashboard to replay the causation DAG: {server_url}/dashboard")


if __name__ == "__main__":
    asyncio.run(main())
