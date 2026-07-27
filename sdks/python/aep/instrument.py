"""Framework auto-instrumentation for AEP.

``aep.instrument()`` patches supported agent frameworks so that running a
workflow automatically emits AEP events — no other code changes required.

Five frameworks are supported today:

- **LangGraph** (``langgraph>=0.1``) — instrumented via a LangChain
  ``BaseCallbackHandler`` injected into every ``CompiledStateGraph`` execution.
- **CrewAI** (``crewai>=1.0``) — instrumented by subscribing to CrewAI's own
  event bus (``crewai.events``); CrewAI does *not* use LangChain callbacks.
- **AutoGen AgentChat** (``autogen-agentchat>=0.4``) — instrumented by tapping
  the async event stream a team exposes from ``BaseGroupChat.run_stream`` (which
  ``BaseGroupChat.run`` also drives); AutoGen has neither a callback registry nor
  an event bus, so the stream is the observation surface.
- **OpenAI Agents SDK** (``openai-agents>=0.1``) — instrumented by registering a
  tracing processor (``agents.tracing.add_trace_processor``); the SDK exposes a
  supported global tracing pipeline that reports a trace per ``Runner.run`` and a
  tree of agent/function/handoff spans.
- **Anthropic Claude Agent SDK** (``claude-agent-sdk>=0.2``) — instrumented by
  injecting AEP hook callbacks into ``ClaudeAgentOptions.hooks``; the SDK's hooks
  (``SubagentStart``/``SubagentStop``/``PreToolUse``/``PostToolUse``/
  ``PostToolUseFailure``/``Stop``) are its supported observation surface, each
  carrying an ``agent_id`` + ``tool_use_id`` so the multi-agent DAG is explicit.

All transports map framework lifecycle onto the same AEP event vocabulary:

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

import asyncio
import atexit
import json
import logging
import queue
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

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
# Floor at which the AutoGen AgentChat message/event stream this tracer maps was
# verified. The 0.4 rewrite introduced the typed ``run_stream`` event model
# (``ToolCallRequestEvent`` / ``ToolCallExecutionEvent``) we depend on; developed
# and tested against 0.7.x. Earlier 0.2-era ``pyautogen`` has an entirely
# different API and degrades to a clean no-op via AutoGenInstrumentor.available().
MIN_AUTOGEN_VERSION = "0.4"
# Floor at which the OpenAI Agents SDK tracing-processor model this transport maps
# is present: ``agents.tracing.add_trace_processor`` + the ``agent``/``function``/
# ``handoff`` span-data types. Developed and tested against 0.17.x. Older releases
# whose tracing API has drifted degrade to a clean no-op via
# OpenAIAgentsInstrumentor.available().
MIN_OPENAI_AGENTS_VERSION = "0.1"
# Floor at which the Claude Agent SDK hooks model this transport injects is
# present: ``ClaudeAgentOptions.hooks`` + the ``SubagentStart``/``SubagentStop``/
# ``PreToolUse``/``PostToolUse``/``PostToolUseFailure``/``Stop`` hook events.
# Developed and tested against 0.2.x. Older releases whose hook API has drifted
# degrade to a clean no-op via ClaudeAgentInstrumentor.available().
MIN_CLAUDE_AGENT_VERSION = "0.2"

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


def _autogen_version() -> str:
    """Best-effort installed AutoGen AgentChat version, for diagnostics in warnings."""
    try:
        import autogen_agentchat

        version = getattr(autogen_agentchat, "__version__", None)
        if version:
            return str(version)
        import importlib.metadata as _md

        return _md.version("autogen-agentchat")
    except Exception:
        return "not installed"


def _openai_agents_version() -> str:
    """Best-effort installed OpenAI Agents SDK version, for diagnostics in warnings."""
    try:
        import agents

        version = getattr(agents, "__version__", None)
        if version:
            return str(version)
        import importlib.metadata as _md

        return _md.version("openai-agents")
    except Exception:
        return "not installed"


def _claude_agent_version() -> str:
    """Best-effort installed Claude Agent SDK version, for diagnostics in warnings."""
    try:
        import claude_agent_sdk

        version = getattr(claude_agent_sdk, "__version__", None)
        if version:
            return str(version)
        import importlib.metadata as _md

        return _md.version("claude-agent-sdk")
    except Exception:
        return "not installed"


# Module-level registry of framework instrumentors, populated at import time.
_INSTRUMENTORS: dict[str, FrameworkInstrumentor] = {}

# The client used by all active instrumentation. Set by instrument().
_state_lock = threading.Lock()
_active_client: AEPClient | None = None
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
        self._q: queue.Queue[dict] = queue.Queue(maxsize=max_queue)
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


def _new_run_token() -> str:
    """An opaque per-run token used to namespace a run's keys in the run table.

    AutoGen agent/tool keys are derived from message ``source`` names and tool
    ``call_id``s, which are only unique *within* a single team run; prefixing them
    with a fresh token keeps concurrent team runs from colliding on the (global)
    core run table.
    """
    return uuid.uuid4().hex[:16]


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
    agent_role: str | None = None
    parent_session_id: str | None = None
    # For sub-agent runs: the handoff.started event id on the parent session, so
    # the matching handoff.completed can chain off it.
    handoff_event_id: str | None = None
    # For sub-agent runs: the parent (orchestrator) role, so handoff.completed —
    # which is emitted on the parent session — reads the parent's role.
    parent_agent_role: str | None = None


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
        self._runs: OrderedDict[str, _RunInfo] = OrderedDict()
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

    def _emit(self, **kwargs: Any) -> str | None:
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

    def get(self, key: Any) -> _RunInfo | None:
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

    def _pop(self, key: Any) -> _RunInfo | None:
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
        extra_payload: dict | None = None,
    ) -> str | None:
        """Open an agent/task run, returning its ``task.created`` event id.

        With no tracked parent the run is the **orchestrator** root (new
        ``trace_id`` + ``session_id``). With a tracked parent it is a
        **sub-agent**: a ``handoff.started`` is emitted on the parent's session,
        then the sub-agent's ``task.created`` chains off that handoff.

        ``extra_payload`` merges extra keys into the ``task.created`` payload
        (e.g. the OpenAI Agents transport records ``handoff_from``); it defaults
        to ``None`` so callers that omit it produce the exact same payload shape
        as before.
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
                payload={"framework": framework, "node": name, "kind": kind, **(extra_payload or {})},
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
            payload={"framework": framework, "node": name, "kind": kind, **(extra_payload or {})},
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
    ) -> str | None:
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

    # -- policy decisions ------------------------------------------------------

    def emit_policy_blocked(
        self,
        key: Any,
        *,
        policy: str,
        reason: str | None = None,
        action_blocked: str | None = None,
        framework: str | None = None,
        extra_payload: dict | None = None,
    ) -> str | None:
        """Emit a ``policy.blocked`` decision on a tracked run's session.

        The event chains off the run's opening event via ``causation_id``, so
        the decision is joined to the operation it gated. The payload keeps the
        protocol's shipped shape (``policy`` / ``reason`` / ``action_blocked``)
        plus an optional ``framework`` marker. When ``action_blocked`` is None
        it defaults to the gated run's own identity (``<kind>/<name>``) — the
        single lookup here keeps that derivation atomic with the emission.
        ``extra_payload`` merges extra keys into the payload (e.g. the CrewAI
        transport records ``retry_count``), mirroring ``open_agent_run``. An
        unknown ``key`` (e.g. an evicted run) is dropped with no event — a lost
        decision label, never an exception into the host. Returns the event id,
        or None.
        """
        info = self.get(key)
        if info is None:
            return None
        if action_blocked is None:
            action_blocked = f"{info.kind}/{info.name}"
        payload = {
            "policy": policy,
            **({"reason": reason} if reason else {}),
            **({"action_blocked": action_blocked} if action_blocked else {}),
            **({"framework": framework} if framework else {}),
            **(extra_payload or {}),
        }
        return self._emit(
            source=info.source,
            type="policy.blocked",
            session_id=info.session_id,
            trace_id=info.trace_id,
            agent_role=info.agent_role,
            parent_session_id=info.parent_session_id,
            subject=policy,
            causation_id=info.open_event_id or None,
            payload=payload,
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

        def __init__(self, client: AEPClient, max_runs: int = DEFAULT_MAX_RUNS) -> None:
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
            serialized: dict | None,
            inputs: Any,
            *,
            run_id: Any,
            parent_run_id: Any = None,
            tags: list | None = None,
            metadata: dict | None = None,
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
            serialized: dict | None,
            input_str: str,
            *,
            run_id: Any,
            parent_run_id: Any = None,
            tags: list | None = None,
            metadata: dict | None = None,
            inputs: dict | None = None,
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
    task, agent, tool, and guardrail events and maps them onto AEP's vocabulary:

    - ``CrewKickoffStarted``  → orchestrator ``task.created`` (root; new trace)
    - ``TaskStarted``         → sub-agent ``task.created`` (handoff off the crew),
      named for the agent assigned to the task
    - ``ToolUsageStarted``    → ``tool.called`` on the active task/agent session
    - ``TaskCompleted/Failed``→ ``task.completed`` / ``task.failed`` (+ handoff)
    - ``CrewKickoffCompleted/Failed`` → orchestrator close
    - ``LLMGuardrailCompleted`` with ``success=False`` → ``policy.blocked`` on
      the guarded task's session (passed validations emit nothing; subscribed
      only when the installed CrewAI ships guardrail events)

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

        # Guardrail events are present at the crewai>=1.0 floor, but imported
        # separately and defensively: on an out-of-floor install where
        # crewai.events exists without llm_guardrail_events, their absence
        # never disables the rest of the instrumentation.
        try:
            from crewai.events.types.llm_guardrail_events import (
                LLMGuardrailCompletedEvent,
            )
        except Exception:
            logger.debug(
                "AEP: CrewAI LLM-guardrail events unavailable; guardrail "
                "capture disabled."
            )
        else:
            mapping.append((LLMGuardrailCompletedEvent, self._on_guardrail_completed))
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

    def _on_guardrail_completed(self, source: Any, event: Any) -> None:
        """Emit ``policy.blocked`` for a failed guardrail validation.

        CrewAI guardrails validate a task's output and retry on failure — each
        failed attempt is a real block-and-retry decision, so each emits one
        event (``retry_count`` disambiguates the attempts). Successful
        validations emit nothing (blocked-only is AEP's semantic). The decision
        keys to the guarded task's run, falling back to the innermost open
        crew; with neither tracked it is dropped (never an exception into the
        host — the core drops unknown keys). In practice only agent-level /
        lite-agent guardrails take the crew fallback: task guardrails always
        carry a resolvable ``task_id`` (crewai passes ``from_task`` at every
        task call site, and the event base derives ``task_id`` from it).
        """
        if getattr(event, "success", True):
            return
        policy = str(
            getattr(event, "guardrail_name", None)
            or getattr(event, "guardrail_type", None)
            or "guardrail"
        )
        tid = self._task_id(event, getattr(event, "from_task", None))
        key = f"task:{tid}" if tid is not None else self._current_crew()
        if key is None:
            return
        error = getattr(event, "error", None)
        reason = str(error) if error else f"Guardrail '{policy}' validation failed"
        retry = getattr(event, "retry_count", None)
        self._core.emit_policy_blocked(
            key,
            policy=policy,
            reason=reason,
            framework="crewai",
            extra_payload={"retry_count": retry} if retry is not None else None,
        )

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

    def _pop_tool_run(self, event: Any) -> str | None:
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

    def _current_crew(self) -> str | None:
        with self._lock:
            return self._crew_stack[-1] if self._crew_stack else None

    def _tool_scope(self, event: Any) -> tuple[Any, str | None]:
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
    def _task_id(event: Any, task: Any) -> str | None:
        tid = getattr(event, "task_id", None)
        if tid:
            return str(tid)
        if task is not None:
            ident = getattr(task, "id", None)
            if ident is not None:
                return str(ident)
        return None

    @staticmethod
    def _agent_role(agent: Any) -> str | None:
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


