"""Framework auto-instrumentation for AEP.

``aep.instrument()`` patches supported agent frameworks so that running a
workflow automatically emits AEP events — no other code changes required.

Two frameworks are supported today:

- **LangGraph** (``langgraph>=0.1``) — instrumented via a LangChain
  ``BaseCallbackHandler`` injected into every ``CompiledStateGraph`` execution.
- **CrewAI** (``crewai>=1.0``) — instrumented by subscribing to CrewAI's own
  event bus (``crewai.events``); CrewAI does *not* use LangChain callbacks.

Both transports map framework lifecycle onto the same AEP event vocabulary:

- run open (root)         → ``task.created``                       (orchestrator)
- run open (sub-agent)    → ``handoff.started`` + ``task.created``  (subagent)
- run close               → ``task.completed`` / ``task.failed`` (+ ``handoff.completed``)
- tool call               → ``tool.called`` / ``tool.result`` / ``error.raised``

Causation is preserved end-to-end: every event carries a ``trace_id`` shared
across the whole run, a per-run ``session_id``, a ``parent_session_id`` linking
sub-agents to their orchestrator, and a ``causation_id`` pointing at the event
that triggered it — so a multi-agent run reconstructs as a DAG in the AEP
dashboard.

The lifecycle→event mapping, the background emitter, run bookkeeping, and the ID
helpers all live in the transport-neutral :class:`_EmissionCore`. Each framework
transport (the LangChain handler, the CrewAI listener) is a thin adapter that
translates its native callbacks into ``_EmissionCore`` calls. Adding a framework
means registering a new :class:`FrameworkInstrumentor` that builds the right
transport for it — see ``LangGraphInstrumentor`` / ``CrewAIInstrumentor``.

Usage::

    import aep
    aep.instrument()                 # reads AEP_INGEST_URL / AEP_API_KEY
    # ... build and run your LangGraph graph / CrewAI crew as usual ...

Design rules:
- **Never crash the host app.** Missing frameworks → warn + no-op. Emit failures
  → logged, swallowed. Unexpected framework internals → warn + skip, never raise.
"""

from __future__ import annotations

import atexit
import logging
import queue
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from aep.client import AEPClient

logger = logging.getLogger(__name__)

# Tested-against version floors; surfaced in warnings to aid debugging.
MIN_LANGGRAPH_VERSION = "0.1"
# Floor at which the `crewai.events` bus layout this listener maps was verified.
# Developed and tested against 1.14.x; earlier 1.x releases (where the event API
# may differ) degrade to a clean no-op via CrewAIInstrumentor.available(), so this
# is a best-effort hint, not a hard gate — the real gate is "do the event classes
# import?". Bump this if a lower release is confirmed working.
MIN_CREWAI_VERSION = "1.0"

# Defaults for the background emitter and run bookkeeping.
DEFAULT_QUEUE_SIZE = 10_000   # max buffered events before we drop (and warn)
DEFAULT_MAX_RUNS = 10_000     # max in-flight runs tracked before evicting oldest


def _crewai_version() -> str:
    """Best-effort installed CrewAI version, for diagnostics in warnings."""
    try:
        import crewai

        return str(getattr(crewai, "__version__", "unknown"))
    except Exception:
        return "not installed"


# Module-level registry of framework instrumentors, populated at import time.
_INSTRUMENTORS: dict[str, "FrameworkInstrumentor"] = {}

# The client used by all active instrumentation. Set by instrument().
_state_lock = threading.Lock()
_active_client: Optional["AEPClient"] = None
_owns_client = False


# ── Background emitter ───────────────────────────────────────────────────────


class _Emitter:
    """Sends events on a background thread so callbacks never block on network I/O.

    Event *ids* are generated synchronously by ``create_event`` before submission,
    so causation chains are intact regardless of when the HTTP POST happens. A
    single worker drains a FIFO queue, preserving emission order. The queue is
    bounded: under sustained overload we drop events and log loudly (never
    silently) rather than grow without limit or block the host workflow.
    """

    def __init__(self, client: Any, max_queue: int = DEFAULT_QUEUE_SIZE) -> None:
        self._client = client
        self._q: "queue.Queue[dict]" = queue.Queue(maxsize=max_queue)
        self._dropped = 0
        self._stop = threading.Event()
        self._worker = threading.Thread(
            target=self._run, name="aep-emit", daemon=True
        )
        self._worker.start()
        # Flush on normal interpreter exit (the daemon worker would otherwise be
        # killed with events still queued).
        atexit.register(self._atexit_flush)

    def submit(self, event: dict) -> None:
        try:
            self._q.put_nowait(event)
        except queue.Full:
            self._dropped += 1
            # Log on the first drop and then sparsely, so we never spam but never
            # hide that telemetry was lost.
            if self._dropped == 1 or self._dropped % 100 == 0:
                logger.warning(
                    "AEP: emit queue full — dropped %d event(s) so far. "
                    "The ingest endpoint may be slow or unreachable.",
                    self._dropped,
                )

    def _run(self) -> None:
        while not self._stop.is_set() or not self._q.empty():
            try:
                event = self._q.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                self._client.emit(event)
            except Exception as e:
                logger.warning("AEP: failed to emit %s event: %s", event.get("type"), e)
            finally:
                self._q.task_done()

    def flush(self, timeout: float = 5.0) -> bool:
        """Block until queued events are sent (or ``timeout`` elapses).

        Returns ``True`` if the queue drained within the timeout.
        """
        done = threading.Event()

        def _waiter() -> None:
            self._q.join()
            done.set()

        threading.Thread(target=_waiter, name="aep-flush", daemon=True).start()
        return done.wait(timeout)

    def close(self, timeout: float = 5.0) -> None:
        """Flush, then stop the worker. Does not close the underlying client."""
        self.flush(timeout)
        self._stop.set()
        self._worker.join(timeout=1.0)
        try:
            atexit.unregister(self._atexit_flush)
        except Exception:
            pass

    def _atexit_flush(self) -> None:  # pragma: no cover - exercised at exit
        self.flush(timeout=2.0)


