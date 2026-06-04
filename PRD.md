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

### Phase 12: Framework Auto-Instrumentation (Q2 2026)

**Objective:** Zero-friction adoption — instrument popular agent frameworks without any code changes.

- **One-liner patching** for Python: `import aep; aep.instrument()` auto-patches LangGraph, CrewAI, AutoGen, and the Anthropic/OpenAI SDKs via monkey-patching
- **Native integrations**: work with framework authors to emit AEP events as a first-party feature (LangGraph is the priority target)
- **Node.js auto-instrumentation**: patch LangChain.js and Vercel AI SDK
- **Demo**: 10-agent research workflow in LangGraph with full causation chain replay — shows the "before/after" that makes the value visceral

**Why this matters:** The K8s operator covers infra teams; auto-instrumentation covers every developer running agents locally or in serverless. This is the highest-leverage adoption lever.

**Success criteria:**
- ⏳ `aep.instrument()` works on LangGraph + CrewAI with no other code changes, tested against LangGraph ≥0.1, CrewAI ≥0.2, AutoGen ≥0.3
- ⏳ At least one framework ships native AEP emission
- ⏳ Demo published that shows causation chain replay for a failed multi-agent workflow

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
| **SDK Language Coverage** | JS, Python, Go, Rust, Java | ✅ 3/5 (JS, Python, Go) |
| **Test Coverage** | ≥80% | ✅ 90%+ |
| **Event Latency (p99)** | <100ms | ✅ ~50ms (local) |
| **Throughput** | ≥1000 events/sec | ✅ ~2000 events/sec |
| **Uptime SLA** | ≥99.9% | ⏳ N/A (pre-SaaS) |
| **Documentation** | All endpoints + SDKs | ✅ Complete |

### Adoption

| Metric | Target | Status |
|--------|--------|--------|
| **Framework integrations** | ≥3 major frameworks (LangGraph, CrewAI, AutoGen) | ⏳ Planned Phase 12 |
| **GitHub stars** | 1,000 | ⏳ In progress |
| **aep.dev free tier users** | 500 at launch | ⏳ Planned Phase 13 |
| **OTEL GenAI SIG contribution** | AEP event types proposed | ⏳ Planned Phase 12 |
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
