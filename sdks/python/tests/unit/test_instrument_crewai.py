"""Unit tests for the CrewAI → AEP event mapping (``AEPCrewListener``).

These drive the listener directly by feeding it fabricated CrewAI-shaped event
objects (``SimpleNamespace`` stand-ins for ``CrewKickoffStartedEvent`` etc.) with
a mock client. They assert the AEP event types and causation links a real
``Crew.kickoff()`` would produce — *without needing CrewAI installed*, because
the mapping never imports ``crewai`` (only :meth:`AEPCrewListener.subscribe`
does). A separate group exercises the real event bus when CrewAI is present.

Mirrors ``test_instrument.py``'s coverage shape for the LangGraph handler.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aep.instrument import AEPCrewListener

# ── Fakes ────────────────────────────────────────────────────────────────────


class _Recorder:
    """Stand-in AEPClient that records emitted events."""

    def __init__(self):
        self.events = []
        self._server_url = "mock"

    def emit(self, event):
        self.events.append(event)
        return {"accepted": True}


def _agent(role):
    return SimpleNamespace(role=role, id=f"agent-{role}")


def _task(tid, role=None, name=None, description="do the work"):
    return SimpleNamespace(
        id=tid, name=name, description=description, agent=_agent(role) if role else None
    )


def _crew(name="research-crew"):
    # A distinct object per crew; the listener keys crews by id().
    return SimpleNamespace(name=name)


def _listener():
    rec = _Recorder()
    return AEPCrewListener(rec), rec


def _by_id(events):
    return {e["id"]: e for e in events}


def _no_dangling(events):
    by_id = _by_id(events)
    return [
        e["causation_id"]
        for e in events
        if e.get("causation_id") and e["causation_id"] not in by_id
    ]


# ── Crew root (orchestrator) ─────────────────────────────────────────────────


def test_crew_kickoff_emits_orchestrator_task_pair():
    lis, rec = _listener()
    crew = _crew()
    start = SimpleNamespace(crew_name="research-crew", crew=crew)
    done = SimpleNamespace(crew=crew, output="ok")

    lis._on_crew_start(crew, start)
    lis._on_crew_end(crew, done, "completed")
    assert lis.flush(timeout=5.0)

    types = [e["type"] for e in rec.events]
    assert types == ["task.created", "task.completed"]
    assert all(e["agent_role"] == "orchestrator" for e in rec.events)
    assert rec.events[1]["causation_id"] == rec.events[0]["id"]
    assert len({e["trace_id"] for e in rec.events}) == 1
    assert rec.events[0]["payload"]["framework"] == "crewai"


def test_crew_kickoff_failed_emits_task_failed():
    lis, rec = _listener()
    crew = _crew()
    lis._on_crew_start(crew, SimpleNamespace(crew=crew, crew_name="c"))
    lis._on_crew_end(crew, SimpleNamespace(crew=crew, error=RuntimeError("kaboom")), "failed")
    assert lis.flush(timeout=5.0)

    failed = [e for e in rec.events if e["type"] == "task.failed"]
    assert len(failed) == 1
    assert failed[0]["payload"]["error"] == "kaboom"
    assert failed[0]["agent_role"] == "orchestrator"


# ── Task as sub-agent (crew → task handoff) ─────────────────────────────────


def test_task_links_to_crew_via_handoff():
    lis, rec = _listener()
    crew = _crew()
    task = _task("t1", role="researcher")

    lis._on_crew_start(crew, SimpleNamespace(crew=crew, crew_name="c"))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))
    lis._on_task_end(task, SimpleNamespace(task=task, task_id="t1", output="notes"), "completed")
    lis._on_crew_end(crew, SimpleNamespace(crew=crew), "completed")
    assert lis.flush(timeout=5.0)

    types = [e["type"] for e in rec.events]
    assert types == [
        "task.created",       # crew orchestrator opens
        "handoff.started",    # crew -> researcher
        "task.created",       # researcher task opens (subagent)
        "task.completed",     # researcher task done
        "handoff.completed",  # crew closes handoff
        "task.completed",     # crew orchestrator done
    ]
    crew_open, ho_start, task_open, task_done, ho_done, crew_done = rec.events

    # Causation DAG integrity
    assert ho_start["causation_id"] == crew_open["id"]
    assert task_open["causation_id"] == ho_start["id"]
    assert task_done["causation_id"] == task_open["id"]
    assert ho_done["causation_id"] == ho_start["id"]
    assert crew_done["causation_id"] == crew_open["id"]

    # Sub-agent points back at the crew session; handoffs live on the crew session
    assert task_open["agent_role"] == "subagent"
    assert task_open["parent_session_id"] == crew_open["session_id"]
    assert ho_start["session_id"] == crew_open["session_id"]
    assert ho_done["agent_role"] == "orchestrator"
    # Named for the assigned agent's role
    assert task_open["source"] == "agent://researcher"

    assert not _no_dangling(rec.events)
    assert len({e["trace_id"] for e in rec.events}) == 1


def test_task_failed_emits_task_failed_and_closes_handoff():
    lis, rec = _listener()
    crew = _crew()
    task = _task("t1", role="writer")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))
    lis._on_task_end(
        task, SimpleNamespace(task=task, task_id="t1", error="bad output"), "failed"
    )
    assert lis.flush(timeout=5.0)

    failed = [e for e in rec.events if e["type"] == "task.failed"]
    assert len(failed) == 1
    assert failed[0]["agent_role"] == "subagent"
    assert failed[0]["payload"]["error"] == "bad output"
    hc = [e for e in rec.events if e["type"] == "handoff.completed"]
    assert hc and hc[0]["payload"]["status"] == "failed"


def test_task_without_agent_falls_back_to_name():
    lis, rec = _listener()
    crew = _crew()
    task = _task("t1", role=None, name=None, description="summarize the corpus")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))
    assert lis.flush(timeout=5.0)
    opened = next(
        e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    assert opened["source"] == "agent://summarize the corpus"


# ── Tools ────────────────────────────────────────────────────────────────────


def test_tool_usage_emits_called_and_result_on_task_session():
    lis, rec = _listener()
    crew = _crew()
    task = _task("t1", role="researcher")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))
    lis._on_tool_start(
        None,
        SimpleNamespace(tool_name="search", tool_args={"q": "agents"}, from_task=task),
    )
    lis._on_tool_end(
        None, SimpleNamespace(tool_name="search", from_task=task, output="42 hits")
    )
    assert lis.flush(timeout=5.0)

    called = next(e for e in rec.events if e["type"] == "tool.called")
    result = next(e for e in rec.events if e["type"] == "tool.result")
    assert called["payload"]["tool_name"] == "search"
    assert called["payload"]["arguments"] == {"q": "agents"}
    task_open = next(
        e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    assert called["session_id"] == task_open["session_id"]
    assert called["causation_id"] == task_open["id"]
    assert result["causation_id"] == called["id"]
    assert result["payload"]["output"] == "42 hits"


def test_tool_error_emits_error_raised():
    lis, rec = _listener()
    crew = _crew()
    task = _task("t1", role="researcher")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))
    lis._on_tool_start(
        None, SimpleNamespace(tool_name="calc", tool_args={"x": 1}, from_task=task)
    )
    lis._on_tool_error(
        None, SimpleNamespace(tool_name="calc", from_task=task, error="division by zero")
    )
    assert lis.flush(timeout=5.0)
    err = next(e for e in rec.events if e["type"] == "error.raised")
    assert err["payload"]["tool_name"] == "calc"
    assert err["payload"]["error"] == "division by zero"
    # On the task's session (not standalone)
    task_open = next(
        e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    assert err["session_id"] == task_open["session_id"]


def test_repeated_tools_in_same_task_each_get_their_own_pair():
    """Two tool calls in one task must not collide on a shared run key.

    Both invocations resolve to the same scope (the task), so a single coarse
    ``tool:<scope>`` key would let the second open overwrite the first and the
    first's result would be lost. Each call must produce its own
    called→result pair with correctly linked causation.
    """
    lis, rec = _listener()
    crew = _crew()
    task = _task("t1", role="researcher")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))

    lis._on_tool_start(None, SimpleNamespace(tool_name="search", tool_args={"q": "a"}, from_task=task))
    lis._on_tool_end(None, SimpleNamespace(tool_name="search", from_task=task, output="r1"))
    lis._on_tool_start(None, SimpleNamespace(tool_name="search", tool_args={"q": "b"}, from_task=task))
    lis._on_tool_end(None, SimpleNamespace(tool_name="search", from_task=task, output="r2"))
    assert lis.flush(timeout=5.0)

    called = [e for e in rec.events if e["type"] == "tool.called"]
    result = [e for e in rec.events if e["type"] == "tool.result"]
    assert len(called) == 2 and len(result) == 2
    # Each result chains off a distinct call; no dangling links.
    by_id = _by_id(rec.events)
    for res in result:
        assert res["causation_id"] in by_id
        assert by_id[res["causation_id"]]["type"] == "tool.called"
    assert {r["payload"]["output"] for r in result} == {"r1", "r2"}
    assert not _no_dangling(rec.events)


def test_tool_finish_without_from_task_still_closes_the_pair():
    """Scope drift: the close event lacks ``from_task`` (only the start had it).

    A naive re-resolution would key the close to the crew scope, mismatch the
    task-scoped open, and leave a dangling ``tool.called``. The listener must
    fall back to the most-recent open tool so the pair still closes cleanly.
    """
    lis, rec = _listener()
    crew = _crew()
    task = _task("t1", role="researcher")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))

    # Start carries from_task; finish does NOT (as some CrewAI events do).
    lis._on_tool_start(None, SimpleNamespace(tool_name="search", tool_args={"q": "x"}, from_task=task))
    lis._on_tool_end(None, SimpleNamespace(tool_name="search", output="42 hits"))
    assert lis.flush(timeout=5.0)

    called = next(e for e in rec.events if e["type"] == "tool.called")
    result = next(e for e in rec.events if e["type"] == "tool.result")
    # Pair closed and linked, on the task's session (not a stray crew/standalone one).
    assert result["causation_id"] == called["id"]
    assert result["session_id"] == called["session_id"]
    assert result["payload"]["output"] == "42 hits"
    assert not _no_dangling(rec.events)


def test_tool_close_with_no_open_tool_is_ignored():
    """A finish/error with nothing open must neither emit nor crash."""
    lis, rec = _listener()
    crew = _crew()
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_tool_end(None, SimpleNamespace(tool_name="ghost", output="x"))
    lis._on_tool_error(None, SimpleNamespace(tool_name="ghost", error="boom"))
    assert lis.flush(timeout=5.0)
    assert not any(e["type"] in ("tool.result", "error.raised") for e in rec.events)


def test_open_tool_index_is_bounded_when_closes_never_arrive():
    """Tool starts that never get a matching close must not grow _open_tools
    without limit — the oldest are evicted once the cap is exceeded."""
    rec = _Recorder()
    lis = AEPCrewListener(rec, max_runs=4)
    crew = _crew()
    task = _task("t1", role="researcher")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))

    # Fire 20 tool starts with no finishes (abnormal accumulation).
    for i in range(20):
        lis._on_tool_start(
            None, SimpleNamespace(tool_name=f"t{i}", tool_args={"i": i}, from_task=task)
        )
    assert lis.flush(timeout=5.0)
    # Index stayed bounded at the cap; eviction was recorded (not silent).
    assert len(lis._open_tools) <= 4
    assert lis._tool_evicted >= 16


# ── Agent execution outside a tracked task (hierarchical / standalone) ───────


def test_agent_without_task_opens_its_own_subagent_session():
    lis, rec = _listener()
    crew = _crew()
    agent = _agent("manager")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    # No TaskStarted fired — agent runs directly under the crew.
    lis._on_agent_start(agent, SimpleNamespace(agent=agent, task=None))
    lis._on_agent_end(agent, SimpleNamespace(agent=agent, task=None, output="done"), "completed")
    assert lis.flush(timeout=5.0)

    sub = [e for e in rec.events if e["agent_role"] == "subagent"]
    assert any(e["type"] == "task.created" for e in sub)
    assert any(e["type"] == "task.completed" for e in sub)
    assert any(e["source"] == "agent://manager" for e in sub)


def test_agent_start_is_noop_when_task_already_tracked():
    lis, rec = _listener()
    crew = _crew()
    task = _task("t1", role="researcher")
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_task_start(task, SimpleNamespace(task=task, task_id="t1"))
    assert lis.flush(timeout=5.0)
    before = len(rec.events)
    # Agent execution for the same task must NOT open a second session.
    lis._on_agent_start(task.agent, SimpleNamespace(agent=task.agent, task=task))
    assert lis.flush(timeout=5.0)
    # No new events from the redundant agent.start.
    assert len(rec.events) == before


# ── Full crew DAG (multiple tasks, one trace, no dangling links) ─────────────


def test_full_crew_dag_is_clean():
    lis, rec = _listener()
    crew = _crew()
    t1 = _task("t1", role="researcher")
    t2 = _task("t2", role="writer")

    lis._on_crew_start(crew, SimpleNamespace(crew=crew, crew_name="research-crew"))
    for t in (t1, t2):
        lis._on_task_start(t, SimpleNamespace(task=t, task_id=t.id))
        lis._on_tool_start(
            None, SimpleNamespace(tool_name="search", tool_args={"q": "x"}, from_task=t)
        )
        lis._on_tool_end(None, SimpleNamespace(tool_name="search", from_task=t, output="r"))
        lis._on_task_end(t, SimpleNamespace(task=t, task_id=t.id, output="done"), "completed")
    lis._on_crew_end(crew, SimpleNamespace(crew=crew), "completed")
    assert lis.flush(timeout=5.0)

    # One trace spans the whole kickoff.
    assert len({e["trace_id"] for e in rec.events}) == 1
    # Three sessions: crew + two tasks.
    assert len({e["session_id"] for e in rec.events}) == 3
    # Every causation_id resolves to a real emitted event.
    assert not _no_dangling(rec.events)
    # Each task produced a tool pair on its own session.
    assert sum(1 for e in rec.events if e["type"] == "tool.called") == 2
    assert sum(1 for e in rec.events if e["type"] == "tool.result") == 2


# ── Host-safety ──────────────────────────────────────────────────────────────


def test_emit_failure_does_not_propagate():
    class Boom:
        _server_url = "mock"

        def emit(self, event):
            raise RuntimeError("network down")

    lis = AEPCrewListener(Boom())
    crew = _crew()
    # Failures happen on the background worker; the host run is never affected.
    lis._on_crew_start(crew, SimpleNamespace(crew=crew))
    lis._on_crew_end(crew, SimpleNamespace(crew=crew), "completed")
    assert lis.flush(timeout=5.0)


def test_safe_wrapper_swallows_handler_errors():
    lis, rec = _listener()

    def boom(source, event):
        raise ValueError("listener bug")

    wrapped = lis._safe(boom)
    # Must not raise, even when called with the 3-arg (source, event, state) form.
    wrapped("src", object(), "runtime-state")
    assert rec.events == []


def test_untracked_task_end_is_ignored():
    lis, rec = _listener()
    task = _task("ghost", role="x")
    # Ending a task we never started must not emit or crash.
    lis._on_task_end(task, SimpleNamespace(task=task, task_id="ghost"), "completed")
    assert lis.flush(timeout=5.0)
    assert rec.events == []


# ── Guardrails (policy.blocked) ──────────────────────────────────────────────


def _guardrail_completed(
    *,
    success,
    error=None,
    retry_count=None,
    guardrail_name="pii_check",
    guardrail_type=None,
    from_task=None,
    task_id=None,
):
    # Mirrors crewai's LLMGuardrailCompletedEvent field set (success, result,
    # error, retry_count, guardrail_type/name, from_task; task_id via the base).
    return SimpleNamespace(
        success=success,
        result=None,
        error=error,
        retry_count=retry_count,
        guardrail_name=guardrail_name,
        guardrail_type=guardrail_type,
        from_task=from_task,
        task_id=task_id,
    )


def _crew_with_task(lis, *, tid="t1", role="researcher"):
    """Open a crew with one tracked task; return (crew, task)."""
    crew = _crew()
    lis._on_crew_start(crew, SimpleNamespace(crew=crew, crew_name="research-crew"))
    task = _task(tid, role=role)
    lis._on_task_start(task, SimpleNamespace(task=task, task_id=tid))
    return crew, task


def test_failed_guardrail_emits_policy_blocked_on_task_session():
    lis, rec = _listener()
    _, task = _crew_with_task(lis)
    lis._on_guardrail_completed(
        task,
        _guardrail_completed(
            success=False,
            error="output leaks PII",
            retry_count=1,
            from_task=task,
        ),
    )
    assert lis.flush(timeout=5.0)

    blocked = [e for e in rec.events if e["type"] == "policy.blocked"]
    assert len(blocked) == 1
    evt = blocked[0]
    task_created = next(
        e for e in rec.events
        if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    # Decision lands on the guarded task's session, joined via causation.
    assert evt["session_id"] == task_created["session_id"]
    assert evt["causation_id"] == task_created["id"]
    assert evt["subject"] == "pii_check"
    assert evt["payload"]["policy"] == "pii_check"
    assert evt["payload"]["reason"] == "output leaks PII"
    assert evt["payload"]["action_blocked"] == "task/researcher"
    assert evt["payload"]["framework"] == "crewai"
    assert evt["payload"]["retry_count"] == 1
    assert _no_dangling(rec.events) == []


def test_successful_guardrail_emits_nothing():
    lis, rec = _listener()
    _, task = _crew_with_task(lis)
    assert lis.flush(timeout=5.0)  # drain the open events before snapshotting
    before = len(rec.events)
    lis._on_guardrail_completed(
        task, _guardrail_completed(success=True, from_task=task)
    )
    assert lis.flush(timeout=5.0)
    assert len(rec.events) == before


def test_failed_guardrail_without_task_falls_back_to_crew():
    lis, rec = _listener()
    crew = _crew()
    lis._on_crew_start(crew, SimpleNamespace(crew=crew, crew_name="research-crew"))
    lis._on_guardrail_completed(
        crew, _guardrail_completed(success=False, error="bad output")
    )
    assert lis.flush(timeout=5.0)

    blocked = [e for e in rec.events if e["type"] == "policy.blocked"]
    assert len(blocked) == 1
    root = rec.events[0]
    assert blocked[0]["session_id"] == root["session_id"]
    assert blocked[0]["agent_role"] == "orchestrator"
    assert blocked[0]["payload"]["action_blocked"] == "crew/research-crew"


def test_failed_guardrail_with_nothing_tracked_drops_silently():
    lis, rec = _listener()
    lis._on_guardrail_completed(
        None, _guardrail_completed(success=False, error="bad output")
    )
    assert lis.flush(timeout=5.0)
    assert rec.events == []


def test_guardrail_policy_name_fallbacks():
    lis, rec = _listener()
    _, task = _crew_with_task(lis)
    lis._on_guardrail_completed(
        task,
        _guardrail_completed(
            success=False, guardrail_name=None, guardrail_type="hallucination",
            from_task=task,
        ),
    )
    lis._on_guardrail_completed(
        task,
        _guardrail_completed(
            success=False, guardrail_name=None, guardrail_type=None, from_task=task,
        ),
    )
    assert lis.flush(timeout=5.0)
    blocked = [e for e in rec.events if e["type"] == "policy.blocked"]
    assert [e["payload"]["policy"] for e in blocked] == ["hallucination", "guardrail"]
    # Synthesized reason names the policy when the event carries no error text.
    assert "hallucination" in blocked[0]["payload"]["reason"]


def test_failed_guardrail_without_retry_count_omits_it():
    lis, rec = _listener()
    _, task = _crew_with_task(lis)
    lis._on_guardrail_completed(
        task,
        _guardrail_completed(success=False, error="nope", from_task=task),
    )
    assert lis.flush(timeout=5.0)
    blocked = [e for e in rec.events if e["type"] == "policy.blocked"]
    assert len(blocked) == 1
    assert "retry_count" not in blocked[0]["payload"]


# ── Real event bus (only when CrewAI is installed) ──────────────────────────


def test_guardrail_event_registered_on_real_bus():
    pytest.importorskip("crewai", reason="crewai not installed")
    from crewai.events.event_bus import crewai_event_bus
    from crewai.events.types.llm_guardrail_events import LLMGuardrailCompletedEvent

    rec = _Recorder()
    lis = AEPCrewListener(rec)
    try:
        assert lis.subscribe() is True
        handlers = crewai_event_bus._sync_handlers.get(
            LLMGuardrailCompletedEvent, frozenset()
        )
        registered = {h for _, h in lis._registered}
        assert registered & set(handlers)
    finally:
        lis.unsubscribe()
        lis.close(timeout=1.0)


def test_subscribe_and_unsubscribe_against_real_bus():
    pytest.importorskip("crewai", reason="crewai not installed")
    from crewai.events.event_bus import crewai_event_bus
    from crewai.events.types.crew_events import CrewKickoffStartedEvent

    rec = _Recorder()
    lis = AEPCrewListener(rec)
    try:
        assert lis.subscribe() is True
        # Our handlers are registered on the bus for the crew-start event.
        handlers = crewai_event_bus._sync_handlers.get(CrewKickoffStartedEvent, frozenset())
        registered = {h for _, h in lis._registered}
        assert registered & set(handlers)

        lis.unsubscribe()
        handlers_after = crewai_event_bus._sync_handlers.get(
            CrewKickoffStartedEvent, frozenset()
        )
        assert not (registered & set(handlers_after))
    finally:
        lis.unsubscribe()
        lis.close(timeout=1.0)
