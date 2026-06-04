"""Unit tests for aep.instrument.

Split into two groups:

- **Dependency-free tests** — ID helpers, RunnableConfig injection, and the
  graceful-degradation path. These run anywhere.
- **Handler tests** — drive the real ``AEPCallbackHandler`` by simulating the
  LangChain callback sequence (``on_chain_start`` etc.) with a mock client and
  fabricated run_ids. They assert the AEP event types and causation links that a
  LangGraph run would produce, without needing LangGraph itself. Skipped if
  ``langchain-core`` is unavailable.
"""

from __future__ import annotations

import uuid

import pytest

from aep.instrument import (
    LangGraphInstrumentor,
    _build_callback_base,
    _config_with_handler,
    _inject_handler,
    _new_session_id,
    _new_trace_id,
    instrument,
)

_HAS_LANGCHAIN = _build_callback_base() is not None
requires_langchain = pytest.mark.skipif(
    not _HAS_LANGCHAIN, reason="langchain-core not installed"
)


# ── ID helpers (no deps) ─────────────────────────────────────────────────────


def test_session_id_format():
    sid = _new_session_id()
    assert sid.startswith("ses_") and len(sid) == len("ses_") + 12


def test_trace_id_format():
    tid = _new_trace_id()
    assert tid.startswith("trc_") and len(tid) == len("trc_") + 16


def test_ids_unique():
    assert len({_new_session_id() for _ in range(200)}) == 200


# ── RunnableConfig injection (no deps) ───────────────────────────────────────


def test_config_injection_none():
    cfg = _config_with_handler(None, "H")
    assert cfg["callbacks"] == ["H"]


def test_config_injection_appends_to_list():
    cfg = _config_with_handler({"callbacks": ["existing"]}, "H")
    assert cfg["callbacks"] == ["existing", "H"]


def test_config_injection_is_idempotent():
    h = object()
    cfg = _config_with_handler({"callbacks": [h]}, h)
    assert cfg["callbacks"].count(h) == 1


def test_config_injection_preserves_other_keys():
    cfg = _config_with_handler({"tags": ["a"], "recursion_limit": 10}, "H")
    assert cfg["tags"] == ["a"] and cfg["recursion_limit"] == 10
    assert cfg["callbacks"] == ["H"]


def test_config_injection_does_not_mutate_input():
    original = {"callbacks": []}
    _config_with_handler(original, "H")
    assert original == {"callbacks": []}  # untouched


def test_inject_handler_positional_config():
    # invoke(input, config) — config is positional arg index 1
    args, kwargs = _inject_handler("H", ("the-input", {"tags": ["x"]}), {})
    assert args[0] == "the-input"
    assert args[1]["callbacks"] == ["H"]
    assert "config" not in kwargs


def test_inject_handler_keyword_config():
    args, kwargs = _inject_handler("H", ("the-input",), {"config": {"tags": ["x"]}})
    assert kwargs["config"]["callbacks"] == ["H"]


def test_inject_handler_no_config_arg():
    # invoke(input) only — config materializes as a kwarg
    args, kwargs = _inject_handler("H", ("the-input",), {})
    assert kwargs["config"]["callbacks"] == ["H"]


# ── Graceful degradation ─────────────────────────────────────────────────────


def test_instrument_unknown_framework_is_noop():
    assert instrument(frameworks=["does-not-exist"]) is False


def test_instrument_noop_when_framework_unavailable(monkeypatch):
    # Force the LangGraph instrumentor to report "not installed".
    monkeypatch.setattr(LangGraphInstrumentor, "available", lambda self: False)
    assert instrument(frameworks=["langgraph"]) is False


# ── Handler behavior (simulated LangGraph callback sequence) ─────────────────


class _Recorder:
    """Stand-in AEPClient that records emitted events."""

    def __init__(self):
        self.events = []
        self._server_url = "mock"

    def emit(self, event):
        self.events.append(event)
        return {"accepted": True}


def _make_handler():
    base = _build_callback_base()
    rec = _Recorder()
    return base(rec), rec


def _by_id(events):
    return {e["id"]: e for e in events}


@requires_langchain
def test_root_graph_emits_orchestrator_task_pair():
    h, rec = _make_handler()
    root = uuid.uuid4()
    h.on_chain_start({"name": "g"}, {}, run_id=root, parent_run_id=None, name="g")
    h.on_chain_end({}, run_id=root)

    types = [e["type"] for e in rec.events]
    assert types == ["task.created", "task.completed"]
    assert all(e["agent_role"] == "orchestrator" for e in rec.events)
    # completed is caused by created
    assert rec.events[1]["causation_id"] == rec.events[0]["id"]
    # one shared trace
    assert len({e["trace_id"] for e in rec.events}) == 1