# ── AutoGen AgentChat stream tracer (AutoGen transport) ─────────────────────


def _coerce_tool_args(arguments: Any) -> dict:
    """Normalise an AutoGen ``FunctionCall.arguments`` into a JSON-safe dict.

    AutoGen passes tool arguments as a JSON string; decode it to a dict when it
    parses to one, and otherwise wrap the raw value under ``input`` so the
    ``tool.called`` payload shape stays uniform with the other transports.
    """
    if isinstance(arguments, dict):
        return arguments
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except Exception:
            return {"input": arguments}
        return decoded if isinstance(decoded, dict) else {"input": decoded}
    return {"input": _stringify(arguments)}


class _AutoGenRunContext:
    """Tracks one ``team.run_stream`` invocation.

    Maps the run onto AEP's vocabulary: the team is the **orchestrator**; each
    distinct message ``source`` (an agent name) is a **sub-agent** opened lazily
    on first sight; each ``FunctionCall`` (keyed by its ``call_id``) is a tool
    run. A fresh context is created per ``run_stream`` call and namespaces every
    core run-table key with a unique token, so concurrent team runs never share
    mutable state or collide on the (global) run table.
    """

    def __init__(self, core: _EmissionCore, token: str, team_name: str | None) -> None:
        self._core = core
        self._token = token
        self._team_name = team_name or "team"
        self._orch_key = f"{token}:team"
        self._open_agents: set[str] = set()
        self._started = False

    def _agent_key(self, source: str) -> str:
        return f"{self._token}:agent:{source}"

    def _tool_key(self, call_id: Any) -> str:
        return f"{self._token}:tool:{call_id}"

    def start(self) -> None:
        """Open the orchestrator run for the team (new trace + root session)."""
        self._core.open_agent_run(
            self._orch_key,
            name=self._team_name,
            framework="autogen",
            kind="team",
            parent_key=None,
        )
        self._started = True

    def _ensure_agent(self, source: str) -> None:
        """Open a sub-agent run for ``source`` the first time it speaks."""
        if not source or source in self._open_agents:
            return
        self._core.open_agent_run(
            self._agent_key(source),
            name=source,
            framework="autogen",
            kind="agent",
            parent_key=self._orch_key,
        )
        self._open_agents.add(source)

    def observe(self, item: Any) -> None:
        """Translate one streamed message/event into core emission calls.

        Duck-typed against the AutoGen message shape (``.source`` / ``.type`` /
        ``.content``) — it never imports autogen, so the mapping is unit-testable
        with fabricated events.
        """
        # The stream's terminal item is a TaskResult (carries the full message
        # list + a stop reason, and has no ``source``). The run is closed by
        # wrap_stream's ``finally`` with the final run status — deliberately NOT
        # here: closing on the TaskResult would record ``completed`` even if the
        # generator then errors/cancels in teardown (after yielding it), so we let
        # the surrounding try/finally pick the correct terminal status.
        if hasattr(item, "messages") and hasattr(item, "stop_reason"):
            return
        source = getattr(item, "source", None)
        # The echoed task input has source "user"; skip it (and anything sourceless).
        if not source or source == "user":
            return

        kind = getattr(item, "type", None)
        if kind == "ToolCallRequestEvent":
            # content is a list of FunctionCall(id, name, arguments).
            self._ensure_agent(source)
            for call in getattr(item, "content", None) or []:
                call_id = getattr(call, "id", None)
                if call_id is None:
                    continue
                self._core.open_tool_run(
                    self._tool_key(call_id),
                    name=getattr(call, "name", None) or "tool",
                    arguments=_coerce_tool_args(getattr(call, "arguments", None)),
                    parent_key=self._agent_key(source),
                )
            return
        if kind == "ToolCallExecutionEvent":
            # content is a list of FunctionExecutionResult(call_id, content, is_error).
            # Matched to its open tool exactly by call_id — no LIFO heuristics.
            for result in getattr(item, "content", None) or []:
                call_id = getattr(result, "call_id", None)
                if call_id is None:
                    continue
                key = self._tool_key(call_id)
                if getattr(result, "is_error", False):
                    self._core.fail_tool_run(key, error=getattr(result, "content", None))
                else:
                    self._core.close_tool_run(key, output=getattr(result, "content", None))
            return

        # Any other message from a real agent (TextMessage, ToolCallSummaryMessage,
        # HandoffMessage, …) just marks that agent as active.
        self._ensure_agent(source)

    def finish(self, status: str, error: Any = None) -> None:
        """Close every open sub-agent, then the orchestrator.

        Idempotent: the core pops runs on close, so a second call is a no-op.
        Sub-agent boundaries are inferred from message sources, so a run-level
        failure marks only the orchestrator ``task.failed``; observed sub-agents
        close ``task.completed``.
        """
        for source in list(self._open_agents):
            self._core.close_agent_run(self._agent_key(source), status="completed")
        self._open_agents.clear()
        if self._started:
            self._core.close_agent_run(self._orch_key, status=status, error=error)
            self._started = False


