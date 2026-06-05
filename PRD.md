# Agent Event Protocol (AEP) — Product Requirements & Roadmap

> Structured observability for AI agent systems: capture, trace, and debug agent workflows in real time.

---

## 📋 Vision

AEP provides a unified observability framework for multi-agent AI systems. It enables developers, researchers, and enterprises to:

- **Capture** causation chains across orchestrators and sub-agents
- **Trace** distributed workflows with session IDs, trace IDs, and causation links
- **Debug** complex agent interactions via live dashboards and real-time event streams
- **Audit** agent actions for compliance using HMAC signatures and structured logs

---

## 🎯 Core Principles

1. **Structured Events** — All observations are immutable, timestamped JSON documents with required and optional fields
2. **Causation Chains** — Parent-child relationships (`session_id`, `parent_session_id`, `trace_id`, `causation_id`) preserve workflow intent and execution order
3. **Authentication & Isolation** — API keys scope events to tenants; multi-tenant isolation is enforced at the database and API layer
4. **Zero-Trust Verification** — HMAC-SHA256 signatures allow clients to verify event authenticity independent of the transport layer
5. **Graceful Degradation** — Warnings are non-blocking; schema validation errors do not fail the entire event
6. **Language Parity** — All SDKs implement the same logic, ensuring consistent behavior across languages

---

## 🏆 Market Position

### What makes AEP different

| Dimension | AEP | LangSmith / Langfuse / Arize | OpenTelemetry |
|-----------|-----|-------------------------------|---------------|
| **Model** | Open protocol — any language, any framework | Vendor SDK lock-in | Open standard, but microservice-native |
| **Event semantics** | Agent-native: `handoff.started`, `policy.blocked`, `memory.read`, `tool.called` | LLM-focused spans and traces | Generic spans + attributes |
| **Multi-agent hierarchy** | First-class: `session_id` → `parent_session_id` → `causation_id` + `agent_role` | Bolt-on parent span IDs | Parent span IDs only |
| **Tamper-evident audit** | HMAC-SHA256 signatures on every event | No signing | No signing |
| **Zero-code K8s** | Sidecar injection via operator | Not available | Requires SDK |
| **Self-hostable** | Yes (SQLite → Postgres) | Limited / cloud-first | Yes |

### The core thesis

As agent frameworks proliferate (LangGraph, CrewAI, AutoGen, custom orchestrators), teams will need a **framework-neutral interoperability layer** rather than committing to one vendor's SDK. AEP is to multi-agent observability what CloudEvents is to serverless — an open envelope protocol that any emitter can speak and any consumer can understand.

### The window

OpenTelemetry's [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) are being standardized now. The window to establish AEP as the reference vocabulary is approximately 6–12 months. The counter-move: **contribute AEP's event types to the OTEL GenAI SIG** so that AEP becomes the reference implementation rather than a competitor.

---

## ✨ Completed Phases

### Phase 1-4: Core Server & Events (Q4 2025 → Q1 2026)

**Status: ✅ Complete**

- Event envelope schema (v0.2.0): `specversion`, `id`, `time`, `source`, `type`, `session_id`, `trace_id`, `parent_session_id`, `agent_role`, `subject`, `idempotency_key`, `schema`, `signature`, `tenant`, `labels`, `extensions`, `payload`
- 12 core event types: `task.created`, `task.updated`, `task.completed`, `task.failed`, `tool.called`, `tool.result`, `memory.read`, `memory.write`, `handoff.started`, `handoff.completed`, `policy.blocked`, `error.raised`
- Ingest API: `POST /events`, `GET /sessions`, `GET /sessions/{id}`, `GET /sessions/{id}/events`
- JSON Schema validation via AJV
- Event deduplication (by UUID + timestamp)

### Phase 5: Auth & Multi-Tenancy (2026-03-24)

**Status: ✅ Complete**

- API key management: `POST /admin/keys`, `GET /admin/keys`, `DELETE /admin/keys/:id`
- Tenant isolation: `tenant_id` column on `events` and `sessions` tables
- HMAC-SHA256 signature verification on ingest
- Bearer token authentication
- Permission scopes (read, write, admin)

### Phase 6: Testing & CLI (2026-03-24)

**Status: ✅ Complete**

- 82+ unit and integration tests (Node.js `node:test` runner)
- CLI tool: `aep emit`, `aep session`, `aep export`, `aep workflow`, `aep validate`
- OpenAPI 3.1 spec at `GET /docs`
- GitHub Actions CI pipeline

