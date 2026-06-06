/**
 * Zero-code framework auto-instrumentation for the AEP Node SDK.
 *
 * Phase 12g PR2 supports **LangChain.js / LangGraph**: `await instrument()`
 * patches `CompiledStateGraph` so running a graph automatically emits AEP events
 * for the run, each node (sub-agent), every tool call, and the handoffs between
 * them — no other code changes required.
 *
 * Architecture mirrors the Python SDK's `aep/instrument.py`:
 *   - {@link EmissionCore} is a transport-neutral emitter + bounded run table
 *     that owns ALL causation/trace/session/handoff threading and exposes
 *     semantic ops (openAgentRun / closeAgentRun / openToolRun / …).
 *   - {@link LangGraphMapper} translates normalized callback info into core
 *     calls. It never imports LangChain, so it is unit-testable with plain
 *     objects.
 *   - The LangChain `BaseCallbackHandler` adapter (built lazily in
 *     {@link LangGraphInstrumentor.instrument}) is the only piece that touches
 *     the framework.
 *
 * Mapping (LangGraph → AEP): graph root → orchestrator `task.*`; each node →
 * sub-agent `task.*` reached via `handoff.*`; tool → `tool.called`/`tool.result`/
 * `error.raised`. One `trace_id` per run; every `causation_id` resolves to a real
 * emitted event. Framework-internal hidden chains (e.g. `__start__`, tagged
 * `langsmith:hidden`) are skipped to keep the DAG clean.
 */

import { randomUUID } from "node:crypto";

import { AEPClient } from "./client.js";
import { createEvent } from "./event.js";
import type { AEPEvent } from "./types.js";

const DEFAULT_MAX_RUNS = 10_000;
const DEFAULT_MAX_QUEUE = 10_000;

// ── Background emitter ──────────────────────────────────────────────────────

/**
 * Sends events without blocking the host: callbacks enqueue, a single async
 * drain loop POSTs them in order. Event ids are generated synchronously by
 * `createEvent` before enqueue, so causation chains are intact regardless of
 * when the POST happens. The queue is bounded (drops + warns under overload).
 */
class Emitter {
  private queue: AEPEvent[] = [];
  private draining = false;
  private dropped = 0;

  constructor(
    private readonly client: { emit(e: AEPEvent): Promise<unknown> },
    private readonly maxQueue = DEFAULT_MAX_QUEUE,
  ) {}

  submit(event: AEPEvent): void {
    if (this.queue.length >= this.maxQueue) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 100 === 0) {
        console.warn(
          `AEP: emit queue full — dropped ${this.dropped} event(s) so far. ` +
            "The ingest endpoint may be slow or unreachable.",
        );
      }
      return;
    }
    this.queue.push(event);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        try {
          await this.client.emit(event);
        } catch {
          // Telemetry is best-effort; never surface emit failures to the host.
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    const start = Date.now();
    while (this.queue.length > 0 || this.draining) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 10));
    }
    return true;
  }

  async close(timeoutMs = 5000): Promise<boolean> {
    return this.flush(timeoutMs);
  }
}

// ── ID helpers ──────────────────────────────────────────────────────────────

const hex = (): string => randomUUID().replace(/-/g, "");
const newSessionId = (): string => `ses_${hex().slice(0, 12)}`;
const newTraceId = (): string => `trc_${hex().slice(0, 16)}`;

function stringify(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (typeof value === "object" && value !== null)
  ) {
    return value;
  }
  return String(value);
}

function errorFields(error: unknown): { message: string; errorType: string } {
  if (error instanceof Error) return { message: error.message, errorType: error.name || "Error" };
  if (error === null || error === undefined) return { message: "", errorType: "Error" };
  return { message: String(error), errorType: "Error" };
}

// ── Run bookkeeping ─────────────────────────────────────────────────────────

interface RunInfo {
  sessionId: string;
  traceId: string;
  source: string;
  name: string;
  kind: string;
  openEventId: string;
  agentRole?: string;
  parentSessionId?: string;
  handoffEventId?: string;
  parentAgentRole?: string;
}

// ── Transport-neutral emission core ─────────────────────────────────────────

/**
 * Framework-agnostic AEP emission machinery: owns the background emitter and the
 * in-flight run table, and exposes the lifecycle→event mapping as semantic ops.
 * Runs are addressed by an opaque string `key` chosen by the caller (here, a
 * LangChain `runId`). Mirrors the Python `_EmissionCore`.
 */
