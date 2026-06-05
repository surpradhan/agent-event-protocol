# `@surpradhan/aep` — AEP Node.js / TypeScript SDK

The Node.js/TypeScript SDK for the [Agent Event Protocol](../../README.md) (AEP) —
a framework-neutral observability protocol for multi-agent AI systems. Mirrors the
[Python](../python/) and [Go](../go/) SDKs: same event envelope, same canonical
HMAC signing contract, same client surface.

> Ships the SDK core (event factory, validation, HMAC signing, ingest/query
> client) **and** zero-code **LangChain.js / LangGraph** auto-instrumentation via
> `instrument()`.

## Install

```bash
npm install @surpradhan/aep
```

Requires **Node ≥ 20** (native `fetch`, Web Crypto via `node:crypto`). Ships dual
**ESM + CJS** builds with TypeScript types.

## Usage

```ts
import { AEPClient, createEvent, signEvent, validateEvent } from "@surpradhan/aep";
// CommonJS: const { AEPClient, createEvent } = require("@surpradhan/aep");

// Build a spec-compliant v0.2.0 event (auto id + timestamp).
const event = createEvent(
  "agent://researcher",
  "task.created",
  "ses_abc",
  "trc_xyz",
  { goal: "summarize the doc" },
  { agentRole: "orchestrator" },
);

// Optional: validate and/or sign before emitting.
const { valid, errors } = validateEvent(event);
signEvent(event, process.env.AEP_HMAC_SECRET ?? "secret"); // adds event.signature

// Emit to the ingest server (reads AEP_INGEST_URL / AEP_API_KEY from env if omitted).
const client = new AEPClient({ serverUrl: "http://localhost:8787", apiKey: "aep_…" });
await client.emit(event);

// Query the API.
const { sessions } = await client.getSessions({ limit: 50 });
const workflow = await client.getWorkflow("trc_xyz");
```

## API

| Export | Description |
|--------|-------------|
| `createEvent(source, type, sessionId, traceId, payload, options?)` | Build a v0.2.0 envelope; auto `id`/`time`; validates `type` + `agentRole`. |
| `validateEvent(event)` | `{ valid, errors }` against the bundled envelope schema (+ optional `payload.$schema`). `[warn]`-prefixed errors are non-blocking. |
| `signEvent(event, secret)` / `verifySignature(event, secret)` / `canonicalize(event)` | HMAC-SHA256 with the cross-language canonical form. |
| `AEPClient` | Async `fetch`-based client: `emit`, `emitBatch`, `getSessions`, `getSessionEvents`, `getSessionTree`, `getSessionExport`, `getWorkflow`, `getMetrics`, `health`, `ready`. |
| `EventType`, `AgentRole`, `CORE_EVENT_TYPES` | Protocol enums/constants. |
| `AEPError` + `AEPValidationError` / `AEPAuthError` / `AEPRateLimitError` / `AEPNotFoundError` / `AEPConnectionError` / `AEPServerError` | Error hierarchy. |

### Cross-language signing

The canonical form is **identical** across the Node, Python, and Go SDKs and the
server: the envelope with `signature` removed and top-level keys sorted, via
`JSON.stringify(copy, sortedKeys)`. A signature produced by this SDK verifies
under the Python/Go verifiers and vice versa — locked by a parity test
(`tests/unit/signature.test.ts`) against a Python-produced fixture.

## Auto-instrumentation (LangChain.js / LangGraph)

Emit the full multi-agent DAG from an unmodified [LangGraph](https://langchain-ai.github.io/langgraphjs/)
graph — one `await instrument()` call wires AEP events to the run, every node, each
tool call, and the handoffs between them. LangChain is an **optional peer** (you
install it; the SDK imports it dynamically only when instrumenting), so the core
SDK has no LangChain dependency.

```bash
npm install @surpradhan/aep @langchain/langgraph @langchain/core
```

```ts
import { instrument, flush, uninstrument } from "@surpradhan/aep";

await instrument(); // reads AEP_INGEST_URL / AEP_API_KEY (or pass them in)

// ... build and run your StateGraph exactly as usual ...
const graph = workflow.compile();
await graph.invoke({ topic: "AI agent observability" });

await flush(); // emission is buffered; drain before a short-lived process exits
// await uninstrument(); // optional: restore CompiledStateGraph + release the client
```

| LangGraph callback | AEP event(s) | Role |
|--------------------|--------------|------|
| graph run (root) | `task.created` → `task.completed`/`failed` | orchestrator |
| node run (`langgraph_node`) | `task.created` → `task.completed`/`failed` | subagent |
| graph → node | `handoff.started` → `handoff.completed` | orchestrator |
| tool call | `tool.called` → `tool.result` | (node) |
| tool / node error | `error.raised` / `task.failed` | (node) |

Notes:
- **Tested against `@langchain/langgraph` 1.x + `@langchain/core` 1.x.** Implemented
  as a `BaseCallbackHandler` injected into `CompiledStateGraph.invoke`/`.stream`
  (the supported callbacks extension point), mirroring the Python LangGraph
  instrumentor. If LangGraph isn't installed, `instrument()` warns and is a no-op.
- **The graph run is the orchestrator**; each LangGraph node is a sub-agent reached
  via a handoff. Intermediate runnables and framework-internal hidden chains
  (e.g. `__start__`, tagged `langsmith:hidden`) are skipped to keep the DAG clean.
- **Emission is non-blocking** — events are sent on a background drain loop so they
  add no latency to your graph. Call `await flush()` before a short-lived process
  exits. The buffer is bounded and drops with a warning under sustained overload.
- Callbacks are pure observers — they never throw into the host run.
- See `demos/langgraph-multiagent.mjs` for a runnable offline example (no LLM key).

## Development

```bash
npm install
npm run build        # dual ESM + CJS + .d.ts via tsup
npm run typecheck    # tsc --noEmit
npm test             # vitest (unit + integration)
npm run format       # prettier
```

- **Unit tests** (`tests/unit/`) — no server, no framework needed.
- **Integration tests** (`tests/integration/`) — auto-skip unless an AEP server is
  reachable; set `AEP_INGEST_URL` / `AEP_API_KEY` to run them.

Tested against Node 20.x and 22.x.
