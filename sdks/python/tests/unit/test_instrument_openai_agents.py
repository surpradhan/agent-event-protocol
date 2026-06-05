"""Unit tests for the OpenAI Agents SDK → AEP mapping (``AEPOpenAIAgentsTracer``).

These drive the tracer's tracing-processor interface
(``on_trace_start`` / ``on_span_start`` / ``on_span_end`` / ``on_trace_end``)
directly with ``SimpleNamespace`` stand-ins for the SDK's ``Trace`` and ``Span``
objects (``agent`` / ``function`` / ``handoff`` / ``turn`` span-data) and a
recorder client. They assert the AEP event types and causation links a real
``Runner.run`` would produce — *without needing the OpenAI Agents SDK installed*,
because the mapping (:class:`AEPOpenAIAgentsTracer`) never imports ``agents``
(only :class:`OpenAIAgentsInstrumentor` does). A separate test exercises the real
processor registration when ``openai-agents`` is present.

The fabricated span trees mirror a real captured trace: a root ``task`` span,
``agent`` spans as siblings beneath it, a ``turn`` span under each agent, and
``function`` / ``handoff`` spans under the turns. Mirrors
``test_instrument_autogen.py``'s coverage shape and rigor.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aep.instrument import AEPOpenAIAgentsTracer


# ── Fakes ────────────────────────────────────────────────────────────────────


class _Recorder:
    """Stand-in AEPClient that records emitted events."""

    def __init__(self):
        self.events = []
        self._server_url = "mock"

    def emit(self, event):
        self.events.append(event)
        return {"accepted": True}


def _trace(trace_id="trc_1", name="agent-workflow"):
    return SimpleNamespace(trace_id=trace_id, name=name)


def _span(span_id, parent_id, data, *, trace_id="trc_1", error=None):
    return SimpleNamespace(
        span_id=span_id,
        parent_id=parent_id,
        span_data=data,
        trace_id=trace_id,
        error=error,
    )


def _agent_data(name):
    return SimpleNamespace(type="agent", name=name)


def _fn_data(name, input=None, output=None):
    return SimpleNamespace(type="function", name=name, input=input, output=output)


def _handoff_data(from_agent, to_agent):
    return SimpleNamespace(type="handoff", from_agent=from_agent, to_agent=to_agent)


def _turn_data():
    # A non-boundary span (real traces use a custom "turn" span between agent and
    # its tool/handoff children); the mapping ignores it but records its parent so
    # the parent-walk passes through it.
    return SimpleNamespace(type="turn")


# A SpanError as the SDK records it on a failed span (a dict, not an exception).
def _tool_error(message="tool exploded", tool_name="boom"):
    return {
        "message": "Error running tool (non-fatal)",
        "data": {"tool_name": tool_name, "error": message},
    }


def _play(steps, *, client=None, max_runs=10_000, max_spans=10_000):
    """Feed (method_name, arg) steps to a fresh tracer; return (recorder, tracer)."""
    rec = client or _Recorder()
    tracer = AEPOpenAIAgentsTracer(rec, max_runs=max_runs, max_spans=max_spans)
    for method, arg in steps:
        getattr(tracer, method)(arg)
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


# Reusable span-tree builders mirroring a real trace ──────────────────────────


def _agent_with_steps(agent_id, name, child_steps, *, error=None, trace_id="trc_1",
                      parent_id="task"):
    """A full agent lifecycle: start agent, run a turn containing ``child_steps``
    (each a (method, span) the turn wraps), close the turn, close the agent."""
    agent = _span(agent_id, parent_id, _agent_data(name), trace_id=trace_id, error=error)
    turn = _span(f"{agent_id}-turn", agent_id, _turn_data(), trace_id=trace_id)
    steps = [("on_span_start", agent), ("on_span_start", turn)]
    steps += child_steps
    steps += [("on_span_end", turn), ("on_span_end", agent)]
    return steps, turn


# ── Orchestrator (trace root) ────────────────────────────────────────────────


def test_trace_with_no_spans_emits_orchestrator_pair_only():
    rec, _ = _play([
        ("on_trace_start", _trace(name="my-workflow")),
        ("on_trace_end", _trace(name="my-workflow")),
    ])
    types = [e["type"] for e in rec.events]
    assert types == ["task.created", "task.completed"]
    assert all(e["agent_role"] == "orchestrator" for e in rec.events)
    assert rec.events[0]["source"] == "agent://my-workflow"
    assert rec.events[1]["causation_id"] == rec.events[0]["id"]
    assert rec.events[0]["payload"]["framework"] == "openai-agents"
    assert rec.events[0]["payload"]["kind"] == "workflow"
    assert len({e["trace_id"] for e in rec.events}) == 1


def test_trace_without_name_falls_back():
    rec, _ = _play([
        ("on_trace_start", SimpleNamespace(trace_id="trc_1", name=None)),
        ("on_trace_end", SimpleNamespace(trace_id="trc_1", name=None)),
    ])
    assert rec.events[0]["source"] == "agent://agent-workflow"


def test_trace_end_for_unknown_trace_is_noop():
    rec, _ = _play([("on_trace_end", _trace(trace_id="never-started"))])
    assert rec.events == []


# ── Sub-agent (workflow → agent) ─────────────────────────────────────────────


def test_agent_span_opens_subagent_via_handoff():
    agent_steps, _ = _agent_with_steps("a1", "researcher", [])
    rec, _ = _play([
        ("on_trace_start", _trace()),
        *agent_steps,
        ("on_trace_end", _trace()),
    ])
    types = [e["type"] for e in rec.events]
    assert types == [
        "task.created",       # workflow orchestrator opens
        "handoff.started",    # workflow -> researcher
        "task.created",       # researcher sub-agent opens
        "task.completed",     # researcher closes
        "handoff.completed",  # workflow closes the handoff
        "task.completed",     # workflow orchestrator closes
    ]
    wf_open, ho_start, sub_open, sub_done, ho_done, wf_done = rec.events
    assert ho_start["causation_id"] == wf_open["id"]
    assert sub_open["causation_id"] == ho_start["id"]
    assert sub_done["causation_id"] == sub_open["id"]
    assert ho_done["causation_id"] == ho_start["id"]
    assert wf_done["causation_id"] == wf_open["id"]
    assert sub_open["agent_role"] == "subagent"
    assert sub_open["parent_session_id"] == wf_open["session_id"]
    assert sub_open["source"] == "agent://researcher"
    assert not _no_dangling(rec.events)
    assert len({e["trace_id"] for e in rec.events}) == 1


def test_two_sibling_agents_form_one_clean_trace():
    a1, _ = _agent_with_steps("a1", "researcher", [])
    a2, _ = _agent_with_steps("a2", "writer", [])
    rec, _ = _play([
        ("on_trace_start", _trace()),
        *a1,
        *a2,
        ("on_trace_end", _trace()),
    ])
    assert len({e["trace_id"] for e in rec.events}) == 1
    # workflow + two agents
    assert len({e["session_id"] for e in rec.events}) == 3
    assert sum(1 for e in rec.events if e["type"] == "handoff.started") == 2
    assert sum(1 for e in rec.events if e["type"] == "handoff.completed") == 2
    assert not _no_dangling(rec.events)
    sources = {e["source"] for e in rec.events}
    assert sources == {"agent://agent-workflow", "agent://researcher", "agent://writer"}


def test_handoff_span_enriches_next_agent_with_handoff_from():
    """A handoff span (triage -> spanish) ending before the spanish agent opens
    records ``handoff_from`` on spanish's ``task.created`` payload."""
    triage_id = "a1"
    handoff = _span("ho", f"{triage_id}-turn", _handoff_data("triage", "spanish"))
    triage_steps, _ = _agent_with_steps(
        triage_id, "triage", [("on_span_end", handoff)]
    )
    spanish_steps, _ = _agent_with_steps("a2", "spanish", [])
    rec, _ = _play([
        ("on_trace_start", _trace()),
        *triage_steps,
        *spanish_steps,
        ("on_trace_end", _trace()),
    ])
    spanish_open = next(
        e for e in rec.events
        if e["type"] == "task.created" and e["source"] == "agent://spanish"
    )
    assert spanish_open["payload"]["handoff_from"] == "triage"
    # The non-handed-to agent does not get a handoff_from key.
    triage_open = next(
        e for e in rec.events
        if e["type"] == "task.created" and e["source"] == "agent://triage"
    )
    assert "handoff_from" not in triage_open["payload"]
    assert not _no_dangling(rec.events)