class AEPAutoGenTracer:
    """Translates an AutoGen AgentChat team's event stream into AEP events.

    AutoGen AgentChat has neither a callback registry nor an event bus — a team
    surfaces its activity only as the async stream of messages/events yielded by
    ``BaseGroupChat.run_stream`` (which ``BaseGroupChat.run`` consumes
    internally). This tracer taps that stream transparently via
    :meth:`wrap_stream`: it re-yields every item unchanged while translating it
    into :class:`_EmissionCore` calls through a per-run :class:`_AutoGenRunContext`.

    The mapping never imports autogen, so it is unit-testable with fabricated
    events; only :class:`AutoGenInstrumentor` (available()/instrument()) touches
    the framework.
    """

    def __init__(self, client: Any, max_runs: int = DEFAULT_MAX_RUNS) -> None:
        self._core = _EmissionCore(client, max_runs=max_runs)

    @property
    def _runs(self):  # exposed for tests + run-cap assertions
        return self._core._runs

    def flush(self, timeout: float = 5.0) -> bool:
        return self._core.flush(timeout)

    def close(self, timeout: float = 5.0) -> None:
        self._core.close(timeout)

    async def wrap_stream(self, instance: Any, gen: Any):
        """Wrap a team's ``run_stream`` generator: emit telemetry, re-yield items.

        Transparent to the caller — yields exactly what ``gen`` yields, in order.
        A mapping error on any single item is swallowed (telemetry is best-effort
        and must never break the host run); a failure (or cancellation) raised by
        the run itself closes the orchestrator as ``task.failed`` and propagates
        unchanged.

        The run is closed in the ``finally`` with its final status — ``completed``
        on clean exhaustion, ``failed`` on an error or cancellation raised by the
        run (so an error in post-``TaskResult`` teardown still records ``failed``,
        not a premature ``completed``). Note: if a caller abandons ``run_stream``
        early (``break``s before the stream ends), the ``finally`` runs only when
        this async generator is finalized (``aclose`` / loop shutdown), not
        promptly — the fully-consumed ``team.run()`` / ``run_stream()`` paths are
        unaffected.
        """
        ctx = _AutoGenRunContext(
            self._core, _new_run_token(), getattr(instance, "name", None)
        )
        try:
            ctx.start()
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: failed to open AutoGen run: %s", e)

        status, error = "completed", None
        try:
            async for item in gen:
                try:
                    ctx.observe(item)
                except Exception as e:  # pragma: no cover - defensive
                    logger.warning(
                        "AEP: AutoGen stream mapping error on %s: %s",
                        type(item).__name__,
                        e,
                    )
                yield item
        except (Exception, asyncio.CancelledError) as e:
            # CancelledError is a BaseException (not Exception) — list it
            # explicitly so a cancelled run is recorded as failed rather than
            # silently closing "completed". It is always re-raised, so
            # cancellation semantics are preserved.
            status, error = "failed", e
            raise
        finally:
            try:
                ctx.finish(status, error)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("AEP: failed to close AutoGen run: %s", e)


# ── OpenAI Agents SDK tracing processor ─────────────────────────────────────


def _span_error_message(error: Any) -> str:
    """Extract a human-readable message from an Agents SDK ``SpanError``.

    A failed span's ``error`` is a dict shaped ``{"message": str, "data": {...}}``
    (e.g. a failed tool call carries the real exception text under
    ``data["error"]`` while ``message`` is a generic label). Prefer the specific
    nested message; fall back to the top-level one, then to ``str(error)``.
    """
    if isinstance(error, dict):
        data = error.get("data")
        if isinstance(data, dict) and data.get("error"):
            return str(data["error"])
        if error.get("message"):
            return str(error["message"])
        return str(error)
    return "" if error is None else str(error)


# Bounds the span-parent index (a separate cap from the core run table) so a
# long-lived process whose spans somehow never close can't grow it without limit.
DEFAULT_MAX_SPANS = 10_000


