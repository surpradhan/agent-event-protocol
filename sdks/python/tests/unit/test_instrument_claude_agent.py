"""Unit tests for the Anthropic Claude Agent SDK → AEP mapping.

These drive :class:`AEPClaudeAgentTracer`'s async hook callbacks directly with
fabricated hook-input dicts (the same shape the SDK passes:
``UserPromptSubmit`` / ``Stop`` / ``SubagentStart`` / ``SubagentStop`` /
``PreToolUse`` / ``PostToolUse`` / ``PostToolUseFailure``) and a recorder client.
They assert the AEP event types and causation links a real ``query()`` would
produce — *without needing claude-agent-sdk installed*, because the mapping never
imports it (only :class:`ClaudeAgentInstrumentor` does). A separate test exercises
the real method patch + hook injection when the SDK is present.

Mirrors ``test_instrument_openai_agents.py``'s coverage shape and rigor.
"""

from __future__ import annotations

import asyncio

import pytest

from aep.instrument import AEPClaudeAgentTracer

# ── Fakes ────────────────────────────────────────────────────────────────────


class _Recorder:
    """Stand-in AEPClient that records emitted events."""

    def __init__(self):
        self.events = []
        self._server_url = "mock"

    def emit(self, event):
        self.events.append(event)
        return {"accepted": True}


_CTX = {"signal": None}


def _drive(steps, *, client=None, max_runs=10_000):
    """Run a list of (hook_method_name, input_dict) steps through a fresh tracer.

    Each hook is awaited in order (the SDK invokes them serially per turn).
    Returns (recorder, tracer).
    """
    rec = client or _Recorder()
    tracer = AEPClaudeAgentTracer(rec, max_runs=max_runs)

    async def _run():
        for method, payload in steps:
            tuid = payload.get("tool_use_id") if isinstance(payload, dict) else None
            await getattr(tracer, method)(payload, tuid, _CTX)

    asyncio.run(_run())
    assert tracer.flush(timeout=5.0)
    return rec, tracer


def _by_id(events):
    return {e["id"]: e for e in events}


def _no_dangling(events):
    by_id = _by_id(events)
    return [
        e["causation_id"]
        for e in events
        if e.get("causation_id") and e["causation_id"] not in by_id
    ]


# Step builders ───────────────────────────────────────────────────────────────


def _prompt(sid="s1"):
    return ("on_user_prompt_submit", {"session_id": sid, "prompt": "do it"})


def _stop(sid="s1"):
    return ("on_stop", {"session_id": sid, "stop_hook_active": False})


def _sub_start(sid="s1", aid="a1", atype="reviewer"):
    return ("on_subagent_start", {"session_id": sid, "agent_id": aid, "agent_type": atype})


def _sub_stop(sid="s1", aid="a1", atype="reviewer"):
    return ("on_subagent_stop", {"session_id": sid, "agent_id": aid, "agent_type": atype, "stop_hook_active": False})


def _pre_tool(sid="s1", aid="main", tuid="t1", name="Read", tool_input=None):
    return ("on_pre_tool_use", {"session_id": sid, "agent_id": aid, "tool_use_id": tuid, "tool_name": name, "tool_input": tool_input if tool_input is not None else {"path": "/x"}})


def _post_tool(sid="s1", aid="main", tuid="t1", name="Read", response="ok"):
    return ("on_post_tool_use", {"session_id": sid, "agent_id": aid, "tool_use_id": tuid, "tool_name": name, "tool_input": {}, "tool_response": response})


def _post_tool_fail(sid="s1", aid="main", tuid="t1", name="Read", error="boom"):
    return ("on_post_tool_use_failure", {"session_id": sid, "agent_id": aid, "tool_use_id": tuid, "tool_name": name, "tool_input": {}, "error": error})


# ── Top-level agent (root) ───────────────────────────────────────────────────