# ── ID helpers ──────────────────────────────────────────────────────────────


def _new_session_id() -> str:
    return f"ses_{uuid.uuid4().hex[:12]}"


def _new_trace_id() -> str:
    return f"trc_{uuid.uuid4().hex[:16]}"


def _stringify(value: Any) -> Any:
    """Keep JSON-safe values as-is; stringify everything else for transport."""
    if isinstance(value, (str, int, float, bool, dict, list)) or value is None:
        return value
    return str(value)


def _error_fields(error: Any) -> tuple[str, str]:
    """Return ``(message, error_type)`` for any error value.

    Frameworks hand us either a live exception (LangGraph) or a pre-stringified
    message (some CrewAI events). Exceptions get their class name; everything
    else gets a generic label so the payload shape stays uniform.
    """
    if isinstance(error, BaseException):
        return str(error), type(error).__name__
    if error is None:
        return "", "Error"
    return str(error), "Error"


# ── Run bookkeeping ─────────────────────────────────────────────────────────


@dataclass
class _RunInfo:
    """Tracks one in-flight run (orchestrator, sub-agent, or tool) by its key."""

    session_id: str
    trace_id: str
    source: str
    name: str
    kind: str  # framework-specific: "graph"/"node"/"crew"/"task"/"agent"/"tool"
    # Event id of this run's opening event (task.created or tool.called); used as
    # the causation_id for the run's children and its own closing event.
    open_event_id: str
    agent_role: Optional[str] = None
    parent_session_id: Optional[str] = None
    # For sub-agent runs: the handoff.started event id on the parent session, so
    # the matching handoff.completed can chain off it.
    handoff_event_id: Optional[str] = None
    # For sub-agent runs: the parent (orchestrator) role, so handoff.completed —
    # which is emitted on the parent session — reads the parent's role.
    parent_agent_role: Optional[str] = None


# ── Transport-neutral emission core ─────────────────────────────────────────


