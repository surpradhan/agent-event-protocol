# Changelog

All notable changes to AEP are documented here.

---

## Phase 12d — Framework Auto-Instrumentation (AutoGen), 2026-06-05

No breaking changes to the event envelope schema or existing API contracts, and
**no change to the LangGraph (12b) or CrewAI (12c) event output** (both are
regression-locked by their unchanged test suites). This is purely additive: a
third framework registered alongside the existing two.

**New: AutoGen AgentChat auto-instrumentation** (`sdks/python/aep/instrument.py`)

`import aep; aep.instrument()` now also instruments **AutoGen AgentChat** — an
unmodified `team.run()` / `team.run_stream()` emits a full AEP causation DAG with
no other code changes. Tested against `autogen-agentchat>=0.4` (developed on 0.7.x).
AutoGen is the third major framework, satisfying the PRD's ≥3-framework metric
(LangGraph, CrewAI, AutoGen).

- **Stream tracer, not a callback/bus** — AutoGen AgentChat has neither a callback
  registry nor an event bus; a team surfaces its activity only as the async stream
  of messages/events yielded by `BaseGroupChat.run_stream`. The instrumentor wraps
  that method (which `BaseGroupChat.run` consumes internally, so one tap covers
  both) with an `AEPAutoGenTracer` that re-yields every item unchanged while
  translating it into `_EmissionCore` calls — mirroring 12b/12c's choice of the
  supported observation surface over monkey-patching internals. `uninstrument()`
  restores the original method.
- **Event mapping (settled against a real trace)** — the **team** is the
  orchestrator `task.*` (new `trace_id` + root `session_id`); each distinct message
  `source` (an agent name) is opened lazily as a **sub-agent** `task.*` with
  `parent_session_id` → team, reached via `handoff.started`/`handoff.completed` on
  the team session; a `ToolCallRequestEvent` → `tool.called` and the matching
  `ToolCallExecutionEvent` → `tool.result` (or `error.raised` when `is_error`).
  One `trace_id` spans the run; every `causation_id` resolves to a real emitted
  event. A run-level exception closes the orchestrator `task.failed` and
  propagates unchanged; observed sub-agents close `task.completed`.
- **Exact tool pairing by `call_id`** — AutoGen tags each `FunctionExecutionResult`
  with the `call_id` of its `FunctionCall`, so tool starts/closes are matched
  exactly (even for parallel tool calls returned out of order) — no LIFO heuristics
  needed. In-team agents run through the AgentChat runtime (not
  `BaseChatAgent.run_stream`), so there is no double-counting.
- **Concurrency-safe** — each `run_stream` invocation gets a fresh run context
  whose run-table keys are namespaced by a unique token, so concurrent team runs
  never collide on the shared (bounded) core run table.
- **Graceful, host-safe** — no-op + warning when AutoGen is absent or its team base
  class has drifted (availability is claimed only when
  `BaseGroupChat` imports — so 0.2-era `pyautogen` degrades cleanly); per-item
  mapping errors are swallowed so a telemetry bug never breaks the host stream;
  emit failures swallowed; run exceptions still propagate; idempotent
  re-instrumentation. A `MIN_AUTOGEN_VERSION` floor (tested against 0.7.x) and the
  installed version are surfaced in warnings.

**Demo** — `demos/autogen_multiagent.py`: a 2-agent round-robin team
(researcher → writer) with a `web_search` tool. Runs **offline with no LLM API
key** via `autogen-ext`'s `ReplayChatCompletionClient` (set `AEP_DEMO_OPENAI=1`
for a real model), emitting a clean DAG — orchestrator + 2 sub-agent sessions +
a tool pair on one trace — then prints the server-reconstructed session tree.

**Tests** — 19 unit tests drive the `AEPAutoGenTracer` mapping with fabricated
AutoGen-shaped events and a recorder client (runnable without AutoGen installed) —
including parallel-tool `call_id` matching, orphan tool close, run-failure,
run-cap bound, transparent passthrough, and stream-mapping-error host-safety
cases — plus a real class-patch/restore test. Two integration tests run a real
`team.run()` against a live server (one verifies the team/agent/handoff DAG; one
drives a real tool call via the offline replay client and asserts a linked
`tool.called` → `tool.result` pair) and auto-skip when unreachable. All Phase 12b
and 12c tests remain green and unchanged.

