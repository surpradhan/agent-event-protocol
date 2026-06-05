"""Unit tests for the AutoGen AgentChat → AEP mapping (``AEPAutoGenTracer``).

These drive the tracer directly by feeding ``wrap_stream`` an async generator of
fabricated AutoGen-shaped message/event objects (``SimpleNamespace`` stand-ins for
``TextMessage`` / ``ToolCallRequestEvent`` / ``ToolCallExecutionEvent`` / a
``TaskResult``) with a recorder client. They assert the AEP event types and
causation links a real ``team.run()`` would produce — *without needing autogen
installed*, because the mapping (:meth:`AEPAutoGenTracer.wrap_stream` /
:class:`_AutoGenRunContext`) never imports ``autogen`` (only
``AutoGenInstrumentor`` does). A separate group exercises the real class patch
when autogen-agentchat is present.

Mirrors ``test_instrument_crewai.py``'s coverage shape for the CrewAI listener.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aep.instrument import AEPAutoGenTracer, _AutoGenRunContext


# ── Fakes ────────────────────────────────────────────────────────────────────


class _Recorder:
    """Stand-in AEPClient that records emitted events."""

    def __init__(self):
        self.events = []
        self._server_url = "mock"

    def emit(self, event):
        self.events.append(event)
        return {"accepted": True}


def _team(name="research-team"):
    return SimpleNamespace(name=name)


def _user(text="research and write"):
    return SimpleNamespace(source="user", type="TextMessage", content=text)


def _text(source, content="ok"):
    return SimpleNamespace(source=source, type="TextMessage", content=content)


def _tool_request(source, calls):
    """calls: list of (call_id, name, arguments)."""
    content = [
        SimpleNamespace(id=cid, name=name, arguments=args) for cid, name, args in calls
    ]
    return SimpleNamespace(source=source, type="ToolCallRequestEvent", content=content)


def _tool_execution(source, results):
    """results: list of (call_id, output, is_error)."""
    content = [
        SimpleNamespace(call_id=cid, content=out, is_error=err)
        for cid, out, err in results
    ]
    return SimpleNamespace(
        source=source, type="ToolCallExecutionEvent", content=content
    )


def _task_result():
    # The stream's terminal item: carries the message list + a stop reason and has
    # no ``source`` — must be skipped by the mapping.
    return SimpleNamespace(messages=[], stop_reason="done")


async def _agen(items, exc=None):
    for it in items:
        yield it
    if exc is not None:
        raise exc


async def _drive(items, *, exc=None, client=None, instance=None, max_runs=10_000):
    """Run ``items`` through a tracer's wrap_stream; return (recorder, yielded)."""
    rec = client or _Recorder()
    tracer = AEPAutoGenTracer(rec, max_runs=max_runs)
    instance = instance if instance is not None else _team()
    yielded = []
    async for item in tracer.wrap_stream(instance, _agen(items, exc)):
        yielded.append(item)
    assert tracer.flush(timeout=5.0)
    return rec, yielded


def _by_id(events):
    return {e["id"]: e for e in events}


def _no_dangling(events):
    by_id = _by_id(events)
    return [
        e["causation_id"]
        for e in events
        if e.get("causation_id") and e["causation_id"] not in by_id
    ]


# ── Orchestrator (team root) ─────────────────────────────────────────────────


async def test_team_with_no_agent_messages_emits_orchestrator_pair_only():
    rec, _ = await _drive([_user(), _task_result()])
    types = [e["type"] for e in rec.events]
    assert types == ["task.created", "task.completed"]
    assert all(e["agent_role"] == "orchestrator" for e in rec.events)
    assert rec.events[0]["source"] == "agent://research-team"
    assert rec.events[1]["causation_id"] == rec.events[0]["id"]
    assert rec.events[0]["payload"]["framework"] == "autogen"
    assert len({e["trace_id"] for e in rec.events}) == 1


async def test_team_without_name_falls_back_to_team():
    rec, _ = await _drive([_task_result()], instance=SimpleNamespace())
    assert rec.events[0]["source"] == "agent://team"


# ── Sub-agent (team → agent handoff) ─────────────────────────────────────────