class _EmissionCore:
    """Framework-agnostic AEP emission machinery.

    Owns the background emitter and the in-flight run table, and exposes the
    lifecycle→event mapping as semantic operations:

    - :meth:`open_agent_run` / :meth:`close_agent_run` — a task/agent/graph/node
      run (root → orchestrator, child → sub-agent with a handoff off its parent).
    - :meth:`open_tool_run` / :meth:`close_tool_run` / :meth:`fail_tool_run` —
      a tool invocation (``tool.called`` / ``tool.result`` / ``error.raised``).

    Every framework transport (LangChain handler, CrewAI listener) drives the
    same core, so a new framework never re-implements causation/session/trace
    threading. Runs are addressed by an opaque string ``key`` chosen by the
    transport (e.g. a LangChain ``run_id`` or a CrewAI ``task:<id>``); key
    namespaces are the transport's responsibility.

    All state is lock-guarded because frameworks run sibling agents concurrently.
    """

    def __init__(self, client: Any, max_runs: int = DEFAULT_MAX_RUNS) -> None:
        self._emitter = _Emitter(client)
        self._lock = threading.Lock()
        self._runs: "OrderedDict[str, _RunInfo]" = OrderedDict()
        self._max_runs = max_runs
        self._evicted = 0

    # -- lifecycle ------------------------------------------------------------

    def flush(self, timeout: float = 5.0) -> bool:
        """Block until queued telemetry is sent (or the timeout elapses)."""
        return self._emitter.flush(timeout)

    def close(self, timeout: float = 5.0) -> None:
        """Flush pending telemetry and stop the background worker."""
        self._emitter.close(timeout)

    # -- emission -------------------------------------------------------------

    def _emit(self, **kwargs: Any) -> Optional[str]:
        """Build an event and hand it to the background emitter.

        The id is generated synchronously so callers can chain ``causation_id``
        off it immediately, even though the HTTP POST happens off-thread.
        Returns the event id, or None if the event could not be built.
        """
        from aep import create_event

        try:
            event = create_event(**kwargs)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: failed to build %s event: %s", kwargs.get("type"), e)
            return None
        # Hand off to the background worker; never blocks on the network here.
        self._emitter.submit(event)
        return event["id"]

    # -- run table ------------------------------------------------------------

    def get(self, key: Any) -> Optional[_RunInfo]:
        with self._lock:
            return self._runs.get(str(key))

    def _put(self, key: Any, info: _RunInfo) -> None:
        with self._lock:
            self._runs[str(key)] = info
            # Bound memory: if runs accumulate (e.g. a run never gets an
            # end/error callback), evict the oldest. This can orphan that
            # run's closing event, but only under abnormal accumulation —
            # we warn so it's never a silent loss.
            while len(self._runs) > self._max_runs:
                self._runs.popitem(last=False)
                self._evicted += 1
                if self._evicted == 1 or self._evicted % 100 == 0:
                    logger.warning(
                        "AEP: tracked-run cap (%d) exceeded — evicted %d stale "
                        "run(s); some end events may be unmatched.",
                        self._max_runs,
                        self._evicted,
                    )

    def _pop(self, key: Any) -> Optional[_RunInfo]:
        with self._lock:
            return self._runs.pop(str(key), None)

    # -- agent/task runs ------------------------------------------------------

    def open_agent_run(
        self,
        key: Any,
        *,
        name: str,
        framework: str,
        kind: str,
        parent_key: Any = None,
    ) -> Optional[str]:
        """Open an agent/task run, returning its ``task.created`` event id.

        With no tracked parent the run is the **orchestrator** root (new
        ``trace_id`` + ``session_id``). With a tracked parent it is a
        **sub-agent**: a ``handoff.started`` is emitted on the parent's session,
        then the sub-agent's ``task.created`` chains off that handoff.
        """
        parent = self.get(parent_key) if parent_key is not None else None
        source = f"agent://{name}"

        if parent is None:
            session_id = _new_session_id()
            trace_id = _new_trace_id()
            open_id = self._emit(
                source=source,
                type="task.created",
                session_id=session_id,
                trace_id=trace_id,
                agent_role="orchestrator",
                subject=name,
                payload={"framework": framework, "node": name, "kind": kind},
            )
            self._put(
                key,
                _RunInfo(
                    session_id=session_id,
                    trace_id=trace_id,
                    source=source,
                    name=name,
                    kind=kind,
                    open_event_id=open_id or "",
                    agent_role="orchestrator",
                ),
            )
            return open_id

        # Sub-agent: hand off from the parent, then open the sub-agent task.
        session_id = _new_session_id()
        trace_id = parent.trace_id
        handoff_id = self._emit(
            source=parent.source,
            type="handoff.started",
            session_id=parent.session_id,
            trace_id=trace_id,
            agent_role=parent.agent_role,
            subject=name,
            causation_id=parent.open_event_id or None,
            payload={"from_agent": parent.name, "to_agent": name},
        )
        open_id = self._emit(
            source=source,
            type="task.created",
            session_id=session_id,
            trace_id=trace_id,
            agent_role="subagent",
            parent_session_id=parent.session_id,
            subject=name,
            causation_id=handoff_id or parent.open_event_id or None,
            payload={"framework": framework, "node": name, "kind": kind},
        )
        self._put(
            key,
            _RunInfo(
                session_id=session_id,
                trace_id=trace_id,
                source=source,
                name=name,
                kind=kind,
                open_event_id=open_id or "",
                agent_role="subagent",
                parent_session_id=parent.session_id,
                handoff_event_id=handoff_id,
                parent_agent_role=parent.agent_role,
            ),
        )
        return open_id

    def close_agent_run(self, key: Any, *, status: str, error: Any = None) -> None:
        """Close an agent/task run with ``status`` in ``{"completed","failed"}``.

        Emits ``task.completed``/``task.failed`` on the run's own session, then a
        ``handoff.completed`` on the parent session if the run was a sub-agent.
        """
        info = self._pop(key)
        if info is None:
            return
        if status == "failed":
            message, error_type = _error_fields(error)
            self._emit(
                source=info.source,
                type="task.failed",
                session_id=info.session_id,
                trace_id=info.trace_id,
                agent_role=info.agent_role,
                parent_session_id=info.parent_session_id,
                subject=info.name,
                causation_id=info.open_event_id or None,
                payload={
                    "node": info.name,
                    "status": "failed",
                    "error": message,
                    "error_type": error_type,
                },
            )
        else:
            self._emit(
                source=info.source,
                type="task.completed",
                session_id=info.session_id,
                trace_id=info.trace_id,
                agent_role=info.agent_role,
                parent_session_id=info.parent_session_id,
                subject=info.name,
                causation_id=info.open_event_id or None,
                payload={"node": info.name, "status": "completed"},
            )
        self._close_handoff(info, status=status)

    def _close_handoff(self, info: _RunInfo, *, status: str) -> None:
        # Only sub-agent runs carry a handoff to close. Emitted on the parent
        # (orchestrator) session, chained off the matching handoff.started.
        if not info.handoff_event_id:
            return
        self._emit(
            source=info.source,
            type="handoff.completed",
            session_id=info.parent_session_id or info.session_id,
            trace_id=info.trace_id,
            agent_role=info.parent_agent_role,
            subject=info.name,
            causation_id=info.handoff_event_id,
            payload={"from_agent": info.name, "status": status},
        )

    # -- tool runs ------------------------------------------------------------

    def open_tool_run(
        self,
        key: Any,
        *,
        name: str,
        arguments: Any,
        parent_key: Any = None,
    ) -> Optional[str]:
        """Open a tool run (``tool.called``), inheriting its parent's session.

        A tool invoked outside any tracked run becomes a standalone pair on a
        fresh session/trace with ``agent_role="standalone"``.
        """
        parent = self.get(parent_key) if parent_key is not None else None
        if parent is not None:
            session_id = parent.session_id
            trace_id = parent.trace_id
            source = parent.source
            agent_role = parent.agent_role
            parent_session_id = parent.parent_session_id
            causation = parent.open_event_id or None
        else:
            session_id = _new_session_id()
            trace_id = _new_trace_id()
            source = f"agent://{name}"
            agent_role = "standalone"
            parent_session_id = None
            causation = None

        open_id = self._emit(
            source=source,
            type="tool.called",
            session_id=session_id,
            trace_id=trace_id,
            agent_role=agent_role,
            parent_session_id=parent_session_id,
            subject=name,
            causation_id=causation,
            payload={"tool_name": name, "arguments": arguments},
        )
        self._put(
            key,
            _RunInfo(
                session_id=session_id,
                trace_id=trace_id,
                source=source,
                name=name,
                kind="tool",
                open_event_id=open_id or "",
                agent_role=agent_role,
                parent_session_id=parent_session_id,
            ),
        )
        return open_id

    def close_tool_run(self, key: Any, *, output: Any) -> None:
        """Close a tool run with a ``tool.result``."""
        info = self._pop(key)
        if info is None:
            return
        self._emit(
            source=info.source,
            type="tool.result",
            session_id=info.session_id,
            trace_id=info.trace_id,
            agent_role=info.agent_role,
            parent_session_id=info.parent_session_id,
            subject=info.name,
            causation_id=info.open_event_id or None,
            payload={"tool_name": info.name, "output": _stringify(output)},
        )

    def fail_tool_run(self, key: Any, *, error: Any) -> None:
        """Close a tool run with an ``error.raised``."""
        info = self._pop(key)
        if info is None:
            return
        message, error_type = _error_fields(error)
        self._emit(
            source=info.source,
            type="error.raised",
            session_id=info.session_id,
            trace_id=info.trace_id,
            agent_role=info.agent_role,
            parent_session_id=info.parent_session_id,
            subject=info.name,
            causation_id=info.open_event_id or None,
            payload={
                "tool_name": info.name,
                "error": message,
                "error_type": error_type,
            },
        )


# ── LangChain callback handler (LangGraph transport) ────────────────────────