**CI** — `python-sdk-test` now installs `sdks/python[dev,langgraph,crewai,autogen,otel]`.

**Optional dependencies** — added `[autogen]` extra to `pyproject.toml`:
`pip install -e "sdks/python[autogen]"`.

---

## Phase 12c — Framework Auto-Instrumentation (CrewAI), 2026-06-05

No breaking changes to the event envelope schema or existing API contracts, and
**no change to Phase 12b's LangGraph event output** (the refactor below is
regression-locked by the unchanged Phase 12b test suite).

**New: CrewAI auto-instrumentation** (`sdks/python/aep/instrument.py`)

`import aep; aep.instrument()` now also instruments **CrewAI** — an unmodified
`Crew.kickoff()` emits a full AEP causation DAG with no other code changes.
Tested against `crewai>=1.0` (developed on 1.14).

- **Transport-neutral emission core** — the framework-agnostic machinery (the
  background `_Emitter` queue, run bookkeeping, ID helpers, and the
  lifecycle→event mapping: run-open → `task.created`/`tool.called`, run-close →
  `task.completed`/`tool.result`/`task.failed`, parent→child →
  `handoff.started`/`handoff.completed`, plus causation/trace/session threading)
  now lives in a transport-neutral `_EmissionCore`. The LangChain handler and the
  new CrewAI listener are thin adapters over it. The LangGraph path is unchanged.
- **Event-bus listener, not internals-wrapping** — CrewAI does **not** use
  LangChain callbacks, so the instrumentor subscribes an `AEPCrewListener` to
  CrewAI's own event bus (`crewai.events.crewai_event_bus`), the supported
  extension point — mirroring 12b's choice of LangGraph's `RunnableConfig`
  callbacks over monkey-patching. `uninstrument()` unsubscribes.
- **Event mapping** — `Crew.kickoff()` → orchestrator `task.*` (new `trace_id` +
  root `session_id`); each task (named for its assigned agent) → sub-agent
  `task.*` with `parent_session_id` → crew, reached via `handoff.started`/
  `handoff.completed` on the crew session; tool usage → `tool.called`/
  `tool.result`, `error.raised` on failure. One `trace_id` spans the kickoff;
  every `causation_id` resolves to a real emitted event.
- **Agent-vs-Task nesting (settled against a real trace)** — CrewAI fires
  `TaskStarted` *then* `AgentExecutionStarted` inside it, so a Task wraps its
  Agent execution. The **Task** is therefore the sub-agent session and the agent
  is folded into it; an agent that runs outside any task (e.g. a hierarchical
  manager) opens its own agent-keyed sub-agent session as a fallback.
- **Relaxed LangChain gate** — `instrument()` only requires `langchain-core` when
  a LangChain-family framework is actually instrumented. With only CrewAI
  installed, `aep.instrument()` works without `langchain-core` present.
- **Graceful, host-safe** — no-op + warning when CrewAI is absent or its event API
  has drifted (the instrumentor only claims availability when `crewai.events` is
  importable); emit failures swallowed; crew exceptions still propagate;
  idempotent re-instrumentation. A `MIN_CREWAI_VERSION` floor (tested against
  1.14.x) and the installed CrewAI version are surfaced in warnings.
- **Robust tool pairing** — each tool invocation is tracked under a unique key, so
  repeated or concurrent tools in the same scope never collide; a `tool.result`/
  `error.raised` matches the most-recent open tool in its scope and falls back to
  global LIFO if the close event resolved a different scope than the open (e.g.
  CrewAI omitted `from_task` on the finished event) — so a tool pair always closes
  instead of leaving a dangling `tool.called`. The open-tool index is bounded
  (oldest evicted + warned) so never-closed tool starts can't grow it unbounded.
  Tool attribution is exact for sequential crews and best-effort under concurrent
  agents.

**Demo** — `demos/crewai_multiagent.py`: a 3-agent sequential research crew
(researcher → analyst → writer) with two tools. Runs **offline with no LLM API
key** via a tiny scripted stub LLM (set `AEP_DEMO_OPENAI=1` for a real model),
emitting a clean DAG — orchestrator + 3 sub-agent sessions + tool pairs on one
trace — then prints the server-reconstructed session tree.