### Phase 7: Production Hardening (2026-03-24)

**Status: ✅ Complete**

- Pagination: `GET /sessions?limit=&cursor=` with opaque cursors
- Rate limiting: per-API-key fixed-window (configurable via `RATE_LIMIT_RPM`)
- Graceful shutdown: SIGTERM/SIGINT handlers
- Docker & docker-compose
- Prometheus metrics: `/metrics/prometheus`
- Structured JSON logging via Pino
- Health probes: `/health`, `/ready`

### Phase 8: Python SDK (2026-06-02)

**Status: ✅ Complete**

- `aep` Python package: event creation, validation, signing
- `AEPClient` (sync) + `AsyncAEPClient` (async via `asyncio.gather`)
- Full error hierarchy: `AEPValidationError`, `AEPAuthError`, `AEPRateLimitError`, `AEPNotFoundError`, `AEPConnectionError`, `AEPServerError`
- 107 unit + 11 integration tests
- `demos/subagent_research.py` — multi-agent orchestrator + 3 parallel sub-agents

**Deliverables:**
- `sdks/python/` — package source
- `sdks/python/README.md` — full SDK reference
- `tests/unit/`, `tests/integration/` — comprehensive test suite
- Schemas bundled with package

### Phase 9: Go SDK (2026-06-03)

**Status: ✅ Complete**

- `aep-go` Go package: event creation, validation, signing
- `Client` (sync) + `AsyncClient` (async via goroutines)
- Full error hierarchy matching other SDKs
- 69+ unit + 11 integration tests
- Payload schema caching with 1-hour TTL (memory-safe for long-running processes)
- HTTP 422 handler for schema validation errors
- CLI tool: `aep-go emit`, `aep-go session`, `aep-go validate`, `aep-go health`, `aep-go ready`
- `examples/subagent_research.go` — multi-agent orchestrator + 3 parallel sub-agents

**Deliverables:**
- `sdks/go/` — package source
- `sdks/go/README.md` — full SDK reference
- `sdks/go/cmd/aep-go/` — CLI tool
- `sdks/go/examples/` — demo applications
- `tests/` — unit + integration test suite

---

## 🚀 Roadmap (Future Phases)

### Phase 10: Kubernetes Operator (2026-06-03)

**Status: ✅ Complete**

- `AgentInstrumentation` CRD (cluster-scoped): `namespaceSelector`, `podSelector`, `apiKeySecretRef`, `sidecarImage`, `resources`, `env` overrides
- Mutating webhook (`aep.dev/inject=true` annotation opt-in): injects AEP sidecar with downward API env vars, Secret-backed API key, configurable resources, secure SecurityContext
- Controller: reconciles `AgentInstrumentation` CRs, maintains `status.injectedCount` and `status.conditions` (Ready/Disabled/InjectionFailed)
- Helm chart (`operator/helm/aep-operator/`) with cert-manager TLS, configurable `namespaceSelector`, all values documented
- 22 unit tests (10 controller + 12 webhook) + 4 envtest integration tests

**Success criteria:**
- ✅ Operator can inject sidecar into agent pods
- ✅ Agent code requires zero changes to emit events
- ✅ Events include Kubernetes metadata (pod name, namespace, node, etc.)
- ✅ Helm chart for easy deployment

### Phase 11: OpenTelemetry Bridge (2026-06-04)

**Status: ✅ Complete (SDK bridge) — Collector plugin delivered in Phase 12a**

**Objective:** Enable AEP to consume and emit traces via OpenTelemetry — positioned as complementary, not competing.