export class EmissionCore {
  private readonly emitter: Emitter;
  private readonly runs = new Map<string, RunInfo>();
  evicted = 0;

  constructor(
    client: { emit(e: AEPEvent): Promise<unknown> },
    private readonly maxRuns = DEFAULT_MAX_RUNS,
  ) {
    this.emitter = new Emitter(client);
  }

  /** Exposed for tests + run-cap assertions. */
  get runTable(): ReadonlyMap<string, RunInfo> {
    return this.runs;
  }

  flush(timeoutMs = 5000): Promise<boolean> {
    return this.emitter.flush(timeoutMs);
  }

  close(timeoutMs = 5000): Promise<boolean> {
    return this.emitter.close(timeoutMs);
  }

  has(key: string): boolean {
    return this.runs.has(key);
  }

  private emit(event: Record<string, unknown>): string | undefined {
    let built: AEPEvent;
    try {
      const { source, type, session_id, trace_id, payload, ...rest } = event as {
        source: string;
        type: string;
        session_id: string;
        trace_id: string;
        payload: Record<string, unknown>;
        [k: string]: unknown;
      };
      built = createEvent(source, type, session_id, trace_id, payload, {
        agentRole: rest.agent_role as string | undefined,
        parentSessionId: rest.parent_session_id as string | undefined,
        subject: rest.subject as string | undefined,
        causationId: rest.causation_id as string | undefined,
      });
    } catch (e) {
      console.warn(`AEP: failed to build ${String(event.type)} event: ${(e as Error).message}`);
      return undefined;
    }
    this.emitter.submit(built);
    return built.id;
  }