def test_prompt_then_stop_emits_root_pair_only():
    rec, _ = _drive([_prompt(), _stop()])
    types = [e["type"] for e in rec.events]
    assert types == ["task.created", "task.completed"]
    assert all(e["agent_role"] == "orchestrator" for e in rec.events)
    assert rec.events[0]["source"] == "agent://claude-agent"
    assert rec.events[0]["payload"]["framework"] == "claude-agent"
    assert rec.events[1]["causation_id"] == rec.events[0]["id"]
    assert len({e["trace_id"] for e in rec.events}) == 1


def test_root_opened_lazily_without_user_prompt_submit():
    # A run that starts with a tool (no UserPromptSubmit hook) still opens a root.
    rec, _ = _drive([_pre_tool(), _post_tool(), _stop()])
    assert rec.events[0]["type"] == "task.created"
    assert rec.events[0]["agent_role"] == "orchestrator"
    assert not _no_dangling(rec.events)


def test_root_open_is_idempotent():
    rec, _ = _drive([_prompt(), _prompt(), _stop()])
    created = [e for e in rec.events if e["type"] == "task.created"]
    assert len(created) == 1  # second UserPromptSubmit does not re-open the root


# ── Sub-agents (Task) ────────────────────────────────────────────────────────


def test_subagent_start_opens_via_handoff():
    rec, _ = _drive([_prompt(), _sub_start(), _sub_stop(), _stop()])
    types = [e["type"] for e in rec.events]
    assert types == [
        "task.created",       # root opens
        "handoff.started",    # root -> reviewer
        "task.created",       # reviewer sub-agent opens
        "task.completed",     # reviewer closes
        "handoff.completed",  # root closes the handoff
        "task.completed",     # root closes
    ]
    root_open, ho_start, sub_open, sub_done, ho_done, root_done = rec.events
    assert ho_start["causation_id"] == root_open["id"]
    assert sub_open["causation_id"] == ho_start["id"]
    assert sub_open["agent_role"] == "subagent"
    assert sub_open["parent_session_id"] == root_open["session_id"]
    assert sub_open["source"] == "agent://reviewer"
    assert sub_done["causation_id"] == sub_open["id"]
    assert ho_done["causation_id"] == ho_start["id"]
    assert not _no_dangling(rec.events)
    assert len({e["trace_id"] for e in rec.events}) == 1


def test_subagent_name_falls_back_to_agent_id_without_type():
    rec, _ = _drive([
        _prompt(),
        ("on_subagent_start", {"session_id": "s1", "agent_id": "a1"}),
        _stop(),
    ])
    sub = next(e for e in rec.events if e["agent_role"] == "subagent")
    assert sub["source"] == "agent://a1"


def test_two_subagents_form_one_trace_three_sessions():
    rec, _ = _drive([
        _prompt(),
        _sub_start(aid="a1", atype="researcher"), _sub_stop(aid="a1", atype="researcher"),
        _sub_start(aid="a2", atype="writer"), _sub_stop(aid="a2", atype="writer"),
        _stop(),
    ])
    assert len({e["trace_id"] for e in rec.events}) == 1
    assert len({e["session_id"] for e in rec.events}) == 3  # root + 2 subagents
    assert sum(1 for e in rec.events if e["type"] == "handoff.started") == 2
    assert sum(1 for e in rec.events if e["type"] == "handoff.completed") == 2
    assert not _no_dangling(rec.events)


def test_open_subagent_closed_at_stop_if_no_subagent_stop():
    """A sub-agent that never gets SubagentStop is closed when the root Stops."""
    rec, _ = _drive([_prompt(), _sub_start(), _stop()])  # no _sub_stop
    sub_done = [
        e for e in rec.events
        if e["type"] == "task.completed" and e["agent_role"] == "subagent"
    ]
    assert len(sub_done) == 1
    assert not _no_dangling(rec.events)


# ── Tools (paired by tool_use_id, attributed by agent_id) ────────────────────


def test_tool_on_root_session():
    rec, _ = _drive([_prompt(), _pre_tool(tool_input={"path": "/etc"}), _post_tool(response="data"), _stop()])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    result = next(e for e in rec.events if e["type"] == "tool.result")
    root = next(e for e in rec.events if e["type"] == "task.created")
    assert called["payload"]["tool_name"] == "Read"
    assert called["payload"]["arguments"] == {"path": "/etc"}
    assert called["session_id"] == root["session_id"]
    assert called["causation_id"] == root["id"]
    assert result["causation_id"] == called["id"]
    assert result["payload"]["output"] == "data"
    assert not _no_dangling(rec.events)