async def test_agent_message_opens_subagent_via_handoff():
    rec, _ = await _drive([_user(), _text("researcher", "found sources"), _task_result()])

    types = [e["type"] for e in rec.events]
    assert types == [
        "task.created",       # team orchestrator opens
        "handoff.started",    # team -> researcher
        "task.created",       # researcher sub-agent opens
        "task.completed",     # researcher closes (at run end)
        "handoff.completed",  # team closes the handoff
        "task.completed",     # team orchestrator closes
    ]
    team_open, ho_start, sub_open, sub_done, ho_done, team_done = rec.events

    assert ho_start["causation_id"] == team_open["id"]
    assert sub_open["causation_id"] == ho_start["id"]
    assert sub_done["causation_id"] == sub_open["id"]
    assert ho_done["causation_id"] == ho_start["id"]
    assert team_done["causation_id"] == team_open["id"]

    assert sub_open["agent_role"] == "subagent"
    assert sub_open["parent_session_id"] == team_open["session_id"]
    assert sub_open["source"] == "agent://researcher"
    assert ho_start["session_id"] == team_open["session_id"]
    assert ho_done["agent_role"] == "orchestrator"

    assert not _no_dangling(rec.events)
    assert len({e["trace_id"] for e in rec.events}) == 1


async def test_repeated_messages_from_one_agent_reuse_one_session():
    rec, _ = await _drive(
        [_text("researcher", "a"), _text("researcher", "b"), _text("researcher", "c")]
    )
    opened = [
        e
        for e in rec.events
        if e["type"] == "task.created" and e["agent_role"] == "subagent"
    ]
    # The same source speaking three times opens exactly one sub-agent session.
    assert len(opened) == 1


async def test_two_agents_form_one_clean_trace():
    rec, _ = await _drive(
        [_user(), _text("researcher", "notes"), _text("writer", "report"), _task_result()]
    )
    # One trace spanning the run; three sessions (team + two agents).
    assert len({e["trace_id"] for e in rec.events}) == 1
    assert len({e["session_id"] for e in rec.events}) == 3
    assert sum(1 for e in rec.events if e["type"] == "handoff.started") == 2
    assert sum(1 for e in rec.events if e["type"] == "handoff.completed") == 2
    assert not _no_dangling(rec.events)
    sources = {e["source"] for e in rec.events}
    assert sources == {"agent://research-team", "agent://researcher", "agent://writer"}


# ── Tools (matched exactly by call_id) ───────────────────────────────────────


