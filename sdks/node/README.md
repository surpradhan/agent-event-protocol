# `@surpradhan/aep` — AEP Node.js / TypeScript SDK

The Node.js/TypeScript SDK for the [Agent Event Protocol](../../README.md) (AEP) —
a framework-neutral observability protocol for multi-agent AI systems. Mirrors the
[Python](../python/) and [Go](../go/) SDKs: same event envelope, same canonical
HMAC signing contract, same client surface.

> **Phase 12g, PR1 — SDK core.** This package currently ships the core: event
> factory, validation, HMAC signing, and the ingest/query client. Zero-code
> framework auto-instrumentation (`instrument()` for LangChain.js) lands in PR2.

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