def _build_callback_base():
    """Return a BaseCallbackHandler subclass, or None if LangChain is absent.

    Defined lazily so importing ``aep`` never hard-depends on LangChain, and so
    ``aep.instrument()`` for a non-LangChain framework (e.g. CrewAI) does not
    require ``langchain-core`` to be installed.
    """
    try:
        from langchain_core.callbacks import BaseCallbackHandler
    except Exception:  # pragma: no cover - exercised only without langchain
        return None

    class AEPCallbackHandler(BaseCallbackHandler):
        """Translates LangChain/LangGraph callbacks into :class:`_EmissionCore` calls.

        A thin transport adapter: it decides *which* runs to track (the graph
        root and LangGraph nodes; intermediate runnables are ignored) and hands
        the rest — sessions, traces, causation, handoffs, emission — to the core.
        One handler instance is shared across graph runs.
        """

        # We never raise out of a callback — partial telemetry beats a crashed app.
        raise_error = False

        def __init__(self, client: "AEPClient", max_runs: int = DEFAULT_MAX_RUNS) -> None:
            self._core = _EmissionCore(client, max_runs=max_runs)

        # -- lifecycle / introspection ---------------------------------------

        @property
        def _runs(self):  # exposed for tests + run-cap assertions
            return self._core._runs

        @property
        def _evicted(self):  # exposed for tests
            return self._core._evicted

        def flush(self, timeout: float = 5.0) -> bool:
            """Block until queued telemetry is sent (or the timeout elapses)."""
            return self._core.flush(timeout)

        def close(self, timeout: float = 5.0) -> None:
            """Flush pending telemetry and stop the background worker."""
            self._core.close(timeout)

        # -- chain (graph + node) hooks --------------------------------------

        def on_chain_start(
            self,
            serialized: Optional[dict],
            inputs: Any,
            *,
            run_id: Any,
            parent_run_id: Any = None,
            tags: Optional[list] = None,
            metadata: Optional[dict] = None,
            **kwargs: Any,
        ) -> None:
            meta = metadata or {}
            node_name = meta.get("langgraph_node")

            # We only model two kinds of chains:
            #   - the graph root (no parent)               → orchestrator
            #   - a langgraph node with a tracked parent   → subagent
            # Other intermediate runnables are ignored to keep the event stream clean.
            is_root = parent_run_id is None
            if not is_root and node_name is None:
                return
            parent_key = None if is_root else str(parent_run_id)
            if parent_key is not None and self._core.get(parent_key) is None:
                # Node whose parent we didn't track (unexpected) — treat as root.
                is_root = True
                parent_key = None

            name = node_name or kwargs.get("name") or (serialized or {}).get("name") or "graph"
            kind = "graph" if is_root else "node"
            self._core.open_agent_run(
                str(run_id),
                name=name,
                framework="langgraph",
                kind=kind,
                parent_key=parent_key,
            )

        def on_chain_end(self, outputs: Any, *, run_id: Any, **kwargs: Any) -> None:
            self._core.close_agent_run(str(run_id), status="completed")

        def on_chain_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None:
            self._core.close_agent_run(str(run_id), status="failed", error=error)

        # -- tool hooks -------------------------------------------------------

        def on_tool_start(
            self,
            serialized: Optional[dict],
            input_str: str,
            *,
            run_id: Any,
            parent_run_id: Any = None,
            tags: Optional[list] = None,
            metadata: Optional[dict] = None,
            inputs: Optional[dict] = None,
            **kwargs: Any,
        ) -> None:
            parent_key = str(parent_run_id) if parent_run_id is not None else None
            tool_name = (serialized or {}).get("name") or kwargs.get("name") or "tool"
            arguments = inputs if isinstance(inputs, dict) else {"input": input_str}
            self._core.open_tool_run(
                str(run_id),
                name=tool_name,
                arguments=arguments,
                parent_key=parent_key,
            )

        def on_tool_end(self, output: Any, *, run_id: Any, **kwargs: Any) -> None:
            self._core.close_tool_run(str(run_id), output=output)

        def on_tool_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None:
            self._core.fail_tool_run(str(run_id), error=error)

    return AEPCallbackHandler


# ── CrewAI event-bus listener (CrewAI transport) ────────────────────────────