def test_tool_attributed_to_subagent_by_agent_id():
    rec, _ = _drive([
        _prompt(),
        _sub_start(aid="a1", atype="reviewer"),
        _pre_tool(aid="a1", tuid="t1", name="Grep"),
        _post_tool(aid="a1", tuid="t1", name="Grep", response="3 hits"),
        _sub_stop(aid="a1", atype="reviewer"),
        _stop(),
    ])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    sub_open = next(e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "subagent")
    # Tool lives on the sub-agent's session, not the root's.
    assert called["session_id"] == sub_open["session_id"]
    assert called["agent_role"] == "subagent"
    assert not _no_dangling(rec.events)


def test_tool_failure_emits_error_raised():
    rec, _ = _drive([_prompt(), _pre_tool(name="Bash"), _post_tool_fail(name="Bash", error="exit 1"), _stop()])
    err = next(e for e in rec.events if e["type"] == "error.raised")
    assert err["payload"]["tool_name"] == "Bash"
    assert err["payload"]["error"] == "exit 1"
    assert not any(e["type"] == "tool.result" for e in rec.events)
    assert not _no_dangling(rec.events)


def test_repeated_tools_each_get_own_pair():
    rec, _ = _drive([
        _prompt(),
        _pre_tool(tuid="t1", name="Read"), _post_tool(tuid="t1", name="Read", response="r1"),
        _pre_tool(tuid="t2", name="Read"), _post_tool(tuid="t2", name="Read", response="r2"),
        _stop(),
    ])
    called = [e for e in rec.events if e["type"] == "tool.called"]
    result = [e for e in rec.events if e["type"] == "tool.result"]
    assert len(called) == 2 and len(result) == 2
    by_id = _by_id(rec.events)
    for r in result:
        assert by_id[r["causation_id"]]["type"] == "tool.called"
    assert {r["payload"]["output"] for r in result} == {"r1", "r2"}
    assert not _no_dangling(rec.events)


def test_post_tool_without_matching_pre_is_ignored():
    rec, _ = _drive([_prompt(), _post_tool(tuid="ghost"), _stop()])
    assert not any(e["type"] in ("tool.result", "error.raised") for e in rec.events)


def test_tool_input_non_dict_wrapped_under_input():
    rec, _ = _drive([
        _prompt(),
        ("on_pre_tool_use", {"session_id": "s1", "agent_id": "main", "tool_use_id": "t1", "tool_name": "x", "tool_input": "raw-string"}),
        _stop(),
    ])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    assert called["payload"]["arguments"] == {"input": "raw-string"}


def test_tool_input_none_yields_empty_args():
    rec, _ = _drive([
        _prompt(),
        ("on_pre_tool_use", {"session_id": "s1", "agent_id": "main", "tool_use_id": "t1", "tool_name": "x", "tool_input": None}),
        _stop(),
    ])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    assert called["payload"]["arguments"] == {}


# ── Multi-session isolation ──────────────────────────────────────────────────


def test_concurrent_sessions_are_isolated_into_separate_traces():
    rec, _ = _drive([
        _prompt(sid="s1"),
        _prompt(sid="s2"),
        _pre_tool(sid="s1", tuid="t1"), _post_tool(sid="s1", tuid="t1"),
        _pre_tool(sid="s2", tuid="t1"), _post_tool(sid="s2", tuid="t1"),
        _stop(sid="s1"),
        _stop(sid="s2"),
    ])
    # Two sessions → two distinct traces, each self-consistent.
    assert len({e["trace_id"] for e in rec.events}) == 2
    assert not _no_dangling(rec.events)


# ── Hook contract / host-safety ──────────────────────────────────────────────