**Delivered (PR #20):**
- Span-to-event mapper (`sdks/python/aep/otel/mapper.py`): translates OTEL spans to AEP events, preserving trace context; priority-ordered classification (error > handoff > tool > task)
- Python SDK bridge (`aep.otel.AEPSpanExporter`): standard `SpanExporter` that dual-emits AEP events alongside OTEL spans via `AEPClient`
- `trace_id` → AEP `trace_id` + `session_id`; parent span ID → `causation_id`; `service.name` → `agent://` source; `gen_ai.*` attributes → payload
- Go span-to-event mapper (`sdks/go/aep/otel/mapper.go`) for language parity
- Demo (`demos/otel_bridge.py`) + module README; 38 unit tests

**Delivered separately in Phase 12a:**
- OTEL Collector exporter (push AEP events from the Collector)
- End-to-end Datadog/NewRelic → Collector → AEP demo

**Success criteria:**
- ✅ OTEL SDK can export traces to AEP
- ✅ Trace context (trace ID, span ID, parent span ID) maps to AEP causation chains
- ✅ Drop-in `SpanExporter` for existing OTEL-instrumented Python apps
- ✅ OTEL Collector exporter plugin (Phase 12a)
- ⏳ AEP event types proposed / accepted in OTEL GenAI semantic conventions

### Phase 12a: OpenTelemetry Collector Plugin (2026-06-04)

**Status: ✅ Complete**

**Objective:** Let any OTEL-instrumented system emit to AEP through a standard Collector pipeline — no application code changes — completing the OTEL story begun in Phase 11.

**Delivered (PR #28):**
- AEP Collector **exporter** (`otelbridge/exporters/aepexporter/`, separate Go module `github.com/surpradhan/aep-otel-bridge`) on the opentelemetry-collector v0.96 factory/config/exporter pattern
- pdata-native span-to-event mapper mirroring the reference classification (error > handoff > tool > task > default); `session_id = ses_<trace_id[:16]>`; parent span ID → `causation_id`; `gen_ai.*` → payload; `service.name` → `agent://` source
- Batched emission to the AEP ingest API via the Go SDK client
- `builder-config.yaml` (ocb) to build a Collector including the exporter; demo (`docker-compose.yml`: app → Collector → AEP) with an API-key bootstrap step
- Unit tests + a dedicated `otelbridge-test` CI job
- Prerequisite (PR #24): repaired and CI-covered the Go SDK, which previously did not compile from a clean checkout

**Success criteria:**
- ✅ Existing OTEL instrumentation → Collector → AEP ingest, trace context preserved
- ✅ Collector exporter follows the opentelemetry-collector-contrib pattern
- ✅ otelbridge built + unit-tested in CI
- ⏳ End-to-end ocb / docker-compose demo verified (code verified; full E2E run pending)
- ⏳ Live-server integration test

### Phase 12b: Framework Auto-Instrumentation — LangGraph (2026-06-04)

**Status: ✅ Complete (LangGraph)**

**Objective:** Zero-friction adoption — instrument agent frameworks without any code changes. LangGraph is the first (priority) target.

**Why this matters:** The K8s operator covers infra teams; auto-instrumentation covers every developer running agents locally or in serverless. This is the highest-leverage adoption lever.

**Delivered (PR #25):**
- `aep.instrument()` / `aep.uninstrument()` (`sdks/python/aep/instrument.py`): one line enables/disables auto-instrumentation
- Implemented as a LangChain `BaseCallbackHandler` injected into `CompiledStateGraph` execution (`invoke`/`ainvoke`/`stream`/`astream`) via the call's `RunnableConfig` — LangGraph's supported extension point, robust to parallel node fan-out (rather than wrapping internal methods)
- Event mapping: graph run → orchestrator `task.*`; each node → sub-agent `task.*`; orchestrator→node → `handoff.started`/`handoff.completed`; tool calls → `tool.called`/`tool.result` with `error.raised` on failure
- Full causation DAG: one `trace_id` per run; per-node `session_id` with `parent_session_id` → orchestrator; every `causation_id` resolves to a real emitted event
- Pluggable `FrameworkInstrumentor` registry so CrewAI/AutoGen can be added by registering one class
- Host-safe: no-op + warning when LangGraph/langchain-core absent or framework internals differ (never falsely reports success); emit failures swallowed; graph exceptions still propagate; idempotent re-instrumentation
- Demo (`demos/langgraph_multiagent.py`): 10-node research workflow emitting 38 events across 10 sessions on one trace
- 24 unit tests + a live-server integration test (auto-skips when unreachable); `[langgraph]` extra; `python-sdk-test` CI job (3.10/3.11/3.12)

**Success criteria:**
- ✅ `aep.instrument()` works on LangGraph with no other code changes (verified end-to-end against an installed LangGraph 1.x)
- ✅ Tested against LangGraph ≥0.1
- ✅ Demo emits a full multi-agent causation DAG (10 sessions, 1 trace, no dangling causation links)
- ✅ Unit + integration coverage wired into CI

**Deferred to Phase 12c+:** CrewAI, AutoGen, and Anthropic/OpenAI SDK patching; Node.js auto-instrumentation (LangChain.js, Vercel AI SDK); native first-party emission with framework authors.

### Phase 12c: Framework Auto-Instrumentation — CrewAI (2026-06-05)

**Status: ✅ Complete (CrewAI)**

**Objective:** Extend zero-code-change auto-instrumentation to **CrewAI**, the second major Python agent framework, and in doing so prove the `FrameworkInstrumentor` registry generalizes beyond the LangChain ecosystem. Success is `pip install "aep[crewai]"; aep.instrument()` emitting a full causation DAG from an unmodified `Crew.kickoff()`, exactly as Phase 12b does for LangGraph.

**Why CrewAI next (over AutoGen / SDK patching):** The Phase 12b deferral list names CrewAI first, and the adoption metric ([Success Metrics](#-success-metrics)) targets ≥3 frameworks with CrewAI explicitly named. It is the most-requested LangGraph alternative and shares the same multi-agent orchestration shape (crew → agents → tools), so the existing event mapping transfers cleanly. AutoGen and Anthropic/OpenAI SDK patching follow in 12d+.

**The core engineering problem (read before scoping):** Phase 12b's `FrameworkInstrumentor` docstring says adding a framework is "register one class," but that is only true *within the LangChain ecosystem*. The current design builds a **single LangChain `BaseCallbackHandler`** (`_build_callback_base()`) and hands that one handler to every instrumentor's `.instrument(handler)`. `aep.instrument()` is a hard no-op when `langchain-core` is absent (`instrument.py` ~L729). **CrewAI does not use LangChain callbacks** — it exposes its own `crewai.utilities.events` event bus (`@crewai_event_bus.on(...)` / `BaseEventListener`) plus `step_callback`/`task_callback` hooks. So 12c's real work is a **refactor + a new transport**, not a one-class addition.

**Scope — three pieces of work, in order:**

1. **Decouple the emission core from the LangChain transport.** Extract the framework-agnostic machinery — the background `_Emitter` queue, `_RunInfo` run bookkeeping, the ID helpers, and the lifecycle→event mapping (run-open → `task.created`/`tool.called`, run-close → `task.completed`/`tool.result`/`task.failed`, parent→child → `handoff.started`/`handoff.completed`, causation/trace/session threading) — into a transport-neutral `_EventBuilder`/emitter that both the LangChain handler and the new CrewAI listener call. The LangChain handler becomes a thin adapter over it; **this refactor must not change any Phase 12b event output** (regression-locked by the existing 12b tests).
2. **Relax the `langchain-core` gate.** `instrument()` must only require LangChain when a LangChain-family framework is actually being instrumented. With only CrewAI installed, `aep.instrument()` must work without `langchain-core` present.
3. **Add `CrewAIInstrumentor`.** Subscribe to the CrewAI event bus (the supported extension point — preferred over wrapping `Crew`/`Agent` internals, mirroring 12b's choice of LangGraph's `RunnableConfig` callbacks over monkey-patching internals). `available()` returns whether `crewai` imports; `uninstrument()` unsubscribes.

**Event mapping (CrewAI → AEP):**

- `Crew.kickoff()` (root) → orchestrator `task.created` / `task.completed` / `task.failed`; new `trace_id` + root `session_id`
- each Agent / Task execution → sub-agent `task.*` with `parent_session_id` → crew session
- crew → agent dispatch → `handoff.started` / `handoff.completed` on the crew session
- tool usage → `tool.called` / `tool.result`, with `error.raised` on tool failure
- every `causation_id` resolves to a real emitted event; one `trace_id` spans the whole kickoff (identical causation-DAG guarantees as 12b)

**Deliverables:**
- Refactored transport-neutral emission core, with the LangChain handler reimplemented on top of it and **all existing Phase 12b unit + integration tests still green, unchanged**
- `CrewAIInstrumentor` registered in `_INSTRUMENTORS`; `instrument(frameworks=["crewai"])` works with CrewAI installed and `langchain-core` absent
- `[crewai]` extra in `pyproject.toml`; CrewAI added to the `python-sdk-test` CI matrix
- Demo `demos/crewai_multiagent.py` — a multi-agent crew emitting a full causation DAG (multiple sessions, one trace, no dangling causation links), mirroring `langgraph_multiagent.py`
- Unit tests for the CrewAI event→AEP mapping + a live-server integration test (auto-skips when unreachable), matching 12b's coverage shape
- Docs: README + SDK README updated; CHANGELOG + PRD status flipped to ✅; memory index updated

**Success criteria:**
- ✅ `aep.instrument()` emits a full causation DAG from an unmodified `Crew.kickoff()` with no other code changes, verified end-to-end against an installed CrewAI release
- ✅ Tested against a pinned minimum CrewAI version (floor surfaced in warnings, as `MIN_LANGGRAPH_VERSION` is for 12b)
- ✅ The 12b LangChain path is byte-for-byte unchanged in output (no event regressions from the refactor)
- ✅ Host-safe: no-op + warning when CrewAI absent or its event API differs; emit failures swallowed; crew exceptions still propagate; idempotent re-instrumentation
- ✅ Unit + integration coverage wired into CI; demo produces a clean DAG

**Resolved open questions (settled against a real CrewAI 1.14 trace):**
- **CrewAI event-bus stability** — confirmed drift: the event bus moved from `crewai.utilities.events` (named in the original spec) to `crewai.events` in the 1.x line. The `CrewAIInstrumentor` only reports `available()` when `crewai.events` is importable, and `subscribe()` warns + no-ops (surfacing the `MIN_CREWAI_VERSION` floor) if the event classes it maps are absent — so an API drift degrades cleanly rather than crashing.
- **Agent-vs-Task granularity** — settled by inspecting a real kickoff trace: CrewAI fires `TaskStarted` *then* `AgentExecutionStarted` inside it, i.e. a Task **wraps** its Agent execution (they are not peers). We therefore make the **Task** the sub-agent session — named for the agent assigned to it — and fold the agent execution into it (no double-counting, no synthetic task→agent handoff). An `AgentExecution` that runs outside any tracked task (e.g. a hierarchical manager agent) opens its own agent-keyed sub-agent session as a fallback.

**Deferred to Phase 12d+:** ~~AutoGen~~ (done in 12d); Anthropic/OpenAI Agents SDK patching; Node.js auto-instrumentation (LangChain.js, Vercel AI SDK); native first-party emission with framework authors.

### Phase 12d: Framework Auto-Instrumentation — AutoGen (2026-06-05)

**Status: ✅ Complete** — merged in Phase 12d. `pip install "aep[autogen]"; aep.instrument()` emits a full causation DAG from an unmodified AutoGen AgentChat `team.run()`, exactly as 12b does for LangGraph and 12c for CrewAI.

**Objective:** Extend zero-code-change auto-instrumentation to **AutoGen AgentChat**, the third major Python agent framework. This is the framework named in the [Success Metrics](#-success-metrics) ≥3-framework adoption target (LangGraph, CrewAI, AutoGen), so 12d closes that metric.

**Why AutoGen (over SDK patching / Node.js):** The 12c deferral list names AutoGen first; it is a major, actively-developed multi-agent framework (Microsoft) that stays inside the existing Python SDK and `_INSTRUMENTORS` registry, where the established `_EmissionCore` transferred cleanly. Anthropic/OpenAI Agents SDK patching and the Node.js runtime (a separate, larger lift) follow in 12e+.

**The core engineering problem (settled against a real trace):** AutoGen AgentChat (the 0.4+ rewrite) has **neither a callback registry (like LangGraph/LangChain) nor an event bus (like CrewAI)**. A team's only observation surface is the async stream of typed messages/events yielded by `BaseGroupChat.run_stream`. So 12d's transport is a **stream tap**, not a callback handler or bus listener: the instrumentor wraps `run_stream` (which `BaseGroupChat.run` consumes internally, so one tap covers both `run()` and `run_stream()`) with an `AEPAutoGenTracer` that transparently re-yields every item while translating it into `_EmissionCore` calls. No emission-core changes were needed — the third transport drops onto the existing core.

**Event mapping (AutoGen AgentChat → AEP):**

- team `run_stream` (root) → orchestrator `task.created` / `task.completed` / `task.failed`; new `trace_id` + root `session_id`, named for the team
- each distinct message `source` (an agent name), opened lazily on first sight → sub-agent `task.*` with `parent_session_id` → team session
- team → agent dispatch → `handoff.started` / `handoff.completed` on the team session
- `ToolCallRequestEvent` → `tool.called`; matching `ToolCallExecutionEvent` (paired exactly by `call_id`) → `tool.result`, or `error.raised` when `is_error`
- every `causation_id` resolves to a real emitted event; one `trace_id` spans the whole run (identical causation-DAG guarantees as 12b/12c)

**Deliverables:**
- `AutoGenInstrumentor` + `AEPAutoGenTracer` / `_AutoGenRunContext` registered in `_INSTRUMENTORS`; `instrument(frameworks=["autogen"])` works with AutoGen installed and `langchain-core` absent. **No change to the 12b/12c emission core or their event output** (regression-locked by their unchanged tests).
- `[autogen]` extra in `pyproject.toml`; AutoGen added to the `python-sdk-test` CI install line
- Demo `demos/autogen_multiagent.py` — a 2-agent round-robin team with a tool, emitting a full causation DAG, runnable offline with no LLM key via `autogen-ext`'s `ReplayChatCompletionClient`
- 19 unit tests for the AutoGen event→AEP mapping (runnable without AutoGen installed) + 2 live-server integration tests (auto-skip when unreachable), matching 12b/12c's coverage shape
- Docs: README + SDK README updated; CHANGELOG + PRD status flipped to ✅; memory index updated

**Success criteria:**
- ✅ `aep.instrument()` emits a full causation DAG from an unmodified `team.run()` with no other code changes, verified end-to-end against installed AutoGen AgentChat 0.7.x (1 trace, N sessions, 0 dangling causation links)
- ✅ Tested against a pinned minimum version (`MIN_AUTOGEN_VERSION`, surfaced in warnings)
- ✅ The 12b/12c paths are byte-for-byte unchanged in output (no event regressions)
- ✅ Host-safe: no-op + warning when AutoGen absent or its team base class differs; per-item mapping errors swallowed (host stream never broken); emit failures swallowed; run exceptions still propagate; idempotent re-instrumentation
- ✅ Unit + integration coverage wired into CI; demo produces a clean DAG

**Resolved open questions (settled against a real AutoGen 0.7.x trace):**
- **Observation surface** — confirmed AutoGen AgentChat exposes no callback registry or event bus; the typed `run_stream` event stream is the supported surface. Tapping `run_stream` (not `run`) is sufficient because `BaseGroupChat.run` consumes `run_stream` internally — verified by reading `BaseGroupChat.run`'s source — so a single patch instruments both entry points with no double-counting.
- **Agent boundaries** — AutoGen emits no explicit per-agent start/stop events; agent activity is inferred from each message's `source`. A sub-agent session is therefore opened lazily on an agent's first message and closed at run end. Consequence (documented caveat): a run-level failure marks only the orchestrator `task.failed`; observed sub-agents close `task.completed`, since AutoGen surfaces no per-agent failure signal in the stream.
- **In-team vs standalone agents** — in-team agents run through the AgentChat runtime, not `BaseChatAgent.run_stream`, so instrumenting only the team boundary captures them once. Standalone single-agent `BaseChatAgent` runs (no team) are intentionally out of scope for 12d — teams are the multi-agent surface, directly analogous to CrewAI's crew and LangGraph's graph.
- **Tool pairing under concurrency** — AutoGen tags every `FunctionExecutionResult` with the `call_id` of its `FunctionCall`, so tool pairing is **exact** (even for parallel tool calls returned out of order) without the LIFO/scope-fallback heuristics CrewAI needed.

### Phase 13: Hosted SaaS — aep.dev (Q3 2026)

**Objective:** Remove the self-hosting barrier and make AEP a product people depend on daily.

- **Free tier**: unlimited events for individuals up to 5 GB storage, 30-day retention, 1 project
- **Team tier**: multi-tenant, 90-day retention, SSO, shared dashboards
- **Enterprise tier**: unlimited retention, SAML, dedicated ingest endpoint, SLA
- Postgres backend replacing SQLite for production durability
- Multi-region ingest endpoints for low-latency global emission
- Managed TLS, auth, and rate limiting — zero ops for users

**Why this matters:** Nobody self-hosts observability. The hosted product converts "interesting open-source" into infrastructure teams depend on. It also funds ongoing development.

**Success criteria:**
- ✅ Public beta at aep.dev with functional free tier
- ✅ <50ms p99 ingest latency globally
- ✅ Zero-downtime deployments

### Phase 14: Compliance & Audit Suite (Q3 2026)

**Objective:** Own the enterprise compliance story that no other agent observability tool addresses.

- **Cryptographic tamper-detection**: HMAC-signed events — any post-hoc modification to the event payload or ordering is detectable, even if the underlying storage is accessible. Note: this provides *detection* guarantees, not storage immutability; WORM storage can be added at the infrastructure layer for stricter requirements
- **Audit export**: export signed event logs as tamper-evident bundles (PDF + JSON) for legal/compliance review
- **Policy enforcement reporting**: `policy.blocked` event analytics — what did the agent refuse to do, and when?
- **Data residency controls**: choose region for event storage (EU, US, APAC)
- **Compliance frameworks**: pre-built report templates for SOC2, HIPAA, GDPR, EU AI Act
- **Access logs**: full API key usage audit trail

**Why this matters:** Regulated industries (finance, healthcare, legal) are deploying AI agents now and have no way to prove to auditors what agents did and didn't do. AEP's HMAC signatures are uniquely positioned to answer this. No other agent observability tool has this story.

**Success criteria:**
- ✅ Audit export accepted by a compliance review in at least one regulated industry
- ✅ `policy.blocked` analytics dashboard live
- ✅ Data residency controls certified for EU AI Act

### Phase 15: Advanced Dashboard Features (Q4 2026)

**Objective:** Enhance real-time visualization and analytics.

- **Advanced filtering**: filter by agent role, event type, payload fields, custom labels
- **Workflow visualization**: interactive DAG showing causation chains
- **Performance profiling**: latency breakdown per agent, per tool, per event type
- **Anomaly detection**: alert when workflow deviates from expected patterns
- **Custom analytics**: user-defined queries over event streams

### Phase 16: Webhooks & Alerts (Q4 2026)

**Objective:** Trigger external actions based on events or patterns.

- Webhook registration: `POST /webhooks` with event filters and target URL
- Event delivery: POST matching events to webhook URL with retries
- Filtering: subscribe to subsets of events (e.g., all `error.raised` events)
- Signing: webhook payloads are HMAC-signed for verification

### Phase 17: S3/Cloud Export (Q4 2026)

**Objective:** Long-term archival and compliance.

- Periodic export: export sessions/events to S3, GCS, or Azure Blob Storage
- Format options: JSON Lines, Parquet, CSV
- Compression: gzip, brotli
- Retention policies: auto-delete from SQLite after N days, export to cold storage

---

## 📊 Success Metrics

### Technical

| Metric | Target | Status |
|--------|--------|--------|
| **SDK Language Coverage** | JS, Python, Go, Rust, Java | 🟡 3/5 (JS, Python, Go); Rust + Java not yet scheduled |
| **Test Coverage** | ≥80% | ✅ 90%+ |
| **Event Latency (p99)** | <100ms | ✅ ~50ms (local) |
| **Throughput** | ≥1000 events/sec | ✅ ~2000 events/sec |
| **Uptime SLA** | ≥99.9% | ⏳ N/A (pre-SaaS) |
| **Documentation** | All endpoints + SDKs | ✅ Complete |

### Adoption

| Metric | Target | Status |
|--------|--------|--------|
| **Framework integrations** | ≥3 major frameworks (LangGraph, CrewAI, AutoGen) | 🟢 LangGraph (12b) + CrewAI (12c) + AutoGen (12d) done — target met |
| **GitHub stars** | 1,000 | ⏳ In progress |
| **aep.dev free tier users** | 500 at launch | ⏳ Planned Phase 13 |
| **OTEL GenAI SIG contribution** | AEP event types proposed | ⏳ Not yet scheduled — no phase delivers it (the OTEL bridge shipped in 11/12a, but upstreaming AEP's vocabulary to the SIG is unowned; needs its own phase) |
| **Compliance case study** | 1 regulated industry deployment | ⏳ Planned Phase 14 |

---

## 🛠️ Technical Architecture

### Event Flow

```
Client SDK
  ↓ (POST /events with Bearer token)
AEP Ingest Server
  ├─ Authenticate (API key lookup)
  ├─ Validate (JSON Schema, envelope)
  ├─ Verify Signature (HMAC-SHA256 if configured)
  ├─ Deduplicate (UUID + timestamp)
  └─ Store (SQLite)
       ↓ (Real-time SSE)
    Live Dashboard
       ↓ (Query)
    Read API (paginated)
```

### Database Schema

**events table**
- id (UUID, primary key)
- tenant_id (string, indexed for multi-tenancy)
- session_id (string, indexed for causation)
- trace_id (string, indexed for distributed tracing)
- parent_session_id (string, optional, for agent hierarchy)
- type (enum: 12 core types)
- source (string, origin of the event)
- agent_role (enum: orchestrator, subagent, standalone)
- time (RFC3339, when the event occurred)
- payload (JSON)
- signature (JSON: {alg, value})
- created_at (timestamp, server-side)

**sessions table**
- id (UUID, primary key)
- tenant_id (string, indexed for multi-tenancy)
- trace_id (string, indexed)
- parent_session_id (string, optional)
- agent_role (enum)
- event_count (integer, denormalized)
- first_time (RFC3339)
- last_time (RFC3339)
- created_at (timestamp)

**api_keys table**
- id (UUID, primary key)
- tenant_id (string, indexed)
- key_hash (SHA256 of the raw key)
- key_prefix (first 8 chars for UI display)
- scopes (JSON: ["read", "write", "admin"])
- hmac_secret (optional, for signature verification)
- created_at (timestamp)
- revoked_at (timestamp, optional)

### Deployment Models

1. **Local development** — SQLite + in-memory cache, all ports on localhost
2. **Docker compose** — SQLite in named volume, nginx reverse proxy with TLS
3. **Kubernetes** — PostgreSQL backend (TBD), Redis for distributed caching (TBD), horizontal pod autoscaling

---

## 🔐 Security Considerations

- **API Key Storage** — Raw keys never persisted; only SHA256 hashes stored
- **HMAC Signing** — Constant-time comparison (`hmac.Equal`) prevents timing attacks
- **TLS/HTTPS** — Required in production (enforce via reverse proxy)
- **CORS** — Restrict dashboard to known origins
- **SQL Injection** — Use parameterized queries (SQLite3 bindings)
- **Tenant Isolation** — `tenant_id` column enforced at DB layer; API key scopes limit read/write

---

## 📚 Documentation Status

| Document | Status | Location |
|----------|--------|----------|
| README | ✅ Complete | `README.md` |
| CHANGELOG | ✅ Complete | `CHANGELOG.md` |
| SETUP | ✅ Complete | `SETUP.md` |
| AUTH | ✅ Complete | `AUTH.md` |
| SECURITY | ✅ Complete | `SECURITY.md` |
| CONTRIBUTING | ✅ Complete | `CONTRIBUTING.md` |
| Python SDK | ✅ Complete | `sdks/python/README.md` |
| Go SDK | ✅ Complete | `sdks/go/README.md` |
| OpenAPI Spec | ✅ Complete | `src/openapi.json` |
| Inline godoc (Go) | ✅ Complete | `sdks/go/aep/*.go` |

---

## 🤝 Contributing

We welcome contributions across:
- **Framework Integrations** — LangGraph, CrewAI, AutoGen, Vercel AI SDK auto-instrumentation patches
- **Kubernetes Operator** — multi-cluster support, OTEL sidecar integration, additional webhook policies
- **Additional SDKs** — Rust, Java, Ruby, TypeScript (native, not Node.js)
- **OpenTelemetry Bridge** — OTEL Collector plugin + GenAI SIG contributions
- **Dashboard Enhancements** — better visualization, advanced filtering, causation DAG replay
- **Compliance tooling** — audit export formats, policy analytics
- **Performance** — query optimization, caching strategies
- **Docs & Examples** — tutorials, case studies, best practices

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## 📈 Metrics & Analytics (Phase 10+)

Future phases will include:
- Per-agent latency percentiles
- Event throughput trends
- Error rate by event type
- Workflow success/failure rates
- Sub-agent concurrency patterns

---

## 🎓 Learning Resources

- **Quick Start** — 2-minute local setup in [README.md](./README.md)
- **Architecture Deep Dive** — see [Architecture section in README](./README.md#-architecture)
- **API Reference** — interactive OpenAPI at `/docs` (requires running server)
- **Examples** — `demos/` directory in Node.js, Python, and Go SDKs
- **Security** — [SECURITY.md](./SECURITY.md) for hardening and threat model

---

## 📞 Support

- **Questions?** Open an [issue](https://github.com/surpradhan/agent-event-protocol/issues) or start a [discussion](https://github.com/surpradhan/agent-event-protocol/discussions)
- **Found a bug?** File an [issue](https://github.com/surpradhan/agent-event-protocol/issues) with reproduction steps
- **Security concern?** See [SECURITY.md](./SECURITY.md) for responsible disclosure

---

**Last Updated:** 2026-06-03 (Phase 10 complete; market strategy + Phases 12–14 added)
