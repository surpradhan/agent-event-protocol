# `@surpradhan/aep` — AEP Node.js / TypeScript SDK

The Node.js/TypeScript SDK for the [Agent Event Protocol](https://github.com/surpradhan/agent-event-protocol#readme) (AEP) —
a framework-neutral observability protocol for multi-agent AI systems. Mirrors the
[Python](https://github.com/surpradhan/agent-event-protocol/tree/main/sdks/python) and [Go](https://github.com/surpradhan/agent-event-protocol/tree/main/sdks/go) SDKs: same event envelope, same canonical
HMAC signing contract, same client surface.

> Ships the SDK core (event factory, validation, HMAC signing, ingest/query
> client) **and** zero-code **LangChain.js / LangGraph** auto-instrumentation via
> `instrument()`.

> **📍 Project direction (2026-06):** AEP is converging on OpenTelemetry rather than continuing as a standalone protocol. This SDK is **frozen / maintenance mode** — it remains published and installable, but active development has moved toward contributions to the OTel GenAI semantic conventions.

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
| `signEvent(event, secret, { canon })` / `verifySignature(event, secret)` / `canonicalize(event)` / `canonicalizeV2(event)` | HMAC-SHA256 signing/verification. `canon` selects the canonical form: `"v2"` (default, deep) or `"v1"` (legacy, envelope-only). |
| `verifyAuditBundle(bundle, secret)` | Offline verification of a tamper-evident audit bundle (see *Offline audit-bundle verification* below). |
| `AEPClient` | Async `fetch`-based client: `emit`, `emitBatch`, `getSessions`, `getSessionEvents`, `getSessionTree`, `getSessionExport`, `getWorkflow`, `getMetrics`, `health`, `ready`. |
| `EventType`, `AgentRole`, `CORE_EVENT_TYPES` | Protocol enums/constants. |
| `AEPError` + `AEPValidationError` / `AEPAuthError` / `AEPRateLimitError` / `AEPNotFoundError` / `AEPConnectionError` / `AEPServerError` | Error hierarchy. |

### Cross-language signing

The **v1** canonical form is **identical** across the Node, Python, and Go SDKs
and the server: the envelope with `signature` removed and top-level keys sorted,
via `JSON.stringify(copy, sortedKeys)`. A v1 signature produced by this SDK
verifies under the Python/Go verifiers and vice versa — locked by a parity test
(`tests/unit/signature.test.ts`) against a Python-produced fixture.

**v2 (deep) canonicalization is now the DEFAULT — issue #59.** v1's array-replacer
form drops nested object contents (`payload` → `{}`), so a v1 signature covers the
envelope but not the payload. `signEvent(event, secret)` now uses a deep,
recursively key-sorted canonical form (`canonicalizeV2`) that covers nested
payloads and adds a `signature.canon: "v2"` marker, so payload tamper-evidence is
on without opt-in. It is byte-identical to the server's v2 verifier (locked here
by a server-derived known-answer vector), and the Node, Python, and Go SDKs all
default to the same v2 bytes. `verifySignature` is version-aware (honours `canon`;
absent → accepts either form).

**v1 is now legacy** but still supported: pass `{ canon: "v1" }` to sign the
envelope-only form. It remains byte-identical across all SDKs and the server
(locked by a Python-produced parity fixture in `tests/unit/signature.test.ts`).

> **Compatibility:** the v2 default requires a v2-aware server (one that includes
> server PR #60+). The current AEP server **requires v2 and rejects legacy v1**
> with `401` — the v1 retirement is complete ([issue #65], the successor to the
> [issue #59] unification). `{ canon: "v1" }` is retained only for talking to an
> **older self-hosted server** that predates `signature.canon` support; a current
> server rejects it.

[issue #59]: https://github.com/surpradhan/agent-event-protocol/issues/59
[issue #65]: https://github.com/surpradhan/agent-event-protocol/issues/65

### Offline audit-bundle verification

Verify a tamper-evident audit bundle (from `GET /sessions/:id/audit-bundle`,
`GET /workflows/:traceId/audit-bundle`, or `aep audit export`) entirely offline —
no server, no database — with just the bundle JSON and the audit signing secret:

```ts
import { readFileSync } from "node:fs";
import { verifyAuditBundle } from "@surpradhan/aep";

const bundle = JSON.parse(readFileSync("bundle.json", "utf8"));
const result = verifyAuditBundle(bundle, "my-audit-signing-secret");
// { valid, content_digest_match, manifest_signature_valid, errors, per_event }

if (!result.valid) throw new Error(`bundle failed verification: ${result.errors.join("; ")}`);
```

It recomputes the content digest over the bundle's events and the HMAC signature
over its manifest — both **byte-identical to the server** (and the Python/Go SDKs;
locked by a shared known-answer fixture). Any post-hoc change — a mutated payload
field, reordered/added/dropped events, an edited manifest, or the wrong secret —
makes `valid` false. (Building/signing bundles stays server-side, where the
signing secret lives.)

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

## Publishing / Releases

Releases are cut from `main` by pushing a `node-sdk-vX.Y.Z` tag — the
[`Release Node SDK`](https://github.com/surpradhan/agent-event-protocol/blob/main/.github/workflows/release-node-sdk.yml) workflow
then verifies the tag, builds and tests, and — only after a required-reviewer
approval — runs `npm publish --provenance --access public` for this package.
To cut a release:

1. Open a PR that bumps `sdks/node/package.json` `"version"` to the new
   `X.Y.Z` and adds a CHANGELOG entry. Squash-merge once CI is green.
2. From the merged `main`, tag the **squash commit on `main`** (not the
   pre-squash branch head — that commit never lands on `main` and the ancestry
   check in step 3 would reject it) and push the tag:

   ```bash
   git tag node-sdk-v0.3.0
   git push origin node-sdk-v0.3.0
   ```

3. The `verify` job runs immediately: it confirms the tagged commit is an
   ancestor of `origin/main` (so the release can only be cut from reviewed,
   merged code), then runs `npm ci` → `npm run build` → `npm test`. A tag that
   points at an unreviewed or off-`main` commit fails here and never reaches the
   publish step.
4. Once `verify` is green, the workflow requests a deployment to the
   **`npm-publish`** environment, which has **required reviewers**. A maintainer
   approves it in the Actions UI, and only then does the `publish` job run
   `npm publish` with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
   enabled, attesting that the tarball was built from this repo at that tag.

Why both gates: `main` is PR-protected, but tags are not — anyone with write
access could otherwise tag any commit and trigger a real publish. The ancestry
check rejects off-`main` tags cheaply, and the required-reviewer environment
makes the publish itself need a human approval, enforced by GitHub Actions
independent of who pushed the tag. Provenance attests *what* was built but does
not gate *which commit* gets released, which is why these two checks are added
on top of it.

The published tarball matches `npm pack --dry-run` locally — only `dist/`,
`README.md`, `LICENSE`, and `package.json` ship; `src/`, `tests/`, `demos/`,
and tooling configs are excluded by the `"files"` allowlist in `package.json`.

**One-time maintainer setup (GitHub UI — not code):**

1. Generate an npm automation token with publish access for `@surpradhan/aep`
   (npm → Access Tokens → Automation).
2. Create a deployment environment named **`npm-publish`**
   (Settings → Environments → New environment) and add the release owners under
   **Required reviewers**.
3. Add the npm token as an **environment** secret named `NPM_TOKEN` on the
   `npm-publish` environment — *not* as a repo-wide Actions secret — so it is
   only ever exposed to the approval-gated `publish` job.