@requires_langchain
def test_node_run_links_to_orchestrator_via_handoff():
    h, rec = _make_handler()
    root, node = uuid.uuid4(), uuid.uuid4()
    h.on_chain_start({}, {}, run_id=root, parent_run_id=None, name="orchestrator")
    h.on_chain_start(
        {}, {}, run_id=node, parent_run_id=root, metadata={"langgraph_node": "worker"}
    )
    h.on_chain_end({}, run_id=node)
    h.on_chain_end({}, run_id=root)

    by_id = _by_id(rec.events)
    types = [e["type"] for e in rec.events]
    assert types == [
        "task.created",      # orchestrator opens
        "handoff.started",   # orchestrator -> worker
        "task.created",      # worker opens (subagent)
        "task.completed",    # worker done
        "handoff.completed", # orchestrator closes handoff
        "task.completed",    # orchestrator done
    ]

    orch_created, handoff_started, node_created, node_done, handoff_done, orch_done = rec.events

    # Causation DAG integrity
    assert handoff_started["causation_id"] == orch_created["id"]
    assert node_created["causation_id"] == handoff_started["id"]
    assert node_done["causation_id"] == node_created["id"]
    assert handoff_done["causation_id"] == handoff_started["id"]
    assert orch_done["causation_id"] == orch_created["id"]

    # Sub-agent points back to the orchestrator session
    assert node_created["agent_role"] == "subagent"
    assert node_created["parent_session_id"] == orch_created["session_id"]
    # Handoff events live on the orchestrator session with its role
    assert handoff_started["session_id"] == orch_created["session_id"]
    assert handoff_done["agent_role"] == "orchestrator"

    # No dangling causation references; single trace
    assert not [
        e["causation_id"]
        for e in rec.events
        if e.get("causation_id") and e["causation_id"] not in by_id
    ]
    assert len({e["trace_id"] for e in rec.events}) == 1


@requires_langchain
def test_node_error_emits_task_failed():
    h, rec = _make_handler()
    root, node = uuid.uuid4(), uuid.uuid4()
    h.on_chain_start({}, {}, run_id=root, parent_run_id=None, name="orch")
    h.on_chain_start(
        {}, {}, run_id=node, parent_run_id=root, metadata={"langgraph_node": "bad"}
    )
    h.on_chain_error(ValueError("boom"), run_id=node)

    failed = [e for e in rec.events if e["type"] == "task.failed"]
    assert len(failed) == 1
    assert failed[0]["payload"]["error"] == "boom"
    assert failed[0]["payload"]["error_type"] == "ValueError"
    assert failed[0]["agent_role"] == "subagent"
    # a handoff.completed with failed status closes the loop on the orchestrator
    hc = [e for e in rec.events if e["type"] == "handoff.completed"]
    assert hc and hc[0]["payload"]["status"] == "failed"


@requires_langchain
def test_tool_call_emits_called_and_result():
    h, rec = _make_handler()
    root, node, tool = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    h.on_chain_start({}, {}, run_id=root, parent_run_id=None, name="orch")
    h.on_chain_start(
        {}, {}, run_id=node, parent_run_id=root, metadata={"langgraph_node": "w"}
    )
    h.on_tool_start(
        {"name": "search"}, "query text", run_id=tool, parent_run_id=node,
        inputs={"q": "query text"},
    )
    h.on_tool_end("the result", run_id=tool)

    called = next(e for e in rec.events if e["type"] == "tool.called")
    result = next(e for e in rec.events if e["type"] == "tool.result")
    assert called["payload"]["tool_name"] == "search"
    assert called["payload"]["arguments"] == {"q": "query text"}
    # tool runs on the node's session, caused by the node's task.created
    node_created = next(
        e for e in rec.events if e["type"] == "task.created" and e["agent_role"] == "subagent"
    )
    assert called["session_id"] == node_created["session_id"]
    assert called["causation_id"] == node_created["id"]
    # result chains off the call
    assert result["causation_id"] == called["id"]
    assert result["payload"]["output"] == "the result"


@requires_langchain
def test_tool_error_emits_error_raised():
    h, rec = _make_handler()
    root, tool = uuid.uuid4(), uuid.uuid4()
    h.on_chain_start({}, {}, run_id=root, parent_run_id=None, name="orch")
    h.on_tool_start({"name": "t"}, "in", run_id=tool, parent_run_id=root)
    h.on_tool_error(RuntimeError("nope"), run_id=tool)

    err = next(e for e in rec.events if e["type"] == "error.raised")
    assert err["payload"]["error_type"] == "RuntimeError"
    assert err["payload"]["tool_name"] == "t"


@requires_langchain
def test_untracked_end_is_ignored():
    # on_chain_end for a run we never opened must not emit or crash.
    h, rec = _make_handler()
    h.on_chain_end({}, run_id=uuid.uuid4())
    assert rec.events == []


@requires_langchain
def test_emit_failure_does_not_propagate():
    # A failing client must never break the host workflow.
    base = _build_callback_base()

    class Boom:
        _server_url = "mock"

        def emit(self, event):
            raise RuntimeError("network down")

    h = base(Boom())
    root = uuid.uuid4()
    # Should not raise despite emit() always failing.
    h.on_chain_start({}, {}, run_id=root, parent_run_id=None, name="g")
    h.on_chain_end({}, run_id=root)