class AEPOpenAIAgentsTracer:
    """Translates the OpenAI Agents SDK tracing stream into AEP events.

    The Agents SDK exposes a supported, global observation surface: a tracing
    pipeline you join by registering a processor via
    ``agents.tracing.add_trace_processor``. A processor receives a *trace* per
    top-level ``Runner.run`` and a tree of *spans* (``agent`` / ``function`` /
    ``handoff`` / ``turn`` / …) linked by ``parent_id``. This object implements
    that processor's duck-typed interface
    (``on_trace_start`` / ``on_trace_end`` / ``on_span_start`` / ``on_span_end``
    / ``force_flush`` / ``shutdown``) and maps it onto AEP's vocabulary:

    - the **trace** is the orchestrator root (new AEP trace + root session);
    - every **agent** span is a sub-agent of that root — matching how the SDK
      itself trees agents as siblings under the workflow, and mirroring the
      AutoGen team→agents star. The real ``from_agent`` of a handoff is recorded
      on the handed-to agent's ``task.created`` payload as ``handoff_from``;
    - every **function** span is a tool run, paired exactly by its ``span_id``
      (one span carries both start and end — no LIFO heuristics);
    - a **guardrail** span that ends *triggered* emits a ``policy.blocked`` on
      its owning agent's session (untripped guardrails emit nothing — the
      protocol has no "evaluated and passed" event type);
    - a tool/agent's parent is resolved by walking ``parent_id`` to the nearest
      open agent span, falling back to the always-open workflow root — so a tool
      nests on its owning agent's session and the whole run stays one trace. This
      also covers agents-as-tools (``agent.as_tool(...)``): the inner agent nests
      as a sub-agent of the calling agent (the walk passes through the as_tool
      ``function`` and nested ``task`` spans), while the as_tool function still
      emits its own ``tool.called``/``tool.result`` pair.

    The mapping never imports ``agents`` — it is entirely duck-typed against the
    span/trace shape — so it is unit-testable with fabricated objects; only
    :class:`OpenAIAgentsInstrumentor` touches the framework.

    Note: the tracing surface only reports failures the SDK records on a span
    (e.g. a tool error sets ``span.error``). An *uncaught* exception from
    ``Runner.run`` is not surfaced to processors — the spans and trace still
    close cleanly and the exception propagates to the caller — so such a run is
    recorded ``completed`` here. The exception itself remains the host's source
    of truth; we deliberately don't bolt on a separate failure path that would
    race the SDK's own span/trace close.
    """

    def __init__(
        self,
        client: Any,
        max_runs: int = DEFAULT_MAX_RUNS,
        max_spans: int = DEFAULT_MAX_SPANS,
    ) -> None:
        self._core = _EmissionCore(client, max_runs=max_runs)
        self._lock = threading.Lock()
        # span_id -> parent_id, for every span (used to walk to the owning agent).
        self._parent_of: OrderedDict[str, str | None] = OrderedDict()
        # span_id -> trace_id for agent runs currently open (the run key is the
        # span_id). Keyed this way so on_trace_end can close any stragglers that
        # never received their own on_span_end. Bounded (FIFO) like the other
        # indices: under pathological accumulation the oldest open agent is
        # dropped (its children then resolve to the workflow root).
        self._open_agents: OrderedDict[str, Any] = OrderedDict()
        # trace_ids with a tracked (open) workflow root, so a span arriving without
        # a preceding on_trace_start can be detected rather than silently splitting
        # the run into orphan traces.
        self._open_traces: set = set()
        self._warned_orphan = False
        # (trace_id, to_agent) -> from_agent, recorded when a handoff span ends and
        # consumed when the handed-to agent span opens (to enrich its payload).
        self._pending_handoff: OrderedDict[tuple, str | None] = OrderedDict()
        self._max_spans = max_spans
        self._span_evicted = 0
        self._handoff_evicted = 0

    @property
    def _runs(self):  # exposed for tests + run-cap assertions
        return self._core._runs

    def flush(self, timeout: float = 5.0) -> bool:
        return self._core.flush(timeout)

    def close(self, timeout: float = 5.0) -> None:
        self._core.close(timeout)

    # -- TracingProcessor interface (duck-typed; never raises into the SDK) ----

    def on_trace_start(self, trace: Any) -> None:
        try:
            trace_id = getattr(trace, "trace_id", None)
            if not trace_id:
                return
            name = getattr(trace, "name", None) or "agent-workflow"
            with self._lock:
                self._open_traces.add(trace_id)
            self._core.open_agent_run(
                trace_id,
                name=name,
                framework="openai-agents",
                kind="workflow",
                parent_key=None,
            )
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: OpenAI Agents on_trace_start error: %s", e)

    def on_trace_end(self, trace: Any) -> None:
        try:
            trace_id = getattr(trace, "trace_id", None)
            if not trace_id:
                return
            # Safety net: close any sub-agents of this trace that never received
            # their own on_span_end (abnormal termination), so they don't linger
            # open and miss their task.completed. Idempotent — agents that closed
            # normally are already gone from _open_agents.
            with self._lock:
                stragglers = [
                    sid for sid, tid in self._open_agents.items() if tid == trace_id
                ]
            for sid in stragglers:
                self._core.close_agent_run(sid, status="completed")
            with self._lock:
                for sid in stragglers:
                    self._open_agents.pop(sid, None)
                    self._parent_of.pop(sid, None)
                self._open_traces.discard(trace_id)
            self._core.close_agent_run(trace_id, status="completed")
            self._forget_trace(trace_id)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: OpenAI Agents on_trace_end error: %s", e)

    def on_span_start(self, span: Any) -> None:
        try:
            self._record_parent(span)
            data = getattr(span, "span_data", None)
            if getattr(data, "type", None) == "agent":
                self._open_agent(span, data)
            # function/handoff/guardrail spans carry their input/output/to_agent/
            # triggered state only at end, so they're mapped in on_span_end; other
            # span types (turn, generation, response, custom) are not AEP
            # boundaries — their parent_id is still recorded above so the walk
            # can pass through.
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: OpenAI Agents on_span_start error: %s", e)

    def on_span_end(self, span: Any) -> None:
        try:
            data = getattr(span, "span_data", None)
            kind = getattr(data, "type", None)
            if kind == "agent":
                self._close_agent(span)
            elif kind == "function":
                self._tool(span, data)
            elif kind == "handoff":
                self._record_handoff(span, data)
            elif kind == "guardrail":
                self._guardrail(span, data)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: OpenAI Agents on_span_end error: %s", e)
        finally:
            self._forget_span(getattr(span, "span_id", None))

    def force_flush(self) -> None:
        self._core.flush(5.0)

    def shutdown(self) -> None:
        # Called by the SDK's tracing pipeline at process shutdown. Drain and stop
        # our background worker so queued telemetry is delivered.
        self._core.close(5.0)

    # -- span bookkeeping -----------------------------------------------------

    def _record_parent(self, span: Any) -> None:
        sid = getattr(span, "span_id", None)
        if not sid:
            return
        with self._lock:
            self._parent_of[sid] = getattr(span, "parent_id", None)
            while len(self._parent_of) > self._max_spans:
                self._parent_of.popitem(last=False)
                self._span_evicted += 1
                if self._span_evicted == 1 or self._span_evicted % 100 == 0:
                    logger.warning(
                        "AEP: span-parent index cap (%d) exceeded — evicted %d "
                        "stale span(s); some tool/agent parenting may fall back "
                        "to the workflow root.",
                        self._max_spans,
                        self._span_evicted,
                    )

    def _forget_span(self, sid: str | None) -> None:
        if not sid:
            return
        with self._lock:
            self._parent_of.pop(sid, None)
            self._open_agents.pop(sid, None)

    def _forget_trace(self, trace_id: str) -> None:
        with self._lock:
            stale = [k for k in self._pending_handoff if k[0] == trace_id]
            for k in stale:
                self._pending_handoff.pop(k, None)

    def _warn_if_orphan(self, trace_id: Any) -> None:
        """Warn once if a span's trace has no tracked workflow root.

        Normally on_trace_start always precedes a trace's spans; if it didn't, the
        span's run can't resolve to the (absent) workflow root and would split off
        into its own orphan trace. We surface that rather than failing silently.
        """
        with self._lock:
            if trace_id in self._open_traces or self._warned_orphan:
                return
            self._warned_orphan = True
        logger.warning(
            "AEP: OpenAI Agents span arrived for trace %s with no tracked trace "
            "root (on_trace_start missed?); its run may not share the workflow "
            "trace. Further such cases are not logged.",
            trace_id,
        )

    def _resolve_parent(self, span: Any) -> Any:
        """Return the run key of the nearest open agent ancestor, or the trace root.

        Walks ``parent_id`` up the span tree (through ``turn`` and other
        non-boundary spans) to the closest currently-open agent span — its key is
        that agent's run. With none found, falls back to the workflow root keyed
        by ``trace_id`` (always open for the duration of the trace), so tools and
        agents never escape the run's single trace.
        """
        with self._lock:
            cur = getattr(span, "parent_id", None)
            hops = 0
            while cur is not None and hops < 128:
                if cur in self._open_agents:
                    return cur
                cur = self._parent_of.get(cur)
                hops += 1
        return getattr(span, "trace_id", None)

    # -- mapping --------------------------------------------------------------

    def _open_agent(self, span: Any, data: Any) -> None:
        sid = getattr(span, "span_id", None)
        if not sid:
            return
        name = getattr(data, "name", None) or "agent"
        trace_id = getattr(span, "trace_id", None)
        self._warn_if_orphan(trace_id)
        parent_key = self._resolve_parent(span)
        with self._lock:
            from_agent = self._pending_handoff.pop((trace_id, name), None)
        extra = {"handoff_from": from_agent} if from_agent else None
        self._core.open_agent_run(
            sid,
            name=name,
            framework="openai-agents",
            kind="agent",
            parent_key=parent_key,
            extra_payload=extra,
        )
        with self._lock:
            self._open_agents[sid] = trace_id
            while len(self._open_agents) > self._max_spans:
                self._open_agents.popitem(last=False)

    def _close_agent(self, span: Any) -> None:
        sid = getattr(span, "span_id", None)
        if not sid:
            return
        status, error = self._status(span)
        self._core.close_agent_run(sid, status=status, error=error)

    def _tool(self, span: Any, data: Any) -> None:
        sid = getattr(span, "span_id", None)
        if not sid:
            return
        name = getattr(data, "name", None) or "tool"
        self._warn_if_orphan(getattr(span, "trace_id", None))
        parent_key = self._resolve_parent(span)
        raw_input = getattr(data, "input", None)
        # input is only populated at span end; None or "" → no arguments captured.
        arguments = _coerce_tool_args(raw_input) if raw_input not in (None, "") else {}
        self._core.open_tool_run(
            sid, name=name, arguments=arguments, parent_key=parent_key
        )
        status, error = self._status(span)
        if status == "failed":
            self._core.fail_tool_run(sid, error=error)
        else:
            self._core.close_tool_run(sid, output=getattr(data, "output", None))

    def _guardrail(self, span: Any, data: Any) -> None:
        """Emit a ``policy.blocked`` for a guardrail span that ended *tripped*.

        Only triggered guardrails produce an event — the protocol has no
        "policy evaluated and passed" type, and blocked-only is AEP's shipped
        semantic. The decision lands on the owning agent's session (workflow
        root when no agent ancestor — input guardrails can run before the
        agent span opens), chained off that run's opening event. Untripped
        guardrail spans emit nothing; their parent linkage was already
        recorded on start so the walk still passes through them.
        """
        if not getattr(data, "triggered", False):
            return
        name = getattr(data, "name", None) or "guardrail"
        self._warn_if_orphan(getattr(span, "trace_id", None))
        owner_key = self._resolve_parent(span)
        # action_blocked defaults inside the core to the owner run's
        # "<kind>/<name>" — one atomic lookup, no read-then-emit race.
        self._core.emit_policy_blocked(
            owner_key,
            policy=name,
            reason=f"Guardrail '{name}' tripwire triggered",
            framework="openai-agents",
        )

    def _record_handoff(self, span: Any, data: Any) -> None:
        trace_id = getattr(span, "trace_id", None)
        to_agent = getattr(data, "to_agent", None)
        if not trace_id or not to_agent:
            return
        from_agent = getattr(data, "from_agent", None)
        with self._lock:
            self._pending_handoff[(trace_id, to_agent)] = from_agent
            while len(self._pending_handoff) > self._max_spans:
                self._pending_handoff.popitem(last=False)
                self._handoff_evicted += 1
                if self._handoff_evicted == 1 or self._handoff_evicted % 100 == 0:
                    logger.warning(
                        "AEP: pending-handoff index cap (%d) exceeded — evicted %d "
                        "entr%s; some handoff_from labels may be lost.",
                        self._max_spans,
                        self._handoff_evicted,
                        "y" if self._handoff_evicted == 1 else "ies",
                    )

    def _status(self, span: Any) -> tuple[str, str | None]:
        """Map a span's ``error`` onto an AEP terminal status.

        Returns ``("failed", message)`` when the SDK recorded a span error, else
        ``("completed", None)``. The message is a plain string (the core's
        ``_error_fields`` labels it ``"Error"``).
        """
        error = getattr(span, "error", None)
        if error:
            return "failed", _span_error_message(error)
        return "completed", None