def test_handoff_span_with_no_to_agent_is_ignored():
    handoff = _span("ho", "a1-turn", _handoff_data("triage", None))
    steps, _ = _agent_with_steps("a1", "triage", [("on_span_end", handoff)])
    rec, _ = _play([("on_trace_start", _trace()), *steps, ("on_trace_end", _trace())])
    # No crash, and nothing recorded a handoff_from for the (absent) target.
    assert not any("handoff_from" in e["payload"] for e in rec.events)


# ── Tools (function spans, paired by span_id) ────────────────────────────────


def test_function_span_emits_called_result_on_agent_session():
    fn = _span("fn1", "a1-turn", _fn_data("web_search", input='{"q": "agents"}', output="42 hits"))
    steps, _ = _agent_with_steps("a1", "researcher", [
        ("on_span_start", fn), ("on_span_end", fn),
    ])
    rec, _ = _play([("on_trace_start", _trace()), *steps, ("on_trace_end", _trace())])

    called = next(e for e in rec.events if e["type"] == "tool.called")
    result = next(e for e in rec.events if e["type"] == "tool.result")
    assert called["payload"]["tool_name"] == "web_search"
    assert called["payload"]["arguments"] == {"q": "agents"}
    sub_open = next(
        e for e in rec.events
        if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    assert called["session_id"] == sub_open["session_id"]
    assert called["causation_id"] == sub_open["id"]
    assert result["causation_id"] == called["id"]
    assert result["payload"]["output"] == "42 hits"
    assert not _no_dangling(rec.events)


def test_function_span_error_emits_error_raised_with_extracted_message():
    fn = _span(
        "fn1", "a1-turn", _fn_data("calc", input='{"x": 1}'),
        error=_tool_error("division by zero", "calc"),
    )
    steps, _ = _agent_with_steps("a1", "researcher", [
        ("on_span_start", fn), ("on_span_end", fn),
    ])
    rec, _ = _play([("on_trace_start", _trace()), *steps, ("on_trace_end", _trace())])
    err = next(e for e in rec.events if e["type"] == "error.raised")
    assert err["payload"]["tool_name"] == "calc"
    # The nested data.error message is preferred over the generic top-level one.
    assert err["payload"]["error"] == "division by zero"
    assert not any(e["type"] == "tool.result" for e in rec.events)
    sub_open = next(
        e for e in rec.events
        if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    assert err["session_id"] == sub_open["session_id"]


def test_repeated_function_spans_each_get_their_own_pair():
    fn1 = _span("fn1", "a1-turn", _fn_data("search", input='{"q": "a"}', output="r1"))
    fn2 = _span("fn2", "a1-turn", _fn_data("search", input='{"q": "b"}', output="r2"))
    steps, _ = _agent_with_steps("a1", "researcher", [
        ("on_span_start", fn1), ("on_span_end", fn1),
        ("on_span_start", fn2), ("on_span_end", fn2),
    ])
    rec, _ = _play([("on_trace_start", _trace()), *steps, ("on_trace_end", _trace())])
    called = [e for e in rec.events if e["type"] == "tool.called"]
    result = [e for e in rec.events if e["type"] == "tool.result"]
    assert len(called) == 2 and len(result) == 2
    by_id = _by_id(rec.events)
    for res in result:
        assert by_id[res["causation_id"]]["type"] == "tool.called"
    assert {r["payload"]["output"] for r in result} == {"r1", "r2"}
    assert not _no_dangling(rec.events)


def test_function_span_with_none_input_yields_empty_args():
    fn = _span("fn1", "a1-turn", _fn_data("noop", input=None, output="ok"))
    steps, _ = _agent_with_steps("a1", "researcher", [
        ("on_span_start", fn), ("on_span_end", fn),
    ])
    rec, _ = _play([("on_trace_start", _trace()), *steps, ("on_trace_end", _trace())])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    assert called["payload"]["arguments"] == {}


def test_function_span_non_json_input_wrapped_under_input():
    fn = _span("fn1", "a1-turn", _fn_data("noop", input="not-json", output="ok"))
    steps, _ = _agent_with_steps("a1", "researcher", [
        ("on_span_start", fn), ("on_span_end", fn),
    ])
    rec, _ = _play([("on_trace_start", _trace()), *steps, ("on_trace_end", _trace())])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    assert called["payload"]["arguments"] == {"input": "not-json"}


def test_tool_parent_resolves_through_turn_to_agent():
    """A function span nested under a turn under an agent attaches to the agent's
    session — the parent walk passes through the (ignored) turn span."""
    fn = _span("fn1", "a1-turn", _fn_data("t", input="{}", output="x"))
    steps, _ = _agent_with_steps("a1", "agent_a", [
        ("on_span_start", fn), ("on_span_end", fn),
    ])
    rec, _ = _play([("on_trace_start", _trace()), *steps, ("on_trace_end", _trace())])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    sub = next(e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "subagent")
    assert called["session_id"] == sub["session_id"]
    assert called["agent_role"] == "subagent"


def test_tool_without_open_agent_falls_back_to_workflow_root():
    """A function span whose parent chain has no open agent still stays inside the
    run's single trace by attaching to the always-open workflow root."""
    fn = _span("fn1", "task", _fn_data("t", input="{}", output="x"))
    rec, _ = _play([
        ("on_trace_start", _trace()),
        ("on_span_start", fn),
        ("on_span_end", fn),
        ("on_trace_end", _trace()),
    ])
    called = next(e for e in rec.events if e["type"] == "tool.called")
    wf_open = next(e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "orchestrator")
    assert called["session_id"] == wf_open["session_id"]
    assert len({e["trace_id"] for e in rec.events}) == 1
    assert not _no_dangling(rec.events)


# ── Agent failure ────────────────────────────────────────────────────────────


def test_agent_span_error_marks_task_failed():
    agent = _span("a1", "task", _agent_data("agent_a"), error={"message": "guardrail tripped", "data": None})
    turn = _span("a1-turn", "a1", _turn_data())
    rec, _ = _play([
        ("on_trace_start", _trace()),
        ("on_span_start", agent),
        ("on_span_start", turn),
        ("on_span_end", turn),
        ("on_span_end", agent),
        ("on_trace_end", _trace()),
    ])
    fail = next(e for e in rec.events if e["type"] == "task.failed")
    assert fail["agent_role"] == "subagent"
    assert fail["payload"]["error"] == "guardrail tripped"
    assert not _no_dangling(rec.events)


# ── Agents-as-tools (nested agent) ───────────────────────────────────────────


def test_nested_agent_parents_to_enclosing_open_agent():
    """An agent span whose parent chain runs through an enclosing *open* agent (as
    happens with agents-as-tools) becomes a sub-agent of that agent — a real
    nested handoff, not a sibling of the workflow root."""
    outer = _span("outer", "task", _agent_data("outer"))
    outer_turn = _span("outer-turn", "outer", _turn_data())
    # The inner agent runs beneath the outer agent's turn.
    inner = _span("inner", "outer-turn", _agent_data("inner"))
    inner_turn = _span("inner-turn", "inner", _turn_data())
    rec, _ = _play([
        ("on_trace_start", _trace()),
        ("on_span_start", outer),
        ("on_span_start", outer_turn),
        ("on_span_start", inner),
        ("on_span_start", inner_turn),
        ("on_span_end", inner_turn),
        ("on_span_end", inner),
        ("on_span_end", outer_turn),
        ("on_span_end", outer),
        ("on_trace_end", _trace()),
    ])
    outer_open = next(e for e in rec.events if e["type"] == "task.created" and e["source"] == "agent://outer")
    inner_open = next(e for e in rec.events if e["type"] == "task.created" and e["source"] == "agent://inner")
    # inner is a sub-agent whose parent session is outer's (not the workflow root).
    assert inner_open["parent_session_id"] == outer_open["session_id"]
    assert len({e["trace_id"] for e in rec.events}) == 1
    assert not _no_dangling(rec.events)


# ── Full run / no-dangling invariant ─────────────────────────────────────────


def test_full_handoff_and_tool_run_has_no_dangling_links():
    fn = _span("fn1", "a1-turn", _fn_data("get_weather", input='{"city": "Paris"}', output="sunny"))
    handoff = _span("ho", "a1-turn", _handoff_data("triage", "spanish"))
    triage_steps, _ = _agent_with_steps("a1", "triage", [
        ("on_span_start", fn), ("on_span_end", fn),
        ("on_span_end", handoff),
    ])
    spanish_steps, _ = _agent_with_steps("a2", "spanish", [])
    rec, _ = _play([
        ("on_trace_start", _trace()),
        *triage_steps,
        *spanish_steps,
        ("on_trace_end", _trace()),
    ])
    assert not _no_dangling(rec.events)
    assert len({e["trace_id"] for e in rec.events}) == 1
    assert len({e["session_id"] for e in rec.events}) == 3  # workflow + triage + spanish


# ── Bounds / host-safety ─────────────────────────────────────────────────────


def test_run_table_is_bounded_when_many_agents_open():
    rec = _Recorder()
    tracer = AEPOpenAIAgentsTracer(rec, max_runs=4)
    tracer.on_trace_start(_trace())
    for i in range(20):
        # Open (but never close) many agents so they accumulate in the run table.
        tracer.on_span_start(_span(f"a{i}", "task", _agent_data(f"agent{i}")))
    assert tracer.flush(timeout=5.0)
    assert len(tracer._runs) <= 4
    assert tracer._core._evicted >= 16


def test_span_parent_index_is_bounded():
    rec = _Recorder()
    tracer = AEPOpenAIAgentsTracer(rec, max_spans=8)
    tracer.on_trace_start(_trace())
    for i in range(50):
        # Many turn (non-boundary) spans whose parents are only ever recorded.
        tracer.on_span_start(_span(f"t{i}", "task", _turn_data()))
    assert tracer.flush(timeout=5.0)
    assert len(tracer._parent_of) <= 8
    assert tracer._span_evicted >= 42


def test_stray_span_end_without_start_is_ignored():
    """An end callback for a span we never saw start must not emit or crash."""
    rec, _ = _play([
        ("on_trace_start", _trace()),
        ("on_span_end", _span("ghost", "task", _agent_data("ghost"))),
        ("on_trace_end", _trace()),
    ])
    # Only the orchestrator pair; the stray agent end matched no open run.
    assert [e["type"] for e in rec.events] == ["task.created", "task.completed"]


def test_callback_exception_is_swallowed():
    """A span whose attribute access raises must not break the host run."""
    class Boom:
        @property
        def span_data(self):
            raise RuntimeError("boom")
        span_id = "x"
        parent_id = "task"
        trace_id = "trc_1"
    rec = _Recorder()
    tracer = AEPOpenAIAgentsTracer(rec)
    tracer.on_trace_start(_trace())
    # Must not raise.
    tracer.on_span_start(Boom())
    tracer.on_span_end(Boom())
    tracer.on_trace_end(_trace())
    assert tracer.flush(timeout=5.0)
    assert any(e["type"] == "task.completed" for e in rec.events)


def test_emit_failure_does_not_propagate():
    class Boom:
        _server_url = "mock"

        def emit(self, event):
            raise RuntimeError("network down")

    # Failures happen on the background worker; the host run is never affected.
    steps, _ = _agent_with_steps("a1", "researcher", [])
    _play([("on_trace_start", _trace()), *steps, ("on_trace_end", _trace())], client=Boom())


def test_force_flush_and_shutdown_do_not_raise():
    rec = _Recorder()
    tracer = AEPOpenAIAgentsTracer(rec)
    tracer.on_trace_start(_trace())
    tracer.on_trace_end(_trace())
    tracer.force_flush()
    tracer.shutdown()  # drains + stops the worker


# ── Real processor registration (only when openai-agents is installed) ───────


def test_instrumentor_registers_and_removes_processor():
    pytest.importorskip("agents", reason="openai-agents not installed")
    from agents.tracing import get_trace_provider

    from aep.instrument import AEPOpenAIAgentsTracer, OpenAIAgentsInstrumentor

    rec = _Recorder()
    inst = OpenAIAgentsInstrumentor()
    assert inst.available() is True

    def _aep_processors():
        mp = get_trace_provider()._multi_processor
        return [p for p in mp._processors if isinstance(p, AEPOpenAIAgentsTracer)]

    assert _aep_processors() == []
    try:
        assert inst.instrument(rec) is True
        assert len(_aep_processors()) == 1
        # Idempotent: re-instrumenting does not stack a second AEP processor.
        assert inst.instrument(rec) is True
        assert len(_aep_processors()) == 1
    finally:
        inst.uninstrument()
    assert _aep_processors() == []
