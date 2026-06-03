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

### Phase 11: OpenTelemetry Bridge (Q2 2026)

**Objective:** Enable AEP to consume and emit traces via OpenTelemetry.

- OTEL Collector receiver: consume traces from standard OTEL exporters
- OTEL Collector exporter: push AEP events to the ingest API
- Span-to-event mapping: translate OTEL spans to AEP events (preserving trace context)
- Example: existing Datadog/NewRelic instrumentation → OTEL Collector → AEP ingest

**Success criteria:**
- ✅ OTEL SDK can export traces to AEP
- ✅ Trace context (trace ID, span ID, parent span ID) maps to AEP causation chains
- ✅ Drop-in replacement for existing OTEL exporters

### Phase 12: Advanced Dashboard Features (Q3 2026)

**Objective:** Enhance real-time visualization and analytics.

- **Advanced filtering**: filter by agent role, event type, payload fields, custom labels
- **Workflow visualization**: interactive DAG showing causation chains
- **Performance profiling**: latency breakdown per agent, per tool, per event type
- **Anomaly detection**: alert when workflow deviates from expected patterns
- **Custom analytics**: user-defined queries over event streams

### Phase 13: Webhooks & Alerts (Q3 2026)

**Objective:** Trigger external actions based on events or patterns.

- Webhook registration: `POST /webhooks` with event filters and target URL
- Event delivery: POST matching events to webhook URL with retries
- Filtering: subscribe to subsets of events (e.g., all `error.raised` events)
- Signing: webhook payloads are HMAC-signed for verification

### Phase 14: S3/Cloud Export (Q3 2026)

**Objective:** Long-term archival and compliance.

- Periodic export: export sessions/events to S3, GCS, or Azure Blob Storage
- Format options: JSON Lines, Parquet, CSV
- Compression: gzip, brotli
- Retention policies: auto-delete from SQLite after N days, export to cold storage

---

## 📊 Success Metrics

| Metric | Target | Status |
|--------|--------|--------|
| **SDK Language Coverage** | JS, Python, Go, Rust, Java | ✅ 3/5 (JS, Python, Go) |
| **Test Coverage** | ≥80% | ✅ 90%+ |
| **Event Latency (p99)** | <100ms | ✅ ~50ms (local) |
| **Throughput** | ≥1000 events/sec | ✅ ~2000 events/sec |
| **Uptime SLA** | ≥99.9% | ✅ N/A (research phase) |
| **Documentation** | All endpoints + SDKs | ✅ Complete |

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
- **Additional SDKs** — Rust, Java, Ruby, Python (async improvements)
- **Kubernetes Operator** — automatic instrumentation
- **OpenTelemetry Bridge** — OTEL Collector plugin
- **Dashboard Enhancements** — better visualization, advanced filtering
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

**Last Updated:** 2026-06-03 (Phase 10: Kubernetes Operator Complete)