class AEPCrewListener:
    """Translates CrewAI event-bus events into :class:`_EmissionCore` calls.

    CrewAI does not use LangChain callbacks — it publishes lifecycle events on
    ``crewai.events.crewai_event_bus``. This listener subscribes to the crew,
    task, agent, and tool events and maps them onto AEP's vocabulary:

    - ``CrewKickoffStarted``  → orchestrator ``task.created`` (root; new trace)
    - ``TaskStarted``         → sub-agent ``task.created`` (handoff off the crew),
      named for the agent assigned to the task
    - ``ToolUsageStarted``    → ``tool.called`` on the active task/agent session
    - ``TaskCompleted/Failed``→ ``task.completed`` / ``task.failed`` (+ handoff)
    - ``CrewKickoffCompleted/Failed`` → orchestrator close

    Nesting note: CrewAI fires ``TaskStarted`` *then* ``AgentExecutionStarted``
    inside it, so a Task wraps its Agent execution. We therefore make the **Task**
    the sub-agent session and fold the agent into it; an ``AgentExecution`` that
    runs outside any tracked task (e.g. a hierarchical manager) opens its own
    agent-keyed sub-agent session as a fallback.

    The listener never imports CrewAI at construction — only :meth:`subscribe`
    touches ``crewai`` — so the mapping is unit-testable without CrewAI installed.
    """

    def __init__(self, client: Any, max_runs: int = DEFAULT_MAX_RUNS) -> None:
        self._core = _EmissionCore(client, max_runs=max_runs)
        self._lock = threading.Lock()
        # Stack of open crew run keys; the top is the parent for new tasks/agents.
        self._crew_stack: list[str] = []
        # Open tool invocations as a LIFO of (scope_token, run_key). Each tool
        # gets a unique run_key (via _tool_seq) so concurrent or repeated tools
        # in the same scope never collide on the run table, and a close event
        # matches the most-recent open tool in its scope — falling back to
        # global LIFO if the close event resolved a different scope than the
        # open (e.g. CrewAI omitted from_task on the finished event). See
        # _push_tool_run / _pop_tool_run. Bounded to _max_open_tools (oldest
        # evicted, warned) so a never-closed tool start can't grow it unbounded.
        self._open_tools: list[tuple[str, str]] = []
        self._tool_seq = 0
        self._max_open_tools = max_runs
        self._tool_evicted = 0
        self._registered: list[tuple[Any, Any]] = []
        self._bus: Any = None

    # -- lifecycle / introspection -------------------------------------------

    @property
    def _runs(self):  # exposed for tests
        return self._core._runs

    def flush(self, timeout: float = 5.0) -> bool:
        return self._core.flush(timeout)

    def close(self, timeout: float = 5.0) -> None:
        self._core.close(timeout)

    # -- subscription ---------------------------------------------------------

    def subscribe(self) -> bool:
        """Subscribe to the CrewAI event bus. Returns success.

        Returns ``False`` (and warns) if CrewAI's event API is absent or its
        shape has drifted from what we map — never raises.
        """
        try:
            from crewai.events.event_bus import crewai_event_bus
            from crewai.events.types.agent_events import (
                AgentExecutionCompletedEvent,
                AgentExecutionErrorEvent,
                AgentExecutionStartedEvent,
            )
            from crewai.events.types.crew_events import (
                CrewKickoffCompletedEvent,
                CrewKickoffFailedEvent,
                CrewKickoffStartedEvent,
            )
            from crewai.events.types.task_events import (
                TaskCompletedEvent,
                TaskFailedEvent,
                TaskStartedEvent,
            )
            from crewai.events.types.tool_usage_events import (
                ToolUsageErrorEvent,
                ToolUsageFinishedEvent,
                ToolUsageStartedEvent,
            )
        except Exception as e:
            logger.warning(
                "AEP: CrewAI event API not found (crewai>=%s expected, installed: %s); "
                "instrumentation disabled: %s",
                MIN_CREWAI_VERSION,
                _crewai_version(),
                e,
            )
            return False

        mapping = [
            (CrewKickoffStartedEvent, self._on_crew_start),
            (CrewKickoffCompletedEvent, lambda s, e: self._on_crew_end(s, e, "completed")),
            (CrewKickoffFailedEvent, lambda s, e: self._on_crew_end(s, e, "failed")),
            (TaskStartedEvent, self._on_task_start),
            (TaskCompletedEvent, lambda s, e: self._on_task_end(s, e, "completed")),
            (TaskFailedEvent, lambda s, e: self._on_task_end(s, e, "failed")),
            (AgentExecutionStartedEvent, self._on_agent_start),
            (AgentExecutionCompletedEvent, lambda s, e: self._on_agent_end(s, e, "completed")),
            (AgentExecutionErrorEvent, lambda s, e: self._on_agent_end(s, e, "failed")),
            (ToolUsageStartedEvent, self._on_tool_start),
            (ToolUsageFinishedEvent, self._on_tool_end),
            (ToolUsageErrorEvent, self._on_tool_error),
        ]
        registered: list[tuple[Any, Any]] = []
        for event_cls, fn in mapping:
            handler = self._safe(fn)
            try:
                crewai_event_bus.on(event_cls)(handler)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("AEP: could not subscribe to %s: %s", event_cls, e)
                continue
            registered.append((event_cls, handler))

        if not registered:
            logger.warning("AEP: subscribed to no CrewAI events; instrumentation disabled.")
            return False

        self._bus = crewai_event_bus
        self._registered = registered
        return True

    def unsubscribe(self) -> None:
        """Best-effort: remove every handler we registered from the bus."""
        bus = self._bus
        if bus is None:
            return
        for event_cls, handler in self._registered:
            try:
                bus.off(event_cls, handler)
            except Exception:  # pragma: no cover - defensive
                pass
        self._registered = []
        self._bus = None

    # -- event handlers -------------------------------------------------------

    def _safe(self, fn):
        """Wrap a handler so a CrewAI callback never raises into the host run.

        CrewAI handlers may be invoked with ``(source, event)`` or
        ``(source, event, state)`` — we accept and ignore any extra args.
        """

        def handler(source: Any, event: Any, *_extra: Any) -> None:
            try:
                fn(source, event)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning(
                    "AEP: crew listener error on %s: %s", type(event).__name__, e
                )

        return handler

    def _on_crew_start(self, source: Any, event: Any) -> None:
        key = f"crew:{id(source)}"
        name = self._crew_name(event, source)
        self._core.open_agent_run(
            key, name=name, framework="crewai", kind="crew", parent_key=None
        )
        with self._lock:
            self._crew_stack.append(key)

    def _on_crew_end(self, source: Any, event: Any, status: str) -> None:
        key = f"crew:{id(source)}"
        with self._lock:
            if key in self._crew_stack:
                self._crew_stack.remove(key)
        self._core.close_agent_run(key, status=status, error=getattr(event, "error", None))

    def _on_task_start(self, source: Any, event: Any) -> None:
        task = getattr(event, "task", None) or source
        tid = self._task_id(event, task)
        if tid is None:
            # No stable id to key the task by — skip rather than risk mismatched
            # open/close. Logged (not silent) so event-shape drift is diagnosable.
            logger.debug("AEP: TaskStarted with no resolvable task id; skipping.")
            return
        name = (
            self._agent_role(getattr(task, "agent", None))
            or getattr(event, "task_name", None)
            or self._task_name(task)
        )
        self._core.open_agent_run(
            f"task:{tid}",
            name=name,
            framework="crewai",
            kind="task",
            parent_key=self._current_crew(),
        )

    def _on_task_end(self, source: Any, event: Any, status: str) -> None:
        task = getattr(event, "task", None) or source
        tid = self._task_id(event, task)
        if tid is None:
            logger.debug("AEP: Task%s with no resolvable task id; skipping.", status.title())
            return
        self._core.close_agent_run(
            f"task:{tid}", status=status, error=getattr(event, "error", None)
        )

    def _on_agent_start(self, source: Any, event: Any) -> None:
        # If this agent execution belongs to a tracked task, the task session
        # already represents it — don't open a second session.
        task = getattr(event, "task", None)
        tid = self._task_id(event, task) if task is not None else None
        if tid is not None and self._core.get(f"task:{tid}") is not None:
            return
        agent = getattr(event, "agent", None) or source
        self._core.open_agent_run(
            f"agent:{id(agent)}",
            name=self._agent_role(agent) or "agent",
            framework="crewai",
            kind="agent",
            parent_key=self._current_crew(),
        )

    def _on_agent_end(self, source: Any, event: Any, status: str) -> None:
        agent = getattr(event, "agent", None) or source
        key = f"agent:{id(agent)}"
        if self._core.get(key) is None:
            # Folded into its task's session — nothing of our own to close.
            return
        self._core.close_agent_run(key, status=status, error=getattr(event, "error", None))

    def _on_tool_start(self, source: Any, event: Any) -> None:
        scope, parent_key = self._tool_scope(event)
        tool_name = getattr(event, "tool_name", None) or "tool"
        args = getattr(event, "tool_args", None)
        arguments = args if isinstance(args, dict) else {"input": _stringify(args)}
        run_key = self._push_tool_run(scope)
        self._core.open_tool_run(
            run_key, name=tool_name, arguments=arguments, parent_key=parent_key
        )

    def _on_tool_end(self, source: Any, event: Any) -> None:
        run_key = self._pop_tool_run(event)
        if run_key is None:
            return
        self._core.close_tool_run(run_key, output=getattr(event, "output", None))

    def _on_tool_error(self, source: Any, event: Any) -> None:
        run_key = self._pop_tool_run(event)
        if run_key is None:
            return
        self._core.fail_tool_run(run_key, error=getattr(event, "error", None))

    def _push_tool_run(self, scope: Any) -> str:
        """Register a new open tool invocation under ``scope`` and return its key.

        The key is unique per invocation (a monotonic sequence), so two tools in
        the same scope — concurrent or back-to-back — never share a run-table key.
        """
        with self._lock:
            self._tool_seq += 1
            run_key = f"tool:{scope}:{self._tool_seq}"
            self._open_tools.append((str(scope), run_key))
            # Bound memory: if tool starts accumulate without matching closes
            # (abnormal — a tool never fired its finish/error), drop the oldest.
            # This can orphan that tool's result, but only under accumulation —
            # we warn so it's never a silent loss. (The core run table is capped
            # independently; this just bounds our open-tool index.)
            while len(self._open_tools) > self._max_open_tools:
                self._open_tools.pop(0)
                self._tool_evicted += 1
                if self._tool_evicted == 1 or self._tool_evicted % 100 == 0:
                    logger.warning(
                        "AEP: open-tool cap (%d) exceeded — evicted %d stale tool "
                        "start(s); some tool results may be unmatched.",
                        self._max_open_tools,
                        self._tool_evicted,
                    )
        return run_key

    def _pop_tool_run(self, event: Any) -> Optional[str]:
        """Return the run key the closing ``event`` should close, or None.

        Prefers the most-recent open tool whose scope matches the closing event.
        If none matches — the close event resolved a different scope than the
        open (e.g. CrewAI didn't echo ``from_task`` on the finished event) — it
        falls back to the most-recent open tool on *any* scope so the pair still
        closes instead of leaving a dangling ``tool.called``. Returns None only
        when no tool is open at all.
        """
        scope = str(self._tool_scope(event)[0])
        with self._lock:
            for i in range(len(self._open_tools) - 1, -1, -1):
                if self._open_tools[i][0] == scope:
                    return self._open_tools.pop(i)[1]
            if self._open_tools:
                logger.debug(
                    "AEP: tool close resolved scope %r with no matching open "
                    "tool; closing most-recent open tool instead.",
                    scope,
                )
                return self._open_tools.pop()[1]
        return None

    # -- field extraction (defensive against CrewAI version drift) -----------

    def _current_crew(self) -> Optional[str]:
        with self._lock:
            return self._crew_stack[-1] if self._crew_stack else None

    def _tool_scope(self, event: Any) -> tuple[Any, Optional[str]]:
        """Resolve the session a tool event belongs to.

        Returns ``(scope_token, parent_key)``: the scope token keys the tool run
        (so start/finish/error match within one synchronous tool call), and the
        parent_key is the session the ``tool.*`` events attach to. Prefers the
        owning task, then the owning agent, then the current crew.
        """
        from_task = getattr(event, "from_task", None)
        tid = (
            self._task_id(event, from_task)
            if from_task is not None
            else getattr(event, "task_id", None)
        )
        if tid is not None and self._core.get(f"task:{tid}") is not None:
            return tid, f"task:{tid}"

        from_agent = getattr(event, "from_agent", None) or getattr(event, "agent", None)
        if from_agent is not None:
            akey = f"agent:{id(from_agent)}"
            if self._core.get(akey) is not None:
                return f"a{id(from_agent)}", akey

        crew_key = self._current_crew()
        if crew_key is not None:
            return "crew", crew_key
        return "orphan", None

    @staticmethod
    def _task_id(event: Any, task: Any) -> Optional[str]:
        tid = getattr(event, "task_id", None)
        if tid:
            return str(tid)
        if task is not None:
            ident = getattr(task, "id", None)
            if ident is not None:
                return str(ident)
        return None

    @staticmethod
    def _agent_role(agent: Any) -> Optional[str]:
        if agent is None:
            return None
        role = getattr(agent, "role", None)
        return str(role) if role else None

    @staticmethod
    def _task_name(task: Any) -> str:
        name = getattr(task, "name", None)
        if name:
            return str(name)
        desc = getattr(task, "description", None)
        if desc:
            return str(desc)[:60]
        return "task"

    @staticmethod
    def _crew_name(event: Any, source: Any) -> str:
        name = getattr(event, "crew_name", None)
        if name:
            return str(name)
        crew = getattr(event, "crew", None) or source
        name = getattr(crew, "name", None)
        return str(name) if name else "crew"