# ── Anthropic Claude Agent SDK hooks ────────────────────────────────────────


class AEPClaudeAgentTracer:
    """Translates the Anthropic Claude Agent SDK's hook events into AEP events.

    The Claude Agent SDK runs agents as a subprocess (the bundled ``claude``
    CLI) and exposes a **hooks** system — ``ClaudeAgentOptions.hooks`` — as its
    supported, in-process observation surface. A hook is an ``async`` callable
    that the SDK invokes (over its CLI control protocol) when an event fires:
    ``UserPromptSubmit`` / ``Stop`` (the top-level agent's turn boundaries),
    ``SubagentStart`` / ``SubagentStop`` (a Task sub-agent's lifecycle), and
    ``PreToolUse`` / ``PostToolUse`` / ``PostToolUseFailure`` (tool calls). Every
    tool/subagent hook carries an ``agent_id`` (which agent it belongs to) and a
    ``tool_use_id`` (exact tool pairing), so the multi-agent DAG is explicit — no
    inference needed.

    This object owns a set of async hook callbacks (exposed via
    :meth:`hook_matchers`) that map onto AEP's vocabulary through the shared
    :class:`_EmissionCore`:

    - the **top-level agent** (one per ``session_id``) is the orchestrator root
      (new AEP trace + root session), opened lazily on its first hook and closed
      on ``Stop``;
    - each ``SubagentStart`` opens a **sub-agent** of that root via
      ``handoff.started`` + ``task.created`` (closed by ``SubagentStop``);
    - each ``PreToolUse`` opens a tool run on its owning agent's session
      (the sub-agent named by ``agent_id`` if one is open, else the root),
      paired to its ``PostToolUse`` / ``PostToolUseFailure`` by ``tool_use_id``.

    The mapping never imports ``claude_agent_sdk`` — the hook inputs are plain
    dicts — so it is unit-testable with fabricated events; only
    :class:`ClaudeAgentInstrumentor` touches the framework. Each callback returns
    ``{}`` (a no-op hook output: proceed, no decision), and swallows its own
    errors, so AEP telemetry can never alter or break the host agent run.

    Caveat: the top-level run is closed by the ``Stop`` hook (fired at the end of
    each turn). A multi-turn ``ClaudeSDKClient`` session therefore records one
    trace per turn (the root is reopened on the next turn's first hook).
    """

    def __init__(self, client: Any, max_runs: int = DEFAULT_MAX_RUNS) -> None:
        self._core = _EmissionCore(client, max_runs=max_runs)
        self._lock = threading.Lock()
        # session_id -> True for top-level runs currently open.
        self._roots: OrderedDict[str, bool] = OrderedDict()
        # (session_id, agent_id) for sub-agent runs currently open — used to
        # resolve a tool's owning agent (sub-agent vs the root).
        self._open_subagents: OrderedDict[tuple, bool] = OrderedDict()
        self._max_runs = max_runs

    @property
    def _runs(self):  # exposed for tests + run-cap assertions
        return self._core._runs

    def flush(self, timeout: float = 5.0) -> bool:
        return self._core.flush(timeout)

    def close(self, timeout: float = 5.0) -> None:
        self._core.close(timeout)

    # -- run keys -------------------------------------------------------------

    @staticmethod
    def _root_key(session_id: Any) -> str:
        return f"{session_id}:root"

    @staticmethod
    def _agent_key(session_id: Any, agent_id: Any) -> str:
        return f"{session_id}:agent:{agent_id}"

    @staticmethod
    def _tool_key(session_id: Any, tool_use_id: Any) -> str:
        return f"{session_id}:tool:{tool_use_id}"

    def _ensure_root(self, session_id: Any) -> None:
        """Open the top-level (orchestrator) run for a session, once."""
        if not session_id:
            return
        with self._lock:
            if session_id in self._roots:
                return
            self._roots[session_id] = True
            while len(self._roots) > self._max_runs:
                self._roots.popitem(last=False)
        self._core.open_agent_run(
            self._root_key(session_id),
            name="claude-agent",
            framework="claude-agent",
            kind="session",
            parent_key=None,
        )

    # -- hook callbacks (async; return {} = no-op observer) -------------------

    async def on_user_prompt_submit(self, input: Any, tool_use_id: Any, context: Any) -> dict:
        try:
            self._ensure_root(self._get(input, "session_id"))
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: Claude Agent UserPromptSubmit hook error: %s", e)
        return {}

    async def on_stop(self, input: Any, tool_use_id: Any, context: Any) -> dict:
        try:
            sid = self._get(input, "session_id")
            if sid:
                # Close any sub-agents that never received a SubagentStop, then
                # the root, so nothing lingers open at the end of the turn.
                with self._lock:
                    stragglers = [k for k in self._open_subagents if k[0] == sid]
                    had_root = sid in self._roots
                    for k in stragglers:
                        self._open_subagents.pop(k, None)
                    self._roots.pop(sid, None)
                for skey_sid, skey_aid in stragglers:
                    self._core.close_agent_run(
                        self._agent_key(skey_sid, skey_aid), status="completed"
                    )
                if had_root:
                    self._core.close_agent_run(self._root_key(sid), status="completed")
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: Claude Agent Stop hook error: %s", e)
        return {}

    async def on_subagent_start(self, input: Any, tool_use_id: Any, context: Any) -> dict:
        try:
            sid = self._get(input, "session_id")
            aid = self._get(input, "agent_id")
            if not sid or not aid:
                return {}
            self._ensure_root(sid)
            name = self._get(input, "agent_type") or aid
            self._core.open_agent_run(
                self._agent_key(sid, aid),
                name=name,
                framework="claude-agent",
                kind="subagent",
                parent_key=self._root_key(sid),
            )
            with self._lock:
                self._open_subagents[(sid, aid)] = True
                while len(self._open_subagents) > self._max_runs:
                    self._open_subagents.popitem(last=False)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: Claude Agent SubagentStart hook error: %s", e)
        return {}

    async def on_subagent_stop(self, input: Any, tool_use_id: Any, context: Any) -> dict:
        try:
            sid = self._get(input, "session_id")
            aid = self._get(input, "agent_id")
            if not sid or not aid:
                return {}
            with self._lock:
                self._open_subagents.pop((sid, aid), None)
            self._core.close_agent_run(self._agent_key(sid, aid), status="completed")
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: Claude Agent SubagentStop hook error: %s", e)
        return {}

    async def on_pre_tool_use(self, input: Any, tool_use_id: Any, context: Any) -> dict:
        try:
            sid = self._get(input, "session_id")
            tuid = self._get(input, "tool_use_id") or tool_use_id
            if not sid or not tuid:
                return {}
            self._ensure_root(sid)
            aid = self._get(input, "agent_id")
            with self._lock:
                is_sub = (sid, aid) in self._open_subagents
            parent_key = self._agent_key(sid, aid) if is_sub else self._root_key(sid)
            self._core.open_tool_run(
                self._tool_key(sid, tuid),
                name=self._get(input, "tool_name") or "tool",
                arguments=self._coerce(self._get(input, "tool_input")),
                parent_key=parent_key,
            )
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: Claude Agent PreToolUse hook error: %s", e)
        return {}

    async def on_post_tool_use(self, input: Any, tool_use_id: Any, context: Any) -> dict:
        try:
            sid = self._get(input, "session_id")
            tuid = self._get(input, "tool_use_id") or tool_use_id
            if not sid or not tuid:
                return {}
            self._core.close_tool_run(
                self._tool_key(sid, tuid), output=self._get(input, "tool_response")
            )
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: Claude Agent PostToolUse hook error: %s", e)
        return {}

    async def on_post_tool_use_failure(self, input: Any, tool_use_id: Any, context: Any) -> dict:
        try:
            sid = self._get(input, "session_id")
            tuid = self._get(input, "tool_use_id") or tool_use_id
            if not sid or not tuid:
                return {}
            self._core.fail_tool_run(
                self._tool_key(sid, tuid), error=self._get(input, "error")
            )
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: Claude Agent PostToolUseFailure hook error: %s", e)
        return {}

    # -- helpers --------------------------------------------------------------

    @staticmethod
    def _get(input: Any, key: str) -> Any:
        """Read a field from a hook input (a dict; tolerate attr-style too)."""
        if isinstance(input, dict):
            return input.get(key)
        return getattr(input, key, None)

    @staticmethod
    def _coerce(tool_input: Any) -> dict:
        """Normalise a hook's ``tool_input`` into a JSON-safe dict."""
        if isinstance(tool_input, dict):
            return tool_input
        if tool_input is None:
            return {}
        return {"input": _stringify(tool_input)}

    def hook_matchers(self) -> dict:
        """Return the ``{event: [callback, ...]}`` map this tracer observes.

        Returned as raw callbacks keyed by hook-event name; the instrumentor wraps
        each list in the SDK's ``HookMatcher`` (which it imports) before injecting
        into ``ClaudeAgentOptions.hooks``.
        """
        return {
            "UserPromptSubmit": [self.on_user_prompt_submit],
            "Stop": [self.on_stop],
            "SubagentStart": [self.on_subagent_start],
            "SubagentStop": [self.on_subagent_stop],
            "PreToolUse": [self.on_pre_tool_use],
            "PostToolUse": [self.on_post_tool_use],
            "PostToolUseFailure": [self.on_post_tool_use_failure],
        }


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


