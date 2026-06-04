"""Framework auto-instrumentation for AEP.

``aep.instrument()`` patches supported agent frameworks so that running a
workflow automatically emits AEP events — no other code changes required.

The first supported framework is **LangGraph** (tested against ``langgraph>=0.1``).
Instrumentation is implemented as a LangChain ``BaseCallbackHandler`` that is
injected into every ``CompiledStateGraph`` execution. The handler maps:

- graph run (root)        → ``task.created`` / ``task.completed`` / ``task.failed``  (orchestrator)
- node run (sub-agent)    → ``task.created`` / ``task.completed`` / ``task.failed``  (subagent)
- orchestrator → node     → ``handoff.started`` / ``handoff.completed``
- tool call               → ``tool.called`` / ``tool.result`` / ``error.raised``

Causation is preserved end-to-end: every event carries a ``trace_id`` shared
across the whole graph run, a per-run ``session_id``, a ``parent_session_id``
linking sub-agents to their orchestrator, and a ``causation_id`` pointing at the
event that triggered it — so a multi-agent run reconstructs as a DAG in the AEP
dashboard.

Adding another framework is a matter of registering a new
:class:`FrameworkInstrumentor` in ``_INSTRUMENTORS`` (see ``LangGraphInstrumentor``).

Usage::

    import aep
    aep.instrument()                 # reads AEP_INGEST_URL / AEP_API_KEY
    # ... build and run your LangGraph graph as usual ...

Design rules:
- **Never crash the host app.** Missing frameworks → warn + no-op. Emit failures
  → logged, swallowed. Unexpected framework internals → warn + skip, never raise.
"""

from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from aep.client import AEPClient

logger = logging.getLogger(__name__)

# Tested-against version floor; surfaced in warnings to aid debugging.
MIN_LANGGRAPH_VERSION = "0.1"

# Module-level registry of framework instrumentors, populated at import time.
_INSTRUMENTORS: dict[str, "FrameworkInstrumentor"] = {}

# The client used by all active instrumentation. Set by instrument().
_state_lock = threading.Lock()
_active_client: Optional["AEPClient"] = None
_owns_client = False


# ── ID helpers ──────────────────────────────────────────────────────────────


def _new_session_id() -> str:
    return f"ses_{uuid.uuid4().hex[:12]}"


def _new_trace_id() -> str:
    return f"trc_{uuid.uuid4().hex[:16]}"


# ── Run bookkeeping ─────────────────────────────────────────────────────────


@dataclass
class _RunInfo:
    """Tracks one in-flight run (graph, node, or tool) keyed by its run_id."""

    session_id: str
    trace_id: str
    source: str
    name: str
    kind: str  # "graph" | "node" | "tool"
    # Event id of this run's opening event (task.created or tool.called); used as
    # the causation_id for the run's children and its own closing event.
    open_event_id: str
    agent_role: Optional[str] = None
    parent_session_id: Optional[str] = None
    # For node runs: the handoff.started event id on the parent session, so the
    # matching handoff.completed can chain off it.
    handoff_event_id: Optional[str] = None
    # For node runs: the parent (orchestrator) role, so handoff.completed —
    # which is emitted on the parent session — reads the parent's role.
    parent_agent_role: Optional[str] = None


# ── LangChain callback handler ──────────────────────────────────────────────