**Tests** — 17 unit tests drive the `AEPCrewListener` mapping with fabricated
CrewAI-shaped events and a mock client (runnable without CrewAI installed) —
including repeated-tool, scope-drift, and orphan-close cases — plus a real-bus
subscribe/unsubscribe test. Two integration tests run a real `Crew.kickoff()`
against a live server (one verifies the crew/task/handoff DAG; one drives a real
tool call via an offline scripted LLM and asserts a linked `tool.called` →
`tool.result` pair) and auto-skip when unreachable. All Phase 12b tests remain
green and unchanged.

**CI** — `python-sdk-test` now installs `sdks/python[dev,langgraph,crewai,otel]`.

**Optional dependencies** — added `[crewai]` extra to `pyproject.toml`:
`pip install -e "sdks/python[crewai]"`.

**Future phases** — Phase 12d+ (AutoGen, Anthropic/OpenAI Agents SDK patching;
Node.js for LangChain.js and Vercel AI SDK).

---

## Fix — `/dashboard` & `/openapi.json` static serving under Express 5, 2026-06-04

No breaking changes to the event envelope schema or existing API contracts.

**Server** (`src/server.js`)

- `res.sendFile()` was called with a full absolute path. Under Express 5, `send()`
  applies its dotfiles policy (default `"ignore"`) to the whole resolved path when
  no `root` is given, so a checkout whose path contains a dot-directory (e.g. a
  `.claude/worktrees/...` git worktree) caused both routes to 404. Both now pass a
  `root` option so the trusted prefix is exempt from the dotfiles check and only
  the filename (no dot) is policy-checked.
- Added a `GET /dashboard` → 200 regression test (the existing `/openapi.json`
  test only failed from a dot-directory checkout; CI uses a clean path). (PR #27)

---

## Phase 12b — Framework Auto-Instrumentation (LangGraph), 2026-06-04

No breaking changes to the event envelope schema or existing API contracts.

**New: `aep.instrument()` Python function** (`sdks/python/aep/instrument.py`)

One line — `import aep; aep.instrument()` — makes LangGraph workflows emit a full
AEP event DAG with no other code changes. Tested against `langgraph>=0.1`
(developed on 1.x).

- **Callback-based, not method-wrapping** — instrumentation is a LangChain
  `BaseCallbackHandler` injected into every `CompiledStateGraph.invoke` / `ainvoke`
  / `stream` / `astream` via the call's `RunnableConfig` (inherited by all child
  runs). This is LangGraph's supported extension point and survives node fan-out.
- **Rich event mapping** — graph run → orchestrator `task.created`/`task.completed`/
  `task.failed`; each node → sub-agent `task.*`; orchestrator→node transitions →
  `handoff.started`/`handoff.completed`; tool calls (`on_tool_*`) →
  `tool.called`/`tool.result`, with `error.raised` on tool failure.
- **Full causation DAG** — one `trace_id` per graph run; each node gets its own
  `session_id` with `parent_session_id` pointing at the orchestrator; every event's
  `causation_id` references the event that triggered it (verified: zero dangling
  references in the demo run).
- **Pluggable framework registry** — `FrameworkInstrumentor` + `_INSTRUMENTORS`
  registry; adding CrewAI/AutoGen later means registering one class.