class AutoGenInstrumentor(FrameworkInstrumentor):
    """Wraps ``BaseGroupChat.run_stream`` to tap AutoGen AgentChat team runs."""

    def __init__(self) -> None:
        super().__init__(name="autogen")
        self._original: Any = None

    def available(self) -> bool:
        # Only claim availability when the team base class we patch is importable,
        # so an AutoGen release whose layout has drifted (or 0.2-era pyautogen)
        # degrades to a clean no-op.
        try:
            import autogen_agentchat  # noqa: F401
            from autogen_agentchat.teams._group_chat._base_group_chat import (  # noqa: F401
                BaseGroupChat,
            )
        except Exception:
            return False
        return True

    def _target(self):
        from autogen_agentchat.teams._group_chat._base_group_chat import BaseGroupChat

        return BaseGroupChat

    def instrument(self, client: Any) -> bool:
        try:
            target = self._target()
        except Exception as e:
            logger.warning(
                "AEP: could not locate AutoGen BaseGroupChat "
                "(autogen-agentchat>=%s expected, installed: %s): %s",
                MIN_AUTOGEN_VERSION,
                _autogen_version(),
                e,
            )
            return False

        tracer = AEPAutoGenTracer(client)

        if getattr(target, "_aep_instrumented", False):
            # Already patched in this process; refresh the active tracer and
            # retire the previous one's background worker.
            previous = getattr(target, "_aep_tracer", None)
            target._aep_tracer = tracer  # type: ignore[attr-defined]
            self._transport = tracer
            if previous is not None and previous is not tracer:
                try:
                    previous.close(timeout=1.0)
                except Exception:  # pragma: no cover - defensive
                    pass
            return True

        original = getattr(target, "run_stream", None)
        if original is None:
            logger.warning(
                "AEP: AutoGen BaseGroupChat exposes no run_stream — AutoGen "
                "internals may have changed; instrumentation disabled."
            )
            tracer.close(timeout=0.0)  # don't leak the emitter's worker thread
            return False

        self._original = original
        target.run_stream = _make_run_stream_wrapper(target, original)  # type: ignore[attr-defined]
        target._aep_instrumented = True  # type: ignore[attr-defined]
        target._aep_tracer = tracer  # type: ignore[attr-defined]
        self._transport = tracer
        return True

    def uninstrument(self) -> None:
        try:
            target = self._target()
        except Exception:
            target = None
        if target is not None:
            if self._original is not None:
                target.run_stream = self._original  # type: ignore[attr-defined]
            for attr in ("_aep_instrumented", "_aep_tracer"):
                if hasattr(target, attr):
                    delattr(target, attr)
        self._original = None
        super().uninstrument()


