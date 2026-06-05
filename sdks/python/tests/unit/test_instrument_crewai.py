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


# ── Real event bus (only when CrewAI is installed) ──────────────────────────


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