def test_hooks_return_empty_dict_noop_output():
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def _run():
        out = await tracer.on_pre_tool_use(
            {"session_id": "s1", "agent_id": "main", "tool_use_id": "t1", "tool_name": "X", "tool_input": {}},
            "t1", _CTX,
        )
        # A pure observer must return {} (proceed, no decision).
        assert out == {}
        out2 = await tracer.on_stop({"session_id": "s1"}, None, _CTX)
        assert out2 == {}

    asyncio.run(_run())


def test_callback_exception_is_swallowed_and_returns_empty():
    """A malformed input that makes the mapping raise must not propagate and must
    still return the no-op {} so the host agent proceeds."""
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def _run():
        # tool_input is an int → _coerce stringifies fine, but force a raise by
        # passing an input object whose .get blows up.
        class Boom:
            def get(self, *a):
                raise RuntimeError("boom")
        out = await tracer.on_pre_tool_use(Boom(), None, _CTX)
        assert out == {}

    asyncio.run(_run())


def test_emit_failure_does_not_propagate():
    class Boom:
        _server_url = "mock"

        def emit(self, event):
            raise RuntimeError("network down")

    # Failures happen on the background worker; the host run is never affected.
    _drive([_prompt(), _pre_tool(), _post_tool(), _sub_start(), _sub_stop(), _stop()], client=Boom())


def test_hook_matchers_cover_all_observed_events():
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)
    events = set(tracer.hook_matchers().keys())
    assert events == {
        "UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop",
        "PreToolUse", "PostToolUse", "PostToolUseFailure",
    }
    # One observer callback registered per event.
    assert sum(len(v) for v in tracer.hook_matchers().values()) == 7


# ── Bounds ───────────────────────────────────────────────────────────────────


def test_run_table_is_bounded_when_many_subagents_open():
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec, max_runs=4)

    async def _run():
        await tracer.on_user_prompt_submit({"session_id": "s1", "prompt": "x"}, None, _CTX)
        for i in range(20):
            await tracer.on_subagent_start({"session_id": "s1", "agent_id": f"a{i}", "agent_type": "t"}, None, _CTX)

    asyncio.run(_run())
    assert tracer.flush(timeout=5.0)
    assert len(tracer._runs) <= 4
    assert tracer._core._evicted >= 16


# ── Permission denials via can_use_tool (policy.blocked) ─────────────────────


def _deny(message="not allowed"):
    from types import SimpleNamespace

    return SimpleNamespace(behavior="deny", message=message, interrupt=False)


def _allow():
    from types import SimpleNamespace

    return SimpleNamespace(behavior="allow", updated_input=None)


def _ctx(tuid):
    from types import SimpleNamespace

    return SimpleNamespace(signal=None, suggestions=[], tool_use_id=tuid)


def _wrapped_deny_flow(tracer, *, result, tuid="t1", tool_name="Bash"):
    """Run a wrapped can_use_tool returning ``result``; return what it returned."""
    from aep.instrument import _wrap_claude_can_use_tool

    async def original(name, tool_input, context):
        return result

    wrapped = _wrap_claude_can_use_tool(original, tracer)
    return asyncio.run(wrapped(tool_name, {"command": "rm -rf /"}, _ctx(tuid)))


def test_denied_can_use_tool_emits_policy_blocked_on_tool_session():
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def _run():
        m, p = _prompt()
        await getattr(tracer, m)(p, None, _CTX)
        m, p = _pre_tool(tuid="t1", name="Bash")
        await getattr(tracer, m)(p, "t1", _CTX)

    asyncio.run(_run())
    deny = _deny("rm is not allowed here")
    returned = _wrapped_deny_flow(tracer, result=deny, tuid="t1", tool_name="Bash")
    assert returned is deny  # observation never alters the app's result
    assert tracer.flush(timeout=5.0)

    blocked = [e for e in rec.events if e["type"] == "policy.blocked"]
    assert len(blocked) == 1
    evt = blocked[0]
    tool_called = next(e for e in rec.events if e["type"] == "tool.called")
    # Lands on the denied tool's session, chained off its tool.called.
    assert evt["session_id"] == tool_called["session_id"]
    assert evt["causation_id"] == tool_called["id"]
    assert evt["payload"]["policy"] == "can_use_tool"
    assert evt["payload"]["reason"] == "rm is not allowed here"
    assert evt["payload"]["action_blocked"] == "tool.called/Bash"
    assert evt["payload"]["framework"] == "claude-agent"
    assert _no_dangling(rec.events) == []