class OpenAIAgentsInstrumentor(FrameworkInstrumentor):
    """Registers an :class:`AEPOpenAIAgentsTracer` on the OpenAI Agents SDK's
    global tracing pipeline (``agents.tracing.add_trace_processor``).

    This is the supported, zero-code observation surface: the processor receives
    every ``Runner.run`` trace/span in-process, alongside (not replacing) the
    SDK's own default exporter. Uninstrument removes only our processor.
    """

    def __init__(self) -> None:
        super().__init__(name="openai-agents")

    def available(self) -> bool:
        # Only claim availability when the tracing registration API we use is
        # importable, so an Agents SDK whose tracing layout has drifted (or no
        # SDK at all) degrades to a clean no-op.
        try:
            import agents  # noqa: F401
            from agents.tracing import add_trace_processor  # noqa: F401
        except Exception:
            return False
        return True

    def _provider(self) -> Any:
        from agents.tracing import get_trace_provider

        return get_trace_provider()

    def _remove_aep_processors(self) -> None:
        """Drop any previously-registered AEP tracer from the provider's list.

        Leaves the SDK's default exporter (and any other processors) untouched —
        ``set_processors`` only replaces the tuple, it does not shut anyone down.

        The Agents SDK exposes no public single-processor removal (only
        ``add_trace_processor`` + replace-all ``set_trace_processors``), so this
        reaches into ``provider._multi_processor``. If that internal layout has
        drifted we **warn** rather than fail silently: a stale processor left
        registered would keep receiving spans after ``uninstrument()`` (and emit
        onto a stopped worker), which must not happen quietly.
        """
        try:
            mp = self._provider()._multi_processor
            current = list(getattr(mp, "_processors", ()))
        except Exception as e:
            logger.warning(
                "AEP: could not access the OpenAI Agents processor list to remove "
                "the AEP tracer (SDK tracing internals may have changed): %s. The "
                "AEP processor may still be registered.",
                e,
            )
            return
        kept = [p for p in current if not isinstance(p, AEPOpenAIAgentsTracer)]
        if len(kept) == len(current):
            return  # nothing of ours to remove
        try:
            mp.set_processors(kept)
        except Exception as e:
            logger.warning(
                "AEP: could not remove the AEP tracer from the OpenAI Agents "
                "processor list (SDK tracing internals may have changed): %s. The "
                "AEP processor may still be registered.",
                e,
            )

    def instrument(self, client: Any) -> bool:
        try:
            from agents.tracing import add_trace_processor
        except Exception as e:
            logger.warning(
                "AEP: could not access OpenAI Agents tracing API "
                "(openai-agents>=%s expected, installed: %s): %s",
                MIN_OPENAI_AGENTS_VERSION,
                _openai_agents_version(),
                e,
            )
            return False

        tracer = AEPOpenAIAgentsTracer(client)

        # Idempotent re-instrumentation: retire any prior AEP tracer first (so we
        # never register two), then add the fresh one.
        previous = self._transport
        self._remove_aep_processors()
        try:
            add_trace_processor(tracer)
        except Exception as e:
            logger.warning("AEP: failed to register OpenAI Agents trace processor: %s", e)
            tracer.close(timeout=0.0)  # don't leak the emitter's worker thread
            return False

        self._transport = tracer
        if isinstance(previous, AEPOpenAIAgentsTracer) and previous is not tracer:
            try:
                previous.close(timeout=1.0)
            except Exception:  # pragma: no cover - defensive
                pass
        return True

    def uninstrument(self) -> None:
        self._remove_aep_processors()
        super().uninstrument()


def _make_run_stream_wrapper(target_cls: Any, original: Any):
    """Wrap ``BaseGroupChat.run_stream`` so the active tracer taps its stream.

    The tracer is read from the class at call time (``target_cls._aep_tracer``)
    so re-instrumenting with a new client takes effect without re-patching. The
    wrapper returns the same async generator of items the original yields — fully
    transparent to callers (including ``BaseGroupChat.run``, which consumes
    ``run_stream`` internally).
    """

    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        tracer = getattr(target_cls, "_aep_tracer", None)
        gen = original(self, *args, **kwargs)
        if tracer is None:
            return gen
        return tracer.wrap_stream(self, gen)

    wrapper.__name__ = getattr(original, "__name__", "run_stream")
    wrapper.__qualname__ = getattr(original, "__qualname__", "run_stream")
    wrapper.__doc__ = getattr(original, "__doc__", None)
    wrapper.__wrapped__ = original  # type: ignore[attr-defined]
    return wrapper


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