# ── Framework instrumentors ─────────────────────────────────────────────────


class FrameworkInstrumentor:
    """Base class for per-framework instrumentation.

    Each instrumentor builds and installs its own **transport** (a LangChain
    callback handler, a CrewAI bus listener, …) over the shared AEP client, and
    owns that transport's lifecycle. Subclass and register one in
    ``_INSTRUMENTORS`` to add a framework.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self._transport: Any = None

    def available(self) -> bool:
        raise NotImplementedError

    def instrument(self, client: Any) -> bool:
        """Build a transport over ``client`` and install it. Returns success."""
        raise NotImplementedError

    def uninstrument(self) -> None:
        """Best-effort restore of original behavior + close the transport."""
        transport = self._transport
        self._transport = None
        if transport is not None:
            try:
                transport.close(timeout=5.0)
            except Exception:  # pragma: no cover - defensive
                pass

    def flush(self, timeout: float = 5.0) -> bool:
        """Flush this framework's transport (True if there is nothing to flush)."""
        transport = self._transport
        if transport is None:
            return True
        return transport.flush(timeout)


class LangGraphInstrumentor(FrameworkInstrumentor):
    """Injects the AEP callback handler into ``CompiledStateGraph`` execution."""

    def __init__(self) -> None:
        super().__init__(name="langgraph")
        self._originals: dict[str, Any] = {}

    def available(self) -> bool:
        try:
            import langgraph  # noqa: F401
        except Exception:
            return False
        return True

    def _target(self):
        from langgraph.graph.state import CompiledStateGraph

        return CompiledStateGraph

    def instrument(self, client: Any) -> bool:
        base = _build_callback_base()
        if base is None:
            logger.warning(
                "AEP: langchain-core is not importable; LangGraph instrumentation "
                "skipped. Install LangGraph (which pulls in langchain-core): "
                "pip install langgraph"
            )
            return False

        try:
            target = self._target()
        except Exception as e:
            logger.warning(
                "AEP: could not locate CompiledStateGraph (langgraph>=%s expected): %s",
                MIN_LANGGRAPH_VERSION,
                e,
            )
            return False

        handler = base(client)

        if getattr(target, "_aep_instrumented", False):
            # Already patched in this process; refresh the active handler and
            # retire the previous one's background worker.
            previous = getattr(target, "_aep_handler", None)
            target._aep_handler = handler  # type: ignore[attr-defined]
            self._transport = handler
            if previous is not None and previous is not handler:
                try:
                    previous.close(timeout=1.0)
                except Exception:  # pragma: no cover - defensive
                    pass
            return True

        patched_any = False
        for method in ("invoke", "ainvoke", "stream", "astream"):
            original = getattr(target, method, None)
            if original is None:
                continue
            self._originals[method] = original
            setattr(target, method, _make_config_injector(target, original))
            patched_any = True

        if not patched_any:
            logger.warning(
                "AEP: CompiledStateGraph exposed none of invoke/stream/astream — "
                "LangGraph internals may have changed; instrumentation disabled."
            )
            handler.close(timeout=0.0)  # don't leak the emitter's worker thread
            return False

        target._aep_instrumented = True  # type: ignore[attr-defined]
        target._aep_handler = handler  # type: ignore[attr-defined]
        self._transport = handler
        return True

    def uninstrument(self) -> None:
        try:
            target = self._target()
        except Exception:
            target = None
        if target is not None:
            for method, original in self._originals.items():
                setattr(target, method, original)
            for attr in ("_aep_instrumented", "_aep_handler"):
                if hasattr(target, attr):
                    delattr(target, attr)
        self._originals.clear()
        super().uninstrument()