def _build_callback_base():
    """Return a BaseCallbackHandler subclass, or None if LangChain is absent.

    Defined lazily so importing ``aep`` never hard-depends on LangChain.
    """
    try:
        from langchain_core.callbacks import BaseCallbackHandler
    except Exception:  # pragma: no cover - exercised only without langchain
        return None

    class AEPCallbackHandler(BaseCallbackHandler):
        """Emits AEP events from LangChain/LangGraph callback hooks.

        One handler instance is shared across graph runs. All mutable state is
        guarded by a lock because LangGraph runs sibling nodes concurrently.
        """

        # We never raise out of a callback — partial telemetry beats a crashed app.
        raise_error = False

        def __init__(self, client: "AEPClient") -> None:
            self._client = client
            self._lock = threading.Lock()
            self._runs: dict[str, _RunInfo] = {}

        # -- emission ---------------------------------------------------------

        def _emit(self, **kwargs: Any) -> Optional[str]:
            """Create + emit an event. Returns its id, or None on failure."""
            from aep import create_event

            try:
                event = create_event(**kwargs)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("AEP: failed to build %s event: %s", kwargs.get("type"), e)
                return None
            try:
                self._client.emit(event)
            except Exception as e:
                # Network/server hiccups must not break the host workflow.
                logger.warning("AEP: failed to emit %s event: %s", event.get("type"), e)
            return event["id"]

        def _get(self, run_id: Any) -> Optional[_RunInfo]:
            with self._lock:
                return self._runs.get(str(run_id))

        def _put(self, run_id: Any, info: _RunInfo) -> None:
            with self._lock:
                self._runs[str(run_id)] = info

        def _pop(self, run_id: Any) -> Optional[_RunInfo]:
            with self._lock:
                return self._runs.pop(str(run_id), None)

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
            parent = self._get(parent_run_id) if parent_run_id is not None else None

            # We only model two kinds of chains:
            #   - the graph root (no parent)               → orchestrator
            #   - a langgraph node with a tracked parent   → subagent
            # Other intermediate runnables are ignored to keep the event stream clean.
            is_root = parent_run_id is None
            if not is_root and node_name is None:
                return
            if not is_root and parent is None:
                # Node whose parent we didn't track (unexpected) — treat as standalone root.
                is_root = True

            name = node_name or kwargs.get("name") or (serialized or {}).get("name") or "graph"

            if is_root:
                session_id = _new_session_id()
                trace_id = _new_trace_id()
                source = f"agent://{name}"
                open_id = self._emit(
                    source=source,
                    type="task.created",
                    session_id=session_id,
                    trace_id=trace_id,
                    agent_role="orchestrator",
                    subject=name,
                    payload={"framework": "langgraph", "node": name, "kind": "graph"},
                )
                self._put(
                    run_id,
                    _RunInfo(
                        session_id=session_id,
                        trace_id=trace_id,
                        source=source,
                        name=name,
                        kind="graph",
                        open_event_id=open_id or "",
                        agent_role="orchestrator",
                    ),
                )
                return

            # Sub-agent node: hand off from the orchestrator, then open the node task.
            session_id = _new_session_id()
            trace_id = parent.trace_id
            source = f"agent://{name}"
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
                payload={"framework": "langgraph", "node": name, "kind": "node"},
            )
            self._put(
                run_id,
                _RunInfo(
                    session_id=session_id,
                    trace_id=trace_id,
                    source=source,
                    name=name,
                    kind="node",
                    open_event_id=open_id or "",
                    agent_role="subagent",
                    parent_session_id=parent.session_id,
                    handoff_event_id=handoff_id,
                    parent_agent_role=parent.agent_role,
                ),
            )

        def on_chain_end(self, outputs: Any, *, run_id: Any, **kwargs: Any) -> None:
            info = self._pop(run_id)
            if info is None:
                return
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
            self._close_handoff(info, status="completed")

        def on_chain_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None:
            info = self._pop(run_id)
            if info is None:
                return
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
                    "error": str(error),
                    "error_type": type(error).__name__,
                },
            )
            self._close_handoff(info, status="failed")

        def _close_handoff(self, info: _RunInfo, *, status: str) -> None:
            if info.kind != "node" or not info.handoff_event_id:
                return
            # Emitted on the parent (orchestrator) session, chained off handoff.started.
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
            parent = self._get(parent_run_id) if parent_run_id is not None else None
            tool_name = (serialized or {}).get("name") or kwargs.get("name") or "tool"

            if parent is not None:
                session_id = parent.session_id
                trace_id = parent.trace_id
                source = parent.source
                agent_role = parent.agent_role
                parent_session_id = parent.parent_session_id
                causation = parent.open_event_id or None
            else:
                # Tool invoked outside any tracked run — emit a standalone pair.
                session_id = _new_session_id()
                trace_id = _new_trace_id()
                source = f"agent://{tool_name}"
                agent_role = "standalone"
                parent_session_id = None
                causation = None

            arguments = inputs if isinstance(inputs, dict) else {"input": input_str}
            open_id = self._emit(
                source=source,
                type="tool.called",
                session_id=session_id,
                trace_id=trace_id,
                agent_role=agent_role,
                parent_session_id=parent_session_id,
                subject=tool_name,
                causation_id=causation,
                payload={"tool_name": tool_name, "arguments": arguments},
            )
            self._put(
                run_id,
                _RunInfo(
                    session_id=session_id,
                    trace_id=trace_id,
                    source=source,
                    name=tool_name,
                    kind="tool",
                    open_event_id=open_id or "",
                    agent_role=agent_role,
                    parent_session_id=parent_session_id,
                ),
            )

        def on_tool_end(self, output: Any, *, run_id: Any, **kwargs: Any) -> None:
            info = self._pop(run_id)
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

        def on_tool_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None:
            info = self._pop(run_id)
            if info is None:
                return
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
                    "error": str(error),
                    "error_type": type(error).__name__,
                },
            )

    return AEPCallbackHandler