- **Graceful, host-safe** — no-op + warning if LangGraph/langchain-core absent or
  if framework internals differ (warns loudly, never falsely reports success);
  emit failures are logged and swallowed; exceptions in the graph still propagate.
  Idempotent (`instrument()` twice won't double-patch); `uninstrument()` restores.
- **Configuration** — `AEP_INGEST_URL`/`AEP_API_KEY` env vars or
  `instrument(server_url=…, api_key=…)`; accepts an injected `client=` for tests.

**Demo** — `demos/langgraph_multiagent.py`: a 10-node LangGraph research workflow
(orchestrator → 3 parallel researchers → synthesize → fact-check + risk-review →
editor → publish). Running it emits 38 events across 10 sessions sharing one
trace, then prints the server-reconstructed session tree.

**Tests** — 20 unit tests: ID/config-injection helpers (dependency-free) plus the
real callback handler driven through the LangGraph callback sequence, asserting
event types, causation links, sub-agent linkage, and host-safety (emit failures
don't propagate). Integration test runs a real graph against a live server and
auto-skips when unreachable (via `tests/integration/conftest.py`).

**CI** — new `python-sdk-test` job (Python 3.10/3.11/3.12): installs
`sdks/python[dev,langgraph]`, lints with ruff, runs the SDK test suite.

**Optional dependencies** — added `[langgraph]` extra to `pyproject.toml`:
`pip install -e "sdks/python[langgraph]"`.

**Future phases** — Phase 12c+ (CrewAI, AutoGen, Anthropic/OpenAI SDK patching;
Node.js for LangChain.js and Vercel AI SDK).

---

## Phase 12a — OpenTelemetry Collector Plugin, 2026-06-04

No breaking changes to the event envelope schema or existing API contracts.

**New: AEP OpenTelemetry Collector exporter** (`otelbridge/` — separate Go module `github.com/surpradhan/aep-otel-bridge`)

Completes the OTEL story from Phase 11 — any OTEL-instrumented system can emit to AEP through a standard Collector pipeline, with no application code changes:

- **Collector exporter** (`exporters/aepexporter/`) — config / factory / exporter built on the opentelemetry-collector v0.96 pattern; batches events and emits via the AEP Go client
- **pdata-native span-to-event mapper** — mirrors the reference classification (`error.raised` > `handoff.completed` > `tool.result` > `task.completed`/`task.failed` > default); `trace_id` → AEP `trace_id` + `session_id` (`ses_<trace_id[:16]>`); parent span ID → `causation_id`; `gen_ai.*` → payload; `service.name` → `agent://` source
- **Build & demo** — `builder-config.yaml` (ocb) to build a Collector including the exporter; `docker-compose.yml` (app → Collector → AEP) with an API-key bootstrap step (`/events` has no dev-mode bypass)
- **CI** — new `otelbridge-test` job; the AEP Go SDK was also repaired and added to CI (it previously did not compile from a clean checkout — jsonschema API, embedded-schema path, BOM, event-type validation, OTEL mapper)

**Tests** — exporter unit tests built on in-memory `ptrace.Traces` (no server required)

**Not yet verified end-to-end:** the ocb Collector build and full `docker-compose` run, and a live-server integration test — see `otelbridge/README.md` "Status".

---

## Phase 11 — OpenTelemetry Bridge (SDK), 2026-06-04

No breaking changes to the event envelope schema or existing API contracts.

**New: `aep.otel` Python module** (`sdks/python/aep/otel/`)

A drop-in OpenTelemetry bridge that emits AEP events from OTEL spans:

- **Span-to-event mapper** (`mapper.py`) — `map_span_to_event()` translates an OTEL `ReadableSpan` to an AEP event. Priority-ordered classification: `error.raised` (error status + "error" in name) > `handoff.completed` > `tool.result` (CLIENT/SERVER + "tool") > `task.completed`/`task.failed` > default
- **Span exporter** (`exporter.py`) — `AEPSpanExporter` implements the OTEL `SpanExporter` interface; works with `SimpleSpanProcessor` and `BatchSpanProcessor`; structured logging; partial-failure handling (SUCCESS if any span exports, FAILURE if all fail)
- **Trace context preservation** — `trace_id` → AEP `trace_id` and `session_id` (`ses_<trace_id[:16]>`, so all spans in a trace share a session); parent span ID → `causation_id`; `Resource.service.name` → `agent://<service>` source (configurable prefix); `gen_ai.*` attributes (OTEL GenAI SIG) → payload
- **Event validation** — generated events are validated against the AEP schema before emission
- **Go mapper** (`sdks/go/aep/otel/mapper.go`) — span-to-event logic for language parity

**Demo** — `demos/otel_bridge.py`: multi-agent orchestrator instrumented with OTEL, exporting to AEP

**Tests** — 38 unit tests (27 mapper + 11 exporter), no server required

**Delivered in Phase 12a:** OTEL Collector exporter plugin; end-to-end Datadog/NewRelic → Collector → AEP demo.

---

## Phase 10 — Kubernetes Operator (2026-06-03)

No breaking changes to the event envelope schema or existing API contracts.

**New: AEP Operator** (`operator/` — separate Go module `github.com/surpradhan/aep-operator`)

Zero-code instrumentation of agent workloads via sidecar injection:

- **`AgentInstrumentation` CRD** (cluster-scoped) — `namespaceSelector`, `podSelector`, `apiKeySecretRef`, `sidecarImage`, `resources`, and `env` overrides
- **Mutating webhook** — opt-in via `aep.dev/inject=true` annotation; injects the AEP sidecar with downward-API env vars, Secret-backed API key, configurable resources, and a hardened `SecurityContext`
- **Controller** — reconciles `AgentInstrumentation` CRs; maintains `status.injectedCount` and `status.conditions` (Ready/Disabled/InjectionFailed)
- **Helm chart** (`operator/helm/aep-operator/`) — cert-manager TLS, configurable `namespaceSelector`, all values documented
- **Tests** — 22 unit (10 controller + 12 webhook) + 4 envtest integration tests

---

## Phase 9 — Go SDK (2026-06-03)

No breaking changes to the event envelope schema or existing API contracts.

**New: `aep-go` Go package** (`sdks/go/`)

A production-ready Go SDK with full parity to JavaScript and Python SDKs:

- **Types & Events** — `EventType` enum, `AgentRole` enum, 12 core event types, `CreateEvent()` factory with optional fields
- **Validation** — JSON Schema validation via `jsonschema/v5`; payload `$schema` resolution with 1-hour TTL caching; graceful handling of invalid/relative URIs (warnings, not errors)
- **Signing** — `SignEvent()` / `VerifySignature()` — HMAC-SHA256 with canonical JSON form (exact parity with JS/Python); `hmac.Equal()` for constant-time verification
- **HTTP clients** — `Client` (sync) and `AsyncClient` (async with goroutines); both support context timeouts, API key auth, all endpoints; explicit HTTP 202/422 handling
- **Error hierarchy** — `AEPError` base type + specific types: `ErrValidation`, `ErrAuth`, `ErrRateLimit`, `ErrNotFound`, `ErrConnection`, `ErrServer`
- **CLI tool** (`cmd/aep-go/`) — `emit`, `session`, `validate`, `health`, `ready` commands with full flag coverage
- **Examples** — `subagent_research.go` — multi-agent orchestrator + 3 parallel sub-agents with causation chains

**Test suite** (`tests/`)

80+ tests:
- 69+ unit tests (event creation, validation, signing, client methods)
- 11 integration tests (auto-skip if server unavailable) covering emit, batch, multi-agent workflows, signatures

**Key improvements**
- Payload schema cache with TTL prevents unbounded memory growth in long-running processes
- Context cancellation detection in `AsyncClient.EmitBatch` prevents resource leaks
- HTTP 422 handler extracts schema validation error messages from response body
- Comprehensive error tests for network failures, invalid URIs, relative URIs

---

## Phase 8 — Python SDK (2026-06-02)

No breaking changes to the event envelope schema or existing API contracts.

**New: `aep` Python package** (`sdks/python/`)

A production-ready Python SDK with full parity to the JavaScript implementation:

- `create_event()` — mirrors `createEvent.js`; auto-generates `id`/`time`, validates type + agent role, omits `None` optional fields
- `validate_event()` — Draft 2020-12 JSON Schema validation via `jsonschema`; payload `$schema` resolution; `[warn]`-prefixed non-blocking warnings
- `sign_event()` / `verify_signature()` — HMAC-SHA256 signing with exact JS canonical form (`JSON.stringify(copy, sortedKeys)` semantics); `hmac.compare_digest` for timing safety
- `AEPClient` — synchronous HTTP client backed by `httpx`; full endpoint coverage; context manager; `ResourceWarning` on unclosed clients
- `AsyncAEPClient` — async HTTP client; `emit_batch` uses `asyncio.gather` (concurrent, not sequential); all requests complete before raising on partial failure
- `AEPServerError` — new exception class for HTTP 5xx with `.status_code` attribute (completes the full `AEPError` hierarchy: `AEPValidationError`, `AEPAuthError`, `AEPRateLimitError`, `AEPNotFoundError`, `AEPConnectionError`, `AEPServerError`)
- Schemas bundled in `aep/schemas/` with `package-data` so the package works after standalone `pip install`
- `py.typed` marker (PEP 561) for mypy/pyright annotation support
- `demos/subagent_research.py` — Python port of the multi-agent research demo (orchestrator + 3 parallel sub-agents)

**Test suite** (`tests/unit/`, `tests/integration/`)

107 unit tests (no server required) using `respx` mocks + `pytest-asyncio`, covering:
- Event creation, validation, HMAC signing/verification, sync and async client behaviour
- All error paths: 400/401/403/404/429/5xx and `ConnectError`
- `emit_batch` partial-failure contract (all requests complete before raise)
- `__repr__` key masking safety for short keys

11 integration tests auto-skip when `AEP_INGEST_URL` is unreachable (moved to `conftest.py` — no import-time HTTP probe on unit-only runs).

**New internal module** (`aep/_http.py`)

`handle_response`, `parse_retry_after`, `_safe_json` extracted from `client.py` so both sync and async clients share the helpers without cross-module private imports.

---

## Phase 7 — Production Hardening (2026-03-24)

No breaking changes to the event envelope schema or existing API contracts.

**Pagination** (`src/db/index.js`, `src/server.js`)

`GET /sessions` and `GET /sessions/:id/events` now accept `?limit` and `?cursor` query params and return `next_cursor` in every response. Cursors are opaque base64url tokens encoding the sort position of the last returned item; an invalid or missing cursor silently falls back to the first page. Page size caps: 500 for sessions, 1000 for events.

**Rate limiting** (`src/middleware/rateLimit.js`)

`POST /events` enforces a per-API-key fixed-window rate limit (default 300 req/min, configurable via `RATE_LIMIT_RPM`). Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers. Exceeding the limit returns HTTP 429 with a `Retry-After` header. Set `RATE_LIMIT_RPM=0` to disable entirely.

**Graceful shutdown** (`src/server.js`)

`SIGTERM` and `SIGINT` handlers stop accepting new connections, drain in-flight requests via `httpServer.close()`, close the SQLite connection, and exit cleanly. A 30-second hard-exit timeout prevents stalled shutdown.

**Docker** (`Dockerfile`, `docker-compose.yml`)

Multi-stage build (deps → runtime) on `node:20-alpine`. Runs as the unprivileged `node` user. Built-in `HEALTHCHECK` polls `GET /health`. `docker-compose.yml` mounts a named volume for the SQLite file and passes all config via environment variables.

**Environment configuration** (`.env.example`)

`.env.example` documents every variable (`PORT`, `DATABASE_PATH`, `LOG_LEVEL`, `LOG_PRETTY`, `ADMIN_TOKEN`, `DASHBOARD_TOKEN`, `RATE_LIMIT_RPM`, `HOST_PORT`) with type, default, and production notes.

**Prometheus metrics** (`src/metrics.js`, `src/server.js`)

`GET /metrics/prometheus` (no auth) exports in Prometheus text format 0.0.4:
- Counters: `aep_events_received_total`, `aep_events_accepted_total`, `aep_events_rejected_total`, `aep_events_duplicates_total`
- Gauges: `aep_sessions_total`, `aep_workflows_total`
- Per-type counter: `aep_events_by_type_total{type="..."}`
- HTTP counters: `aep_http_requests_total{method, route, status}`
- Latency histograms: `aep_http_request_duration_seconds{method, route}` with 11 standard buckets

**Structured logging** (`src/logger.js`, `src/server.js`)

All `console.log` calls replaced with pino. Every log line is newline-delimited JSON with `service`, `level`, and `time` fields. Request logs include `method`, `path`, `status`, and `tenant_id`. Log level controlled by `LOG_LEVEL` (default `info`).

**Health probes** (`src/server.js`)

`GET /health` now executes `SELECT 1` against the database and returns HTTP 503 with `{ ok: false, checks: { db: "error" } }` if unreachable. New `GET /ready` endpoint verifies both DB connectivity and that the `events` table exists (schema migrated); returns 503 until both pass.

---

## Phase 6 — Testing & Developer Experience (2026-03-24)

No breaking changes to the event envelope schema or existing API contracts.

**New: test suite**

82 tests using Node.js's built-in `node:test` runner (no new runtime dependencies):
- `tests/unit/` — 55 tests covering `validator.js`, `createEvent.js`, and `coreEventTypes.js`
- `tests/integration/` — 27 tests covering every HTTP endpoint including auth, deduplication, export formats, session tree, workflow, metrics, admin key lifecycle, and OpenAPI response shape
- `tests/fixtures/` — 19 JSON fixture files (12 valid, one per core event type; 7 invalid covering distinct failure modes)
- `.github/workflows/ci.yml` — GitHub Actions CI running on Node 20 and 22

**New: `aep` CLI** (`src/cli.js`)

Four new commands added alongside the existing `validate` command. The binary is declared under `"bin"` in `package.json` and available via `npx aep` or `npm link`:
- `aep emit` — emit any event envelope with full flag coverage of all optional fields
- `aep session <id>` — print a session's event timeline with optional `--type` / `--q` filters
- `aep export <id>` — stream session events as JSON or CSV to stdout or `--out <file>`
- `aep workflow <traceId>` — fetch and pretty-print the full multi-agent workflow tree

**New: OpenAPI 3.1 spec**

`src/openapi.json` — a complete spec covering all 13 endpoints, all request/response schemas, both security schemes (`ApiKeyAuth` and `AdminAuth`), and full error responses. Served at:
- `GET /openapi.json` — raw JSON (no auth required)
- `GET /docs` — Swagger UI via CDN (no auth required)

**server.js change (non-breaking)**

`app.listen()` is now guarded by `require.main === module`, and `module.exports = { app }` is added at the bottom. This allows the integration test suite to import the Express app directly without starting a server.

---

## Phase 5 — Auth & Multi-Tenancy (2026-03-24)

No breaking changes to the event envelope schema. Server-side only.

**New database table**

`api_keys` — stores key hash, display prefix, tenant binding, permission scopes, and an optional HMAC secret. Raw keys are never persisted.

**New columns on existing tables**

`events.tenant_id` and `sessions.tenant_id` — assigned from the ingest API key at write time. Existing rows are backfilled to `"default"`.

**New endpoints**

`POST /admin/keys`, `GET /admin/keys`, `DELETE /admin/keys/:id` — key lifecycle management, requires `ADMIN_TOKEN`.

**Behaviour changes**

- All write and read endpoints now require authentication when `DASHBOARD_TOKEN` or API keys are configured. See [AUTH.md](./AUTH.md) for details.
- The `tenant` field in the envelope is now enforced: the effective tenant comes from the API key, providing isolation regardless of the envelope value.
- The `signature` field is now verified on ingest if the API key has an `hmacSecret` configured (HMAC-SHA256 over a canonical JSON form of the event).

---

## v0.2.0 (2026-03-22)

**Breaking changes**

| Field | Change |
|---|---|
| `specversion` | Value bumped from `"0.1.0"` to `"0.2.0"`. Events with the old value will fail envelope validation. |

**New fields (all optional)**

`parent_session_id` (string) — References the `session_id` of the agent that spawned this session. Absent on root/top-level and standalone sessions. Enables tree reconstruction without requiring callers to maintain external maps.

`agent_role` (enum: `"orchestrator"` | `"subagent"` | `"standalone"`) — Explicit node-type label. Allows a consumer to classify every session without inferring role from the presence/absence of `parent_session_id` alone.

**Payload schema validation**

`payload` now accepts an optional `$schema` property (string URI). When present, the validator resolves the schema from `schemas/payloads/` and validates the payload against it. Unknown or unresolvable `$schema` references produce a `[warn]` annotation but do not mark the event invalid, preserving backward compatibility. A built-in payload schema for `tool.called` is shipped at `schemas/payloads/tool-called.schema.json`.

### Migration guide: v0.1.0 → v0.2.0

1. **Update `specversion`** in every event from `"0.1.0"` to `"0.2.0"`. The `createEvent` factory handles this automatically; hand-crafted JSON files must be updated manually.

2. **`agent_role` and `parent_session_id` are optional** — no changes required for existing single-agent scenarios. Add `agent_role: "standalone"` to existing agents for clarity; it is not validated as required.

3. **Payload `$schema` is opt-in** — existing payloads without a `$schema` key continue to be accepted as plain objects with no change in behaviour.

4. **Validator warnings** — the updated `validateEvent()` returns entries prefixed with `[warn]` for unresolvable payload schemas. Callers that treat all `errors` entries as fatal should filter by the `[warn]` prefix or check the `valid` boolean (warnings do not flip it to `false`).