  private put(key: string, info: RunInfo): void {
    this.runs.set(key, info);
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
      this.evicted += 1;
      if (this.evicted === 1 || this.evicted % 100 === 0) {
        console.warn(
          `AEP: tracked-run cap (${this.maxRuns}) exceeded — evicted ${this.evicted} stale ` +
            "run(s); some end events may be unmatched.",
        );
      }
    }
  }

  // -- agent/task runs ------------------------------------------------------

  openAgentRun(
    key: string,
    opts: { name: string; framework: string; kind: string; parentKey?: string | null },
  ): string | undefined {
    const parent = opts.parentKey != null ? this.runs.get(opts.parentKey) : undefined;
    const source = `agent://${opts.name}`;

    if (!parent) {
      const sessionId = newSessionId();
      const traceId = newTraceId();
      const openId = this.emit({
        source,
        type: "task.created",
        session_id: sessionId,
        trace_id: traceId,
        agent_role: "orchestrator",
        subject: opts.name,
        payload: { framework: opts.framework, node: opts.name, kind: opts.kind },
      });
      this.put(key, {
        sessionId,
        traceId,
        source,
        name: opts.name,
        kind: opts.kind,
        openEventId: openId ?? "",
        agentRole: "orchestrator",
      });
      return openId;
    }

    // Sub-agent: hand off from the parent, then open the sub-agent task.
    const sessionId = newSessionId();
    const traceId = parent.traceId;
    const handoffId = this.emit({
      source: parent.source,
      type: "handoff.started",
      session_id: parent.sessionId,
      trace_id: traceId,
      agent_role: parent.agentRole,
      subject: opts.name,
      causation_id: parent.openEventId || undefined,
      payload: { from_agent: parent.name, to_agent: opts.name },
    });
    const openId = this.emit({
      source,
      type: "task.created",
      session_id: sessionId,
      trace_id: traceId,
      agent_role: "subagent",
      parent_session_id: parent.sessionId,
      subject: opts.name,
      causation_id: handoffId || parent.openEventId || undefined,
      payload: { framework: opts.framework, node: opts.name, kind: opts.kind },
    });
    this.put(key, {
      sessionId,
      traceId,
      source,
      name: opts.name,
      kind: opts.kind,
      openEventId: openId ?? "",
      agentRole: "subagent",
      parentSessionId: parent.sessionId,
      handoffEventId: handoffId,
      parentAgentRole: parent.agentRole,
    });
    return openId;
  }

  closeAgentRun(key: string, opts: { status: "completed" | "failed"; error?: unknown }): void {
    const info = this.runs.get(key);
    if (!info) return;
    this.runs.delete(key);
    if (opts.status === "failed") {
      const { message, errorType } = errorFields(opts.error);
      this.emit({
        source: info.source,
        type: "task.failed",
        session_id: info.sessionId,
        trace_id: info.traceId,
        agent_role: info.agentRole,
        parent_session_id: info.parentSessionId,
        subject: info.name,
        causation_id: info.openEventId || undefined,
        payload: { node: info.name, status: "failed", error: message, error_type: errorType },
      });
    } else {
      this.emit({
        source: info.source,
        type: "task.completed",
        session_id: info.sessionId,
        trace_id: info.traceId,
        agent_role: info.agentRole,
        parent_session_id: info.parentSessionId,
        subject: info.name,
        causation_id: info.openEventId || undefined,
        payload: { node: info.name, status: "completed" },
      });
    }
    // Sub-agent runs carry a handoff to close on the parent session.
    if (info.handoffEventId) {
      this.emit({
        source: info.source,
        type: "handoff.completed",
        session_id: info.parentSessionId ?? info.sessionId,
        trace_id: info.traceId,
        agent_role: info.parentAgentRole,
        subject: info.name,
        causation_id: info.handoffEventId,
        payload: { from_agent: info.name, status: opts.status },
      });
    }
  }

  // -- tool runs ------------------------------------------------------------

  openToolRun(
    key: string,
    opts: { name: string; arguments: unknown; parentKey?: string | null },
  ): string | undefined {
    const parent = opts.parentKey != null ? this.runs.get(opts.parentKey) : undefined;
    const sessionId = parent ? parent.sessionId : newSessionId();
    const traceId = parent ? parent.traceId : newTraceId();
    const source = parent ? parent.source : `agent://${opts.name}`;
    const agentRole = parent ? parent.agentRole : "standalone";
    const parentSessionId = parent ? parent.parentSessionId : undefined;
    const causation = parent ? parent.openEventId || undefined : undefined;

    const openId = this.emit({
      source,
      type: "tool.called",
      session_id: sessionId,
      trace_id: traceId,
      agent_role: agentRole,
      parent_session_id: parentSessionId,
      subject: opts.name,
      causation_id: causation,
      payload: { tool_name: opts.name, arguments: opts.arguments },
    });
    this.put(key, {
      sessionId,
      traceId,
      source,
      name: opts.name,
      kind: "tool",
      openEventId: openId ?? "",
      agentRole,
      parentSessionId,
    });
    return openId;
  }

  closeToolRun(key: string, opts: { output: unknown }): void {
    const info = this.runs.get(key);
    if (!info) return;
    this.runs.delete(key);
    this.emit({
      source: info.source,
      type: "tool.result",
      session_id: info.sessionId,
      trace_id: info.traceId,
      agent_role: info.agentRole,
      parent_session_id: info.parentSessionId,
      subject: info.name,
      causation_id: info.openEventId || undefined,
      payload: { tool_name: info.name, output: stringify(opts.output) },
    });
  }

  failToolRun(key: string, opts: { error: unknown }): void {
    const info = this.runs.get(key);
    if (!info) return;
    this.runs.delete(key);
    const { message, errorType } = errorFields(opts.error);
    this.emit({
      source: info.source,
      type: "error.raised",
      session_id: info.sessionId,
      trace_id: info.traceId,
      agent_role: info.agentRole,
      parent_session_id: info.parentSessionId,
      subject: info.name,
      causation_id: info.openEventId || undefined,
      payload: { tool_name: info.name, error: message, error_type: errorType },
    });
  }
}

// ── LangGraph mapper (framework-agnostic; unit-testable without LangChain) ───

export interface ChainStartInfo {
  runId: string;
  parentRunId?: string | null;
  node?: string | null;
  name?: string | null;
  tags?: string[] | null;
}

export interface ToolStartInfo {
  runId: string;
  parentRunId?: string | null;
  name?: string | null;
  input?: unknown;
  inputs?: unknown;
}

function coerceToolArgs(input: unknown, inputs: unknown): Record<string, unknown> {
  if (inputs && typeof inputs === "object") return inputs as Record<string, unknown>;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { input };
  }
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return { input: stringify(input) };
}

/**
 * Translates normalized LangGraph callback info into {@link EmissionCore} calls.
 * Models exactly two chain kinds — the graph root (orchestrator) and a LangGraph
 * node with a tracked parent (sub-agent) — ignoring intermediate runnables and
 * framework-internal hidden chains. Mirrors the Python `AEPCallbackHandler`.
 */