class ClaudeAgentInstrumentor(FrameworkInstrumentor):
    """Injects AEP hooks into the Anthropic Claude Agent SDK.

    The SDK exposes ``ClaudeAgentOptions.hooks`` as its supported observation
    surface; both public entry points consume it via the internal
    ``InternalClient.process_query`` (used by ``query()``) and
    ``ClaudeSDKClient.connect`` (the streaming client). This instrumentor wraps
    those two methods to merge an :class:`AEPClaudeAgentTracer`'s hook callbacks
    into the ``options`` before the SDK reads them — analogous to injecting the
    LangGraph callback handler into a ``RunnableConfig``. Patching at the
    consuming methods (rather than the public ``query`` function) makes
    instrumentation robust to ``from claude_agent_sdk import query`` import
    timing. ``uninstrument()`` restores both methods.
    """

    def __init__(self) -> None:
        super().__init__(name="claude-agent")
        self._orig_process_query: Any = None
        self._orig_connect: Any = None

    def available(self) -> bool:
        # Only claim availability when the hooks API + the methods we patch are
        # importable, so a drifted/older SDK degrades to a clean no-op.
        try:
            import claude_agent_sdk  # noqa: F401
            from claude_agent_sdk import ClaudeSDKClient, HookMatcher  # noqa: F401
            from claude_agent_sdk._internal.client import InternalClient  # noqa: F401
        except Exception:
            return False
        return True

    def _targets(self):
        from claude_agent_sdk import ClaudeSDKClient, HookMatcher
        from claude_agent_sdk._internal.client import InternalClient

        return InternalClient, ClaudeSDKClient, HookMatcher

    def instrument(self, client: Any) -> bool:
        try:
            internal_client, sdk_client, hook_matcher = self._targets()
        except Exception as e:
            logger.warning(
                "AEP: could not locate Claude Agent SDK hook injection points "
                "(claude-agent-sdk>=%s expected, installed: %s): %s",
                MIN_CLAUDE_AGENT_VERSION,
                _claude_agent_version(),
                e,
            )
            return False

        tracer = AEPClaudeAgentTracer(client)

        if getattr(internal_client, "_aep_instrumented", False):
            # Already patched in this process; refresh the active tracer on both
            # classes and retire the previous one's background worker.
            previous = getattr(internal_client, "_aep_tracer", None)
            internal_client._aep_tracer = tracer  # type: ignore[attr-defined]
            sdk_client._aep_tracer = tracer  # type: ignore[attr-defined]
            self._transport = tracer
            if previous is not None and previous is not tracer:
                try:
                    previous.close(timeout=1.0)
                except Exception:  # pragma: no cover - defensive
                    pass
            return True

        pq = getattr(internal_client, "process_query", None)
        conn = getattr(sdk_client, "connect", None)
        if pq is None or conn is None:
            logger.warning(
                "AEP: Claude Agent SDK exposed neither process_query nor connect "
                "— SDK internals may have changed; instrumentation disabled."
            )
            tracer.close(timeout=0.0)  # don't leak the emitter's worker thread
            return False

        self._orig_process_query = pq
        self._orig_connect = conn
        internal_client.process_query = _make_claude_process_query_wrapper(
            internal_client, pq, hook_matcher
        )
        sdk_client.connect = _make_claude_connect_wrapper(sdk_client, conn, hook_matcher)
        internal_client._aep_instrumented = True  # type: ignore[attr-defined]
        internal_client._aep_tracer = tracer  # type: ignore[attr-defined]
        sdk_client._aep_tracer = tracer  # type: ignore[attr-defined]
        self._transport = tracer
        return True

    def uninstrument(self) -> None:
        try:
            internal_client, sdk_client, _ = self._targets()
        except Exception:
            internal_client = sdk_client = None
        if internal_client is not None and self._orig_process_query is not None:
            internal_client.process_query = self._orig_process_query
            for attr in ("_aep_instrumented", "_aep_tracer"):
                if hasattr(internal_client, attr):
                    delattr(internal_client, attr)
        if sdk_client is not None and self._orig_connect is not None:
            sdk_client.connect = self._orig_connect
            if hasattr(sdk_client, "_aep_tracer"):
                delattr(sdk_client, "_aep_tracer")
        self._orig_process_query = None
        self._orig_connect = None
        super().uninstrument()


def _inject_claude_hooks(options: Any, tracer: Any, hook_matcher: Any) -> Any:
    """Return ``options`` with the tracer's hook callbacks merged into ``hooks``.

    Produces a copy (via ``dataclasses.replace``) so a user-supplied options
    object is never mutated. Idempotent: if our callbacks are already registered
    for an event (e.g. on reconnect), that event is left untouched.
    """
    from dataclasses import replace

    matchers = tracer.hook_matchers()
    existing = dict(options.hooks) if getattr(options, "hooks", None) else {}
    changed = False
    for event, callbacks in matchers.items():
        current = list(existing.get(event, []))
        already = any(
            cb in getattr(m, "hooks", []) for m in current for cb in callbacks
        )
        if already:
            continue
        current.append(hook_matcher(matcher=None, hooks=list(callbacks)))
        existing[event] = current
        changed = True
    if not changed:
        return options
    return replace(options, hooks=existing)


def _make_claude_process_query_wrapper(target_cls: Any, original: Any, hook_matcher: Any):
    """Wrap ``InternalClient.process_query`` (an async generator) to inject hooks.

    The tracer is read from the class at call time so re-instrumenting with a new
    client takes effect without re-patching. Fully transparent — re-yields exactly
    what the original yields.
    """

    async def wrapper(self: Any, prompt: Any, options: Any, transport: Any = None):
        tracer = getattr(target_cls, "_aep_tracer", None)
        if tracer is not None:
            try:
                options = _inject_claude_hooks(options, tracer, hook_matcher)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning(
                    "AEP: failed to inject Claude Agent hooks, running "
                    "uninstrumented: %s",
                    e,
                )
        async for message in original(self, prompt, options, transport):
            yield message

    wrapper.__name__ = getattr(original, "__name__", "process_query")
    wrapper.__qualname__ = getattr(original, "__qualname__", "process_query")
    wrapper.__doc__ = getattr(original, "__doc__", None)
    wrapper.__wrapped__ = original  # type: ignore[attr-defined]
    return wrapper


def _make_claude_connect_wrapper(target_cls: Any, original: Any, hook_matcher: Any):
    """Wrap ``ClaudeSDKClient.connect`` (a coroutine) to inject hooks into options."""

    async def wrapper(self: Any, prompt: Any = None):
        tracer = getattr(target_cls, "_aep_tracer", None)
        if tracer is not None:
            try:
                self.options = _inject_claude_hooks(self.options, tracer, hook_matcher)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning(
                    "AEP: failed to inject Claude Agent hooks, running "
                    "uninstrumented: %s",
                    e,
                )
        return await original(self, prompt)

    wrapper.__name__ = getattr(original, "__name__", "connect")
    wrapper.__qualname__ = getattr(original, "__qualname__", "connect")
    wrapper.__doc__ = getattr(original, "__doc__", None)
    wrapper.__wrapped__ = original  # type: ignore[attr-defined]
    return wrapper


# Register built-in instrumentors.
_INSTRUMENTORS["langgraph"] = LangGraphInstrumentor()
_INSTRUMENTORS["crewai"] = CrewAIInstrumentor()
_INSTRUMENTORS["autogen"] = AutoGenInstrumentor()
_INSTRUMENTORS["openai-agents"] = OpenAIAgentsInstrumentor()
_INSTRUMENTORS["claude-agent"] = ClaudeAgentInstrumentor()


# ── Public API ──────────────────────────────────────────────────────────────


def instrument(
    server_url: str | None = None,
    api_key: str | None = None,
    *,
    client: AEPClient | None = None,
    frameworks: list[str] | None = None,
) -> bool:
    """Enable AEP auto-instrumentation for supported agent frameworks.

    Supports **LangGraph** (``langgraph>=0.1``), **CrewAI** (``crewai>=1.0``),
    **AutoGen AgentChat** (``autogen-agentchat>=0.4``), the **OpenAI Agents SDK**
    (``openai-agents>=0.1``), and the **Anthropic Claude Agent SDK**
    (``claude-agent-sdk>=0.2``). Running a graph / crew / team / ``Runner.run`` /
    ``query()`` after calling this emits AEP events for the run, each sub-agent,
    every tool call, and agent-to-agent handoffs — with full causation chains —
    and requires no other code changes. Only the frameworks you actually use need
    be installed: instrumenting CrewAI does not require ``langchain``.

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
            "is a no-op. Install LangGraph (>=%s), CrewAI (>=%s), "
            "AutoGen AgentChat (>=%s), the OpenAI Agents SDK (>=%s), or the "
            "Anthropic Claude Agent SDK (>=%s).",
            ", ".join(targets),
            MIN_LANGGRAPH_VERSION,
            MIN_CREWAI_VERSION,
            MIN_AUTOGEN_VERSION,
            MIN_OPENAI_AGENTS_VERSION,
            MIN_CLAUDE_AGENT_VERSION,
        )
        return False

    with _state_lock:
        if client is not None:
            _active_client = client
            _owns_client = False
        elif _active_client is None:
            try:
                from aep.client import AEPClient

                # The background emitter holds one event at a time: keep its
                # retry budget small so a down server doesn't multiply the
                # per-event hold time and fill the bounded queue.
                _active_client = AEPClient(
                    server_url=server_url, api_key=api_key, max_retries=1
                )
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