class CrewAIInstrumentor(FrameworkInstrumentor):
    """Subscribes an :class:`AEPCrewListener` to the CrewAI event bus."""

    def __init__(self) -> None:
        super().__init__(name="crewai")

    def available(self) -> bool:
        # Only claim availability when the event API we map is importable, so a
        # CrewAI release whose event layout has drifted degrades to a clean no-op.
        try:
            import crewai  # noqa: F401
            from crewai.events.event_bus import crewai_event_bus  # noqa: F401
        except Exception:
            return False
        return True

    def instrument(self, client: Any) -> bool:
        listener = AEPCrewListener(client)
        if not listener.subscribe():
            listener.close(timeout=0.0)  # don't leak the emitter's worker thread
            return False
        # Replace any previous listener (idempotent re-instrumentation).
        previous = self._transport
        self._transport = listener
        if isinstance(previous, AEPCrewListener):
            try:
                previous.unsubscribe()
                previous.close(timeout=1.0)
            except Exception:  # pragma: no cover - defensive
                pass
        return True

    def uninstrument(self) -> None:
        listener = self._transport
        if isinstance(listener, AEPCrewListener):
            try:
                listener.unsubscribe()
            except Exception:  # pragma: no cover - defensive
                pass
        super().uninstrument()


def _make_config_injector(target_cls: Any, original: Any):
    """Wrap a CompiledStateGraph method to inject the active AEP handler.

    The handler is read from the class at call time (``target_cls._aep_handler``)
    so re-instrumenting with a new client takes effect without re-patching.
    """

    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        handler = getattr(target_cls, "_aep_handler", None)
        if handler is None:
            return original(self, *args, **kwargs)
        try:
            args, kwargs = _inject_handler(handler, args, kwargs)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: failed to inject callback, running uninstrumented: %s", e)
            return original(self, *args, **kwargs)
        return original(self, *args, **kwargs)

    wrapper.__name__ = getattr(original, "__name__", "wrapper")
    wrapper.__qualname__ = getattr(original, "__qualname__", "wrapper")
    wrapper.__doc__ = getattr(original, "__doc__", None)
    wrapper.__wrapped__ = original  # type: ignore[attr-defined]
    return wrapper