def _stringify(value: Any) -> Any:
    """Keep JSON-safe values as-is; stringify everything else for transport."""
    if isinstance(value, (str, int, float, bool, dict, list)) or value is None:
        return value
    return str(value)


# ── Framework instrumentors ─────────────────────────────────────────────────


@dataclass
class FrameworkInstrumentor:
    """Base class for per-framework patching. Subclass and register to add one."""

    name: str

    def available(self) -> bool:
        raise NotImplementedError

    def instrument(self, handler: Any) -> bool:
        """Patch the framework to route through ``handler``. Returns success."""
        raise NotImplementedError

    def uninstrument(self) -> None:
        """Best-effort restore of original behavior."""


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

    def instrument(self, handler: Any) -> bool:
        try:
            target = self._target()
        except Exception as e:
            logger.warning(
                "AEP: could not locate CompiledStateGraph (langgraph>=%s expected): %s",
                MIN_LANGGRAPH_VERSION,
                e,
            )
            return False

        if getattr(target, "_aep_instrumented", False):
            # Already patched in this process; just refresh the active handler.
            target._aep_handler = handler  # type: ignore[attr-defined]
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
            return False

        target._aep_instrumented = True  # type: ignore[attr-defined]
        target._aep_handler = handler  # type: ignore[attr-defined]
        return True

    def uninstrument(self) -> None:
        try:
            target = self._target()
        except Exception:
            return
        for method, original in self._originals.items():
            setattr(target, method, original)
        self._originals.clear()
        for attr in ("_aep_instrumented", "_aep_handler"):
            if hasattr(target, attr):
                delattr(target, attr)


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


# ── Public API ──────────────────────────────────────────────────────────────


def instrument(
    server_url: str | None = None,
    api_key: str | None = None,
    *,
    client: "AEPClient | None" = None,
    frameworks: list[str] | None = None,
) -> bool:
    """Enable AEP auto-instrumentation for supported agent frameworks.

    Currently supports **LangGraph** (``langgraph>=0.1``). Running a graph after
    calling this emits AEP events for the graph, each node, every tool call, and
    agent-to-agent handoffs — with full causation chains — and requires no other
    code changes.

    Args:
        server_url: AEP ingest URL (falls back to ``AEP_INGEST_URL`` env var,
            then ``http://localhost:8787``).
        api_key: API key (falls back to ``AEP_API_KEY`` env var).
        client: A pre-built :class:`~aep.client.AEPClient` to use instead of
            constructing one (handy for tests or shared connection pooling).
        frameworks: Restrict patching to these framework names. Defaults to all
            registered frameworks that are importable.

    Returns:
        ``True`` if at least one framework was instrumented, else ``False``.

    Never raises on a missing framework — it logs a warning and returns ``False``
    so adding ``aep.instrument()`` can't take down the host application.
    """
    global _active_client, _owns_client

    base = _build_callback_base()
    if base is None:
        logger.warning(
            "AEP: langchain-core is not installed; aep.instrument() is a no-op. "
            "Install LangGraph (which pulls in langchain-core): pip install langgraph"
        )
        return False

    targets = frameworks or list(_INSTRUMENTORS.keys())
    available = [n for n in targets if n in _INSTRUMENTORS and _INSTRUMENTORS[n].available()]
    if not available:
        logger.warning(
            "AEP: no supported framework found (looked for: %s); aep.instrument() is a no-op. "
            "Install LangGraph (>=%s): pip install langgraph",
            ", ".join(targets),
            MIN_LANGGRAPH_VERSION,
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

    handler = base(active_client)

    instrumented: list[str] = []
    for fw in available:
        try:
            if _INSTRUMENTORS[fw].instrument(handler):
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


def uninstrument() -> None:
    """Undo all instrumentation and release an internally-created client."""
    global _active_client, _owns_client
    for inst in _INSTRUMENTORS.values():
        try:
            inst.uninstrument()
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("AEP: failed to uninstrument %s: %s", inst.name, e)
    with _state_lock:
        if _owns_client and _active_client is not None:
            try:
                _active_client.close()
            except Exception:
                pass
        _active_client = None
        _owns_client = False