async def test_tool_request_and_execution_emit_called_result_on_agent_session():
    rec, _ = await _drive([
        _tool_request("researcher", [("c1", "web_search", '{"q": "agents"}')]),
        _tool_execution("researcher", [("c1", "42 hits", False)]),
        _task_result(),
    ])

    called = next(e for e in rec.events if e["type"] == "tool.called")
    result = next(e for e in rec.events if e["type"] == "tool.result")
    assert called["payload"]["tool_name"] == "web_search"
    assert called["payload"]["arguments"] == {"q": "agents"}
    sub_open = next(
        e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    assert called["session_id"] == sub_open["session_id"]
    assert called["causation_id"] == sub_open["id"]
    assert result["causation_id"] == called["id"]
    assert result["payload"]["output"] == "42 hits"
    assert not _no_dangling(rec.events)


async def test_tool_execution_error_emits_error_raised():
    rec, _ = await _drive([
        _tool_request("researcher", [("c1", "calc", '{"x": 1}')]),
        _tool_execution("researcher", [("c1", "division by zero", True)]),
        _task_result(),
    ])
    err = next(e for e in rec.events if e["type"] == "error.raised")
    assert err["payload"]["tool_name"] == "calc"
    assert err["payload"]["error"] == "division by zero"
    assert not any(e["type"] == "tool.result" for e in rec.events)
    sub_open = next(
        e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    assert err["session_id"] == sub_open["session_id"]


async def test_repeated_tools_each_get_their_own_pair():
    rec, _ = await _drive([
        _tool_request("researcher", [("c1", "search", '{"q": "a"}')]),
        _tool_execution("researcher", [("c1", "r1", False)]),
        _tool_request("researcher", [("c2", "search", '{"q": "b"}')]),
        _tool_execution("researcher", [("c2", "r2", False)]),
        _task_result(),
    ])
    called = [e for e in rec.events if e["type"] == "tool.called"]
    result = [e for e in rec.events if e["type"] == "tool.result"]
    assert len(called) == 2 and len(result) == 2
    by_id = _by_id(rec.events)
    for res in result:
        assert by_id[res["causation_id"]]["type"] == "tool.called"
    assert {r["payload"]["output"] for r in result} == {"r1", "r2"}
    assert not _no_dangling(rec.events)


async def test_concurrent_tool_calls_matched_by_call_id():
    """Two tool calls requested together, results returned together, are paired
    by ``call_id`` — no LIFO guessing, so even out-of-order results match."""
    rec, _ = await _drive([
        _tool_request(
            "researcher",
            [("c1", "search", '{"q": "a"}'), ("c2", "lookup", '{"id": 7}')],
        ),
        # Results returned in the opposite order — must still pair exactly.
        _tool_execution("researcher", [("c2", "found-7", False), ("c1", "hits-a", False)]),
        _task_result(),
    ])
    by_id = _by_id(rec.events)
    pairs = {}
    for res in (e for e in rec.events if e["type"] == "tool.result"):
        called = by_id[res["causation_id"]]
        pairs[called["payload"]["tool_name"]] = res["payload"]["output"]
    assert pairs == {"search": "hits-a", "lookup": "found-7"}
    assert not _no_dangling(rec.events)


async def test_tool_execution_without_matching_open_is_ignored():
    """An execution event for a call_id we never opened must not emit or crash."""
    rec, _ = await _drive([
        _text("researcher", "thinking"),
        _tool_execution("researcher", [("ghost", "x", False)]),
        _task_result(),
    ])
    assert not any(e["type"] in ("tool.result", "error.raised") for e in rec.events)


async def test_tool_args_non_json_is_wrapped_under_input():
    rec, _ = await _drive([
        _tool_request("researcher", [("c1", "noop", "not-json")]),
        _task_result(),
    ])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    assert called["payload"]["arguments"] == {"input": "not-json"}


# ── Run-level completion / failure ───────────────────────────────────────────


async def test_run_failure_marks_orchestrator_failed_and_propagates():
    rec = _Recorder()
    tracer = AEPAutoGenTracer(rec)
    boom = RuntimeError("team blew up")

    with pytest.raises(RuntimeError, match="team blew up"):
        async for _ in tracer.wrap_stream(
            _team(), _agen([_user(), _text("researcher", "partial")], exc=boom)
        ):
            pass
    assert tracer.flush(timeout=5.0)

    # Orchestrator failed (with the error surfaced); the observed sub-agent still
    # closes completed; the exception reached the caller.
    orch_fail = next(
        e
        for e in rec.events
        if e["type"] == "task.failed" and e["agent_role"] == "orchestrator"
    )
    assert orch_fail["payload"]["error"] == "team blew up"
    assert any(
        e["type"] == "task.completed" and e["agent_role"] == "subagent"
        for e in rec.events
    )
    assert not _no_dangling(rec.events)


async def test_cancelled_run_marks_orchestrator_failed_and_reraises():
    """A cancelled run (``CancelledError``, a BaseException) must close the
    orchestrator as ``task.failed`` — not silently as completed — while still
    propagating the cancellation."""
    import asyncio

    rec = _Recorder()
    tracer = AEPAutoGenTracer(rec)

    with pytest.raises(asyncio.CancelledError):
        async for _ in tracer.wrap_stream(
            _team(), _agen([_user(), _text("researcher", "partial")], exc=asyncio.CancelledError())
        ):
            pass
    assert tracer.flush(timeout=5.0)

    orch = [
        e
        for e in rec.events
        if e["agent_role"] == "orchestrator" and e["type"].startswith("task.")
    ]
    # Orchestrator opened then closed FAILED (not completed) on cancellation.
    assert orch[0]["type"] == "task.created"
    assert any(e["type"] == "task.failed" for e in orch)
    assert not any(e["type"] == "task.completed" for e in orch)
    assert not _no_dangling(rec.events)


async def test_terminal_taskresult_closes_run_before_finally():
    """The run closes when the terminal ``TaskResult`` is observed — not only
    when the generator is exhausted — so completion is deterministic. Driving
    ``observe`` directly (no wrap_stream ``finally``) still closes the run."""
    rec = _Recorder()
    tracer = AEPAutoGenTracer(rec)
    ctx = _AutoGenRunContext(tracer._core, "tok", "team")
    ctx.start()
    ctx.observe(_text("researcher", "notes"))
    ctx.observe(_task_result())  # terminal → closes here, no finally needed
    assert tracer.flush(timeout=5.0)
    assert any(
        e["type"] == "task.completed" and e["agent_role"] == "orchestrator"
        for e in rec.events
    )
    # A stray message after the terminal is ignored (the run is already done).
    ctx.observe(_text("late", "ignored"))
    assert tracer.flush(timeout=5.0)
    assert not any(e["source"] == "agent://late" for e in rec.events)


async def test_user_and_task_result_items_create_no_sessions():
    rec, _ = await _drive([_user(), _user("again"), _task_result()])
    # Only the orchestrator pair — neither the user echo nor the TaskResult opens a run.
    assert len({e["session_id"] for e in rec.events}) == 1
    assert all(e["agent_role"] == "orchestrator" for e in rec.events)


# ── Transparency / passthrough ───────────────────────────────────────────────


async def test_wrap_stream_re_yields_items_unchanged_in_order():
    items = [_user(), _text("researcher"), _task_result()]
    _, yielded = await _drive(items)
    assert yielded == items  # identical objects, same order — fully transparent


# ── Bounds / host-safety ─────────────────────────────────────────────────────


async def test_run_table_is_bounded_when_many_agents_open():
    """Many distinct agent sources in one run must not grow the run table without
    limit — the core evicts the oldest once the cap is exceeded."""
    rec = _Recorder()
    tracer = AEPAutoGenTracer(rec, max_runs=4)
    ctx = _AutoGenRunContext(tracer._core, "tok", "team")
    ctx.start()
    for i in range(20):
        ctx.observe(_text(f"agent{i}", "hi"))
    assert tracer.flush(timeout=5.0)
    assert len(tracer._runs) <= 4
    assert tracer._core._evicted >= 16


async def test_finish_is_idempotent():
    rec = _Recorder()
    tracer = AEPAutoGenTracer(rec)
    ctx = _AutoGenRunContext(tracer._core, "tok", "team")
    ctx.start()
    ctx.observe(_text("researcher", "hi"))
    ctx.finish("completed")
    assert tracer.flush(timeout=5.0)  # emission is buffered; drain before counting
    n_after_first = len(rec.events)
    ctx.finish("completed")  # second call must be a no-op
    assert tracer.flush(timeout=5.0)
    assert len(rec.events) == n_after_first


async def test_mapping_error_on_one_item_does_not_break_the_stream():
    """A malformed event that makes the mapping raise is swallowed; the stream
    still yields every item and the run still closes cleanly."""
    # content is a non-iterable int → ``for call in 5`` raises inside observe.
    bad = SimpleNamespace(source="researcher", type="ToolCallRequestEvent", content=5)
    items = [_user(), bad, _text("researcher", "still here"), _task_result()]
    rec, yielded = await _drive(items)
    assert yielded == items  # nothing dropped
    # The orchestrator + sub-agent lifecycle still completed.
    assert any(e["type"] == "task.completed" and e["agent_role"] == "orchestrator" for e in rec.events)
    assert not _no_dangling(rec.events)


async def test_emit_failure_does_not_propagate():
    class Boom:
        _server_url = "mock"

        def emit(self, event):
            raise RuntimeError("network down")

    # Failures happen on the background worker; the host run is never affected.
    rec, _ = await _drive([_user(), _text("researcher"), _task_result()], client=Boom())


# ── Real class patch (only when autogen-agentchat is installed) ──────────────


def test_instrumentor_patches_and_restores_base_group_chat():
    pytest.importorskip("autogen_agentchat", reason="autogen-agentchat not installed")
    from autogen_agentchat.teams._group_chat._base_group_chat import BaseGroupChat

    from aep.instrument import AutoGenInstrumentor

    rec = _Recorder()
    inst = AutoGenInstrumentor()
    assert inst.available() is True
    original = BaseGroupChat.run_stream
    try:
        assert inst.instrument(rec) is True
        assert BaseGroupChat.run_stream is not original
        assert getattr(BaseGroupChat, "_aep_instrumented", False) is True
        assert getattr(BaseGroupChat, "_aep_tracer", None) is not None
    finally:
        inst.uninstrument()
    # Patch fully removed; original method restored.
    assert BaseGroupChat.run_stream is original
    assert not hasattr(BaseGroupChat, "_aep_instrumented")
    assert not hasattr(BaseGroupChat, "_aep_tracer")