def test_allowed_can_use_tool_emits_nothing():
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)
    allow = _allow()
    returned = _wrapped_deny_flow(tracer, result=allow, tuid="t9")
    assert returned is allow
    assert tracer.flush(timeout=5.0)
    assert [e for e in rec.events if e["type"] == "policy.blocked"] == []


def test_denied_dict_shaped_result_is_recognized():
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def _run():
        m, p = _prompt()
        await getattr(tracer, m)(p, None, _CTX)
        m, p = _pre_tool(tuid="t1", name="Write")
        await getattr(tracer, m)(p, "t1", _CTX)

    asyncio.run(_run())
    result = {"behavior": "deny", "message": "nope"}
    returned = _wrapped_deny_flow(tracer, result=result, tuid="t1", tool_name="Write")
    assert returned is result
    assert tracer.flush(timeout=5.0)
    blocked = [e for e in rec.events if e["type"] == "policy.blocked"]
    assert len(blocked) == 1
    assert blocked[0]["payload"]["reason"] == "nope"


def test_denial_before_pre_tool_use_falls_back_to_single_root():
    # Deny can precede PreToolUse (the tool never runs) — with one open
    # session the decision lands on its root.
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def _run():
        m, p = _prompt(sid="s1")
        await getattr(tracer, m)(p, None, _CTX)

    asyncio.run(_run())
    _wrapped_deny_flow(tracer, result=_deny(), tuid="unknown", tool_name="Bash")
    assert tracer.flush(timeout=5.0)
    blocked = [e for e in rec.events if e["type"] == "policy.blocked"]
    assert len(blocked) == 1
    root_created = rec.events[0]
    assert root_created["type"] == "task.created"
    assert blocked[0]["session_id"] == root_created["session_id"]
    assert blocked[0]["payload"]["action_blocked"] == "tool.called/Bash"
    assert _no_dangling(rec.events) == []


def test_denial_for_closed_tool_run_drops_silently():
    # A stale _tuid_index entry (tool already completed) resolves to a popped
    # run key, which the emission core drops — pins the append-only design's
    # load-bearing claim.
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def _run():
        for step in (_prompt(), _pre_tool(tuid="t1"), _post_tool(tuid="t1"),
                     _stop()):
            m, p = step
            await getattr(tracer, m)(p, p.get("tool_use_id"), _CTX)

    asyncio.run(_run())
    _wrapped_deny_flow(tracer, result=_deny(), tuid="t1")
    assert tracer.flush(timeout=5.0)
    assert [e for e in rec.events if e["type"] == "policy.blocked"] == []


def test_denial_with_unknown_tuid_and_multiple_roots_drops_silently():
    # Two concurrent sessions and no tool correlation: attribution would be a
    # guess, so the decision is dropped rather than mislabeled.
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def _run():
        for sid in ("s1", "s2"):
            m, p = _prompt(sid=sid)
            await getattr(tracer, m)(p, None, _CTX)

    asyncio.run(_run())
    _wrapped_deny_flow(tracer, result=_deny(), tuid="unknown")
    assert tracer.flush(timeout=5.0)
    assert [e for e in rec.events if e["type"] == "policy.blocked"] == []


def test_denial_without_message_synthesizes_reason():
    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def _run():
        m, p = _prompt()
        await getattr(tracer, m)(p, None, _CTX)

    asyncio.run(_run())
    _wrapped_deny_flow(tracer, result=_deny(message=""), tuid="unknown", tool_name="Bash")
    assert tracer.flush(timeout=5.0)
    blocked = [e for e in rec.events if e["type"] == "policy.blocked"]
    assert len(blocked) == 1
    assert "Bash" in blocked[0]["payload"]["reason"]