export class LangGraphMapper {
  constructor(private readonly core: EmissionCore) {}

  onChainStart(info: ChainStartInfo): void {
    if (info.tags?.includes("langsmith:hidden")) return; // skip __start__/__end__ etc.

    let isRoot = info.parentRunId == null;
    if (!isRoot && info.node == null) return; // ignore intermediate runnables
    let parentKey: string | null = isRoot ? null : String(info.parentRunId);
    if (parentKey != null && !this.core.has(parentKey)) {
      // Node whose parent we didn't track (unexpected) — treat as root.
      isRoot = true;
      parentKey = null;
    }
    const name = info.node || info.name || "graph";
    this.core.openAgentRun(String(info.runId), {
      name,
      framework: "langgraph",
      kind: isRoot ? "graph" : "node",
      parentKey,
    });
  }

  onChainEnd(runId: string): void {
    this.core.closeAgentRun(String(runId), { status: "completed" });
  }

  onChainError(runId: string, error: unknown): void {
    this.core.closeAgentRun(String(runId), { status: "failed", error });
  }

  onToolStart(info: ToolStartInfo): void {
    this.core.openToolRun(String(info.runId), {
      name: info.name || "tool",
      arguments: coerceToolArgs(info.input, info.inputs),
      parentKey: info.parentRunId != null ? String(info.parentRunId) : null,
    });
  }

  onToolEnd(runId: string, output: unknown): void {
    this.core.closeToolRun(String(runId), { output });
  }

  onToolError(runId: string, error: unknown): void {
    this.core.failToolRun(String(runId), { error });
  }
}

// ── LangChain BaseCallbackHandler adapter (built lazily) ─────────────────────

/**
 * Build a LangChain `BaseCallbackHandler` that drives a {@link LangGraphMapper}.
 * `BaseCallbackHandlerClass` is the framework class (imported by the instrumentor
 * only when LangChain is installed), so this module never hard-depends on it.
 */
export function createLangChainHandler(
  BaseCallbackHandlerClass: new (...args: unknown[]) => Record<string, unknown>,
  mapper: LangGraphMapper,
): Record<string, unknown> {
  class AEPLangChainHandler extends BaseCallbackHandlerClass {
    name = "AEPLangChainHandler";
    // Never raise out of a callback — partial telemetry beats a crashed host run.
    raiseError = false;

    handleChainStart(
      _chain: unknown,
      _inputs: unknown,
      runId: string,
      parentRunId?: string,
      tags?: string[],
      metadata?: Record<string, unknown>,
      _runType?: unknown,
      runName?: string,
    ): void {
      try {
        mapper.onChainStart({
          runId,
          parentRunId,
          node: (metadata?.langgraph_node as string | undefined) ?? null,
          name: runName ?? null,
          tags: tags ?? null,
        });
      } catch (e) {
        console.warn(`AEP: LangChain handleChainStart error: ${(e as Error).message}`);
      }
    }

    handleChainEnd(_outputs: unknown, runId: string): void {
      try {
        mapper.onChainEnd(runId);
      } catch (e) {
        console.warn(`AEP: LangChain handleChainEnd error: ${(e as Error).message}`);
      }
    }

    handleChainError(err: unknown, runId: string): void {
      try {
        mapper.onChainError(runId, err);
      } catch (e) {
        console.warn(`AEP: LangChain handleChainError error: ${(e as Error).message}`);
      }
    }

    handleToolStart(
      tool: { name?: string } | undefined,
      input: unknown,
      runId: string,
      parentRunId?: string,
      _tags?: string[],
      _metadata?: Record<string, unknown>,
      runName?: string,
    ): void {
      try {
        mapper.onToolStart({
          runId,
          parentRunId,
          name: runName ?? tool?.name ?? null,
          input,
        });
      } catch (e) {
        console.warn(`AEP: LangChain handleToolStart error: ${(e as Error).message}`);
      }
    }

    handleToolEnd(output: unknown, runId: string): void {
      try {
        mapper.onToolEnd(runId, output);
      } catch (e) {
        console.warn(`AEP: LangChain handleToolEnd error: ${(e as Error).message}`);
      }
    }

    handleToolError(err: unknown, runId: string): void {
      try {
        mapper.onToolError(runId, err);
      } catch (e) {
        console.warn(`AEP: LangChain handleToolError error: ${(e as Error).message}`);
      }
    }
  }

  return new AEPLangChainHandler();
}