def _inject_handler(handler: Any, args: tuple, kwargs: dict) -> tuple[tuple, dict]:
    """Return (args, kwargs) with ``handler`` added to the call's config callbacks.

    ``CompiledStateGraph.invoke(input, config=None, *, ...)`` — config is the
    second positional arg or the ``config`` keyword.
    """
    config = kwargs.get("config")
    config_in_kwargs = "config" in kwargs
    config_pos = None
    if not config_in_kwargs and len(args) >= 2:
        config = args[1]
        config_pos = 1

    config = _config_with_handler(config, handler)

    if config_in_kwargs or config_pos is None:
        kwargs["config"] = config
    else:
        args = args[:config_pos] + (config,) + args[config_pos + 1 :]
    return args, kwargs


def _config_with_handler(config: Any, handler: Any) -> dict:
    """Add ``handler`` to a RunnableConfig's callbacks without duplicating it."""
    if config is None:
        config = {}
    elif not isinstance(config, dict):
        # Unexpected config type — wrap defensively rather than mutate it.
        return config
    else:
        config = dict(config)

    callbacks = config.get("callbacks")
    if callbacks is None:
        config["callbacks"] = [handler]
    elif isinstance(callbacks, list):
        if not any(cb is handler for cb in callbacks):
            config["callbacks"] = [*callbacks, handler]
    else:
        # A BaseCallbackManager instance.
        add = getattr(callbacks, "add_handler", None)
        if callable(add):
            try:
                # inherit=True so child runs (nodes, tools) also see the handler.
                add(handler, True)
            except TypeError:
                add(handler)
    return config


# Register built-in instrumentors.
_INSTRUMENTORS["langgraph"] = LangGraphInstrumentor()
_INSTRUMENTORS["crewai"] = CrewAIInstrumentor()


# ── Public API ──────────────────────────────────────────────────────────────


def instrument(
    server_url: str | None = None,
    api_key: str | None = None,
    *,
    client: "AEPClient | None" = None,
    frameworks: list[str] | None = None,
) -> bool:
    """Enable AEP auto-instrumentation for supported agent frameworks.

    Supports **LangGraph** (``langgraph>=0.1``) and **CrewAI** (``crewai>=1.0``).
    Running a graph / crew after calling this emits AEP events for the run, each
    sub-agent, every tool call, and agent-to-agent handoffs — with full causation
    chains — and requires no other code changes. Only the frameworks you actually
    use need be installed: instrumenting CrewAI does not require ``langchain``.

    Args:
        server_url: AEP ingest URL (falls back to ``AEP_INGEST_URL`` env var,
            then ``http://localhost:8787``).
        api_key: API key (falls back to ``AEP_API_KEY`` env var).
        client: A pre-built :class:`~aep.client.AEPClient` to use instead of
            constructing one (handy for tests or shared connection pooling).
        frameworks: Restrict instrumentation to these framework names. Defaults
            to all registered frameworks that are importable.

    Returns:
        ``True`` if at least one framework was instrumented, else ``False``.

    Never raises on a missing framework — it logs a warning and returns ``False``
    so adding ``aep.instrument()`` can't take down the host application.
    """
    global _active_client, _owns_client

    targets = frameworks or list(_INSTRUMENTORS.keys())
    available = [n for n in targets if n in _INSTRUMENTORS and _INSTRUMENTORS[n].available()]
    if not available:
        logger.warning(
            "AEP: no supported framework found (looked for: %s); aep.instrument() "
            "is a no-op. Install LangGraph (>=%s) or CrewAI (>=%s).",
            ", ".join(targets),
            MIN_LANGGRAPH_VERSION,
            MIN_CREWAI_VERSION,
        )
        return False

    with _state_lock:
        if client is not None:
            _active_client = client
            _owns_client = False
        elif _active_client is None:
            try:
                from aep.client import AEPClient

                _active_client = AEPClient(server_url=server_url, api_key=api_key)
                _owns_client = True
            except Exception as e:
                logger.error("AEP: failed to create client; instrumentation disabled: %s", e)
                return False
        active_client = _active_client

    instrumented: list[str] = []
    for fw in available:
        # Each instrumentor builds its own transport (and thus its own background
        # emitter thread) over the shared client. flush()/uninstrument() below
        # fan out across all instrumentors, so both transports are drained/closed.
        try:
            if _INSTRUMENTORS[fw].instrument(active_client):
                instrumented.append(fw)
        except Exception as e:
            logger.warning("AEP: failed to instrument %s: %s", fw, e)

    if not instrumented:
        logger.warning("AEP: instrumentation attempted but no framework was patched.")
        return False

    logger.info(
        "AEP instrumentation enabled for: %s (server: %s)",
        ", ".join(instrumented),
        getattr(active_client, "_server_url", server_url),
    )
    return True


def flush(timeout: float = 5.0) -> bool:
    """Block until queued AEP telemetry has been sent (or ``timeout`` elapses).

    Emission is buffered on a background thread, so call this before a short-lived
    process exits (or before asserting on the server in a test) to be sure events
    were delivered. Returns ``True`` if every active transport's buffer drained in
    time, ``False`` if any timed out, and ``True`` immediately when instrumentation
    is not active.
    """
    ok = True
    for inst in _INSTRUMENTORS.values():
        try:
            ok = inst.flush(timeout) and ok
        except Exception:  # pragma: no cover - defensive
            pass
    return ok


def uninstrument() -> None:
    """Undo all instrumentation, flush pending telemetry, and release the client."""
    global _active_client, _owns_client
    for inst in _INSTRUMENTORS.values():
        try:
            inst.uninstrument()
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: failed to uninstrument %s: %s", inst.name, e)
    with _state_lock:
        client, owns = _active_client, _owns_client
        _active_client = None
        _owns_client = False
    if owns and client is not None:
        try:
            client.close()
        except Exception:
            pass