def test_wrapped_can_use_tool_propagates_original_exception():
    from aep.instrument import _wrap_claude_can_use_tool

    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    async def original(name, tool_input, context):
        raise RuntimeError("app callback exploded")

    wrapped = _wrap_claude_can_use_tool(original, tracer)
    with pytest.raises(RuntimeError, match="app callback exploded"):
        asyncio.run(wrapped("Bash", {}, _ctx("t1")))
    assert tracer.flush(timeout=5.0)
    assert rec.events == []  # observation adds nothing on the exception path


def test_inject_wraps_can_use_tool_once_and_skips_absent():
    from dataclasses import dataclass, field
    from typing import Any as _Any

    from aep.instrument import _inject_claude_hooks

    class _Matcher:
        def __init__(self, matcher=None, hooks=None):
            self.matcher = matcher
            self.hooks = hooks or []

    @dataclass
    class _Options:
        hooks: dict = field(default_factory=dict)
        can_use_tool: _Any = None

    rec = _Recorder()
    tracer = AEPClaudeAgentTracer(rec)

    # Absent can_use_tool: hooks get injected, can_use_tool stays None.
    injected = _inject_claude_hooks(_Options(), tracer, _Matcher)
    assert injected.can_use_tool is None

    # Present: gets wrapped exactly once (idempotent on re-injection).
    async def cut(name, tool_input, context):
        return _allow()

    injected = _inject_claude_hooks(_Options(can_use_tool=cut), tracer, _Matcher)
    assert injected.can_use_tool is not cut
    assert getattr(injected.can_use_tool, "_aep_wrapped", False)
    again = _inject_claude_hooks(injected, tracer, _Matcher)
    assert again.can_use_tool is injected.can_use_tool
    tracer.close(timeout=1.0)


# ── Real method patch (only when claude-agent-sdk is installed) ───────────────


def test_instrumentor_patches_and_restores():
    pytest.importorskip("claude_agent_sdk", reason="claude-agent-sdk not installed")
    from claude_agent_sdk import ClaudeSDKClient
    from claude_agent_sdk._internal.client import InternalClient

    from aep.instrument import ClaudeAgentInstrumentor

    rec = _Recorder()
    inst = ClaudeAgentInstrumentor()
    assert inst.available() is True
    orig_pq = InternalClient.process_query
    orig_conn = ClaudeSDKClient.connect
    try:
        assert inst.instrument(rec) is True
        assert InternalClient.process_query is not orig_pq
        assert ClaudeSDKClient.connect is not orig_conn
        assert getattr(InternalClient, "_aep_instrumented", False) is True
        assert getattr(InternalClient, "_aep_tracer", None) is not None
        assert getattr(ClaudeSDKClient, "_aep_tracer", None) is not None
    finally:
        inst.uninstrument()
    assert InternalClient.process_query is orig_pq
    assert ClaudeSDKClient.connect is orig_conn
    assert not hasattr(InternalClient, "_aep_instrumented")
    assert not hasattr(InternalClient, "_aep_tracer")
    assert not hasattr(ClaudeSDKClient, "_aep_tracer")


def test_inject_hooks_is_idempotent_and_non_mutating():
    pytest.importorskip("claude_agent_sdk", reason="claude-agent-sdk not installed")
    from claude_agent_sdk import ClaudeAgentOptions, HookMatcher

    from aep.instrument import AEPClaudeAgentTracer, _inject_claude_hooks

    tracer = AEPClaudeAgentTracer(_Recorder())
    opts = ClaudeAgentOptions()
    injected = _inject_claude_hooks(opts, tracer, HookMatcher)
    # Non-mutating: original options untouched; a new object returned with hooks.
    assert opts.hooks is None
    assert injected.hooks is not None
    assert "PreToolUse" in injected.hooks
    # Idempotent: injecting again adds nothing (our callbacks already present).
    again = _inject_claude_hooks(injected, tracer, HookMatcher)
    assert again is injected  # unchanged → same object returned
    assert len(again.hooks["PreToolUse"]) == 1