// ── Instrumentor + public API ───────────────────────────────────────────────

type CompiledGraphCtor = { prototype: Record<string, unknown> };

interface InstrumentState {
  core: EmissionCore;
  compiled: CompiledGraphCtor;
  handler: Record<string, unknown>;
  originals: Map<string, (...args: unknown[]) => unknown>;
  ownsClient: boolean;
  client: AEPClient;
}

let _state: InstrumentState | null = null;

function injectHandler(config: unknown, handler: Record<string, unknown>): Record<string, unknown> {
  const cfg: Record<string, unknown> =
    config && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  const callbacks = cfg.callbacks;
  if (callbacks == null) {
    cfg.callbacks = [handler];
  } else if (Array.isArray(callbacks)) {
    if (!callbacks.includes(handler)) cfg.callbacks = [...callbacks, handler];
  }
  // A CallbackManager (non-array) is left untouched — the array path covers the
  // common case (config.callbacks as a handler list).
  return cfg;
}

export interface InstrumentOptions {
  serverUrl?: string;
  apiKey?: string;
  client?: AEPClient;
}

/**
 * Enable AEP auto-instrumentation for LangChain.js / LangGraph. Patches
 * `CompiledStateGraph.invoke` / `.stream` to inject an AEP callback handler, so
 * an unmodified `graph.invoke(...)` emits a full AEP DAG. Returns `true` if
 * instrumentation was enabled, `false` (with a warning) if LangGraph is not
 * installed — never throws.
 */
export async function instrument(options: InstrumentOptions = {}): Promise<boolean> {
  if (_state) return true; // idempotent

  let CompiledStateGraph: CompiledGraphCtor;
  let BaseCallbackHandlerClass: new (...args: unknown[]) => Record<string, unknown>;
  try {
    ({ CompiledStateGraph } = (await import("@langchain/langgraph")) as unknown as {
      CompiledStateGraph: CompiledGraphCtor;
    });
    ({ BaseCallbackHandler: BaseCallbackHandlerClass } =
      (await import("@langchain/core/callbacks/base")) as unknown as {
        BaseCallbackHandler: new (...args: unknown[]) => Record<string, unknown>;
      });
  } catch {
    console.warn(
      "AEP: LangGraph (@langchain/langgraph + @langchain/core) is not importable; " +
        "instrument() is a no-op. Install it to enable Node auto-instrumentation.",
    );
    return false;
  }

  const client =
    options.client ?? new AEPClient({ serverUrl: options.serverUrl, apiKey: options.apiKey });
  const core = new EmissionCore(client);
  const handler = createLangChainHandler(BaseCallbackHandlerClass, new LangGraphMapper(core));

  const originals = new Map<string, (...args: unknown[]) => unknown>();
  for (const method of ["invoke", "stream"]) {
    const original = CompiledStateGraph.prototype[method] as
      | ((...args: unknown[]) => unknown)
      | undefined;
    if (typeof original !== "function") continue;
    originals.set(method, original);
    CompiledStateGraph.prototype[method] = function (
      this: unknown,
      input: unknown,
      config?: unknown,
      ...rest: unknown[]
    ) {
      const active = _state?.handler;
      const cfg = active ? injectHandler(config, active) : config;
      return original.call(this, input, cfg, ...rest);
    };
  }

  if (originals.size === 0) {
    console.warn("AEP: CompiledStateGraph exposes no invoke/stream — instrumentation disabled.");
    await core.close(0);
    return false;
  }

  _state = {
    core,
    compiled: CompiledStateGraph,
    handler,
    originals,
    ownsClient: !options.client,
    client,
  };
  return true;
}

/** Undo instrumentation, flush pending telemetry, and release resources. */
export async function uninstrument(): Promise<void> {
  const state = _state;
  _state = null;
  if (!state) return;
  for (const [method, original] of state.originals) {
    state.compiled.prototype[method] = original;
  }
  await state.core.close(5000);
}

/** Block until queued AEP telemetry has been sent (or `timeout` ms elapses). */
export async function flush(timeoutMs = 5000): Promise<boolean> {
  if (!_state) return true;
  return _state.core.flush(timeoutMs);
}
