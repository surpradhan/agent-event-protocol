# Agent Event Protocol (AEP)

> Structured observability for AI agent systems: capture, trace, and debug agent workflows in real time.

[![GitHub](https://img.shields.io/badge/GitHub-surpradhan/agent--event--protocol-blue?logo=github)](https://github.com/surpradhan/agent-event-protocol)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Tests: 200+](https://img.shields.io/badge/tests-200%2B-brightgreen)](#testing)

> **📍 Project direction (2026-06):** AEP is converging on OpenTelemetry rather than continuing as a standalone protocol. Active development is moving toward contributions to the OTel GenAI semantic conventions. This repo remains published and usable, but the envelope/server here is now a **reference implementation**, not the forward roadmap.

**Stop flying blind with AI agents.** AEP is a lightweight, structured observability framework for multi-agent systems. Capture causation chains, debug orchestration logic, visualize agent workflows: all in real time.

Perfect for:
- 🎯 **Orchestrators** managing multiple agents and sub-agents
- 🔍 **Researchers** studying agent behavior and decision trees
- 🏢 **Enterprises** auditing agent actions for compliance
- 👨‍💻 **Developers** debugging complex agentic systems

---

## 🚀 Quick Start (2 minutes)

**Requirements:** Node.js 20+

### Local Development

The dashboard and read APIs are open in dev mode, but **ingest (`POST /events`)
always requires a write-scoped API key** — so the quick start mints one first.

```bash
# 1. Clone & install
git clone https://github.com/surpradhan/agent-event-protocol.git
cd agent-event-protocol
npm install

# 2. Start the ingest server (ADMIN_TOKEN lets you mint an API key)
ADMIN_TOKEN=dev-admin npm run ingest

# 3. In another terminal: mint a write key and emit a sample event
export AEP_API_KEY=$(curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer dev-admin" -H "Content-Type: application/json" \
  -d '{"tenantId":"dev","label":"quickstart","scopes":["read","write"]}' \
  | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).key))")
npm run emit:example   # → { "status": 202, ... }

# 4. Open the live dashboard (open in dev; set DASHBOARD_TOKEN to lock it down)
open http://localhost:8787/dashboard
```

> **Why a key in dev?** "Dev mode" (no `DASHBOARD_TOKEN`) only opens the
> dashboard and read endpoints. Ingest is authenticated in every mode — see
> [AUTH.md](./AUTH.md). The demo scripts below also read `AEP_API_KEY`.

**See it in action with demo scenarios:**
```bash
npm run demo:support     # 📞 Support ticket triage agent
npm run demo:itops       # 🛠️ IT ops incident response
npm run demo:research    # 🔬 Research & synthesis
npm run demo:subagent    # 🌳 Orchestrator + 3 parallel sub-agents
npm run demo:logging     # 📋 Log spike investigation
```

### Python SDK

```bash
# Install (requires Python ≥ 3.10)
pip install -e "sdks/python[dev]"

# Emit an event
python - <<'EOF'
from aep import create_event, AEPClient

event = create_event(
    source="agent://my-agent",
    type="task.created",
    session_id="ses_001",
    trace_id="trc_001",
    payload={"task": "summarise document"},
)
# AEPClient picks up AEP_API_KEY from the environment — export a write-scoped
# key first (ingest always needs one; see "Local Development" above).
with AEPClient() as client:
    print(client.emit(event))
EOF

# Run the multi-agent research demo
python sdks/python/demos/subagent_research.py

# Auto-instrument LangGraph (zero-code) and run the 10-node demo
pip install -e "sdks/python[langgraph]"
python sdks/python/demos/langgraph_multiagent.py

# Or auto-instrument CrewAI (runs offline, no LLM key needed)
pip install -e "sdks/python[crewai]"
python sdks/python/demos/crewai_multiagent.py

# Or auto-instrument AutoGen AgentChat (runs offline, no LLM key needed)
pip install -e "sdks/python[autogen]"
python sdks/python/demos/autogen_multiagent.py

# Or auto-instrument the OpenAI Agents SDK (runs offline, no LLM key needed)
pip install -e "sdks/python[openai-agents]"
python sdks/python/demos/openai_agents_multiagent.py

# Or auto-instrument the Anthropic Claude Agent SDK (runs offline, no LLM key needed)
pip install -e "sdks/python[claude-agent]"
python sdks/python/demos/claude_agent_multiagent.py
```

**Auto-instrumentation:** `import aep; aep.instrument()` makes **LangGraph**, **CrewAI**, **AutoGen AgentChat**, the **OpenAI Agents SDK**, and the **Anthropic Claude Agent SDK** workflows emit a full AEP event DAG with no other code changes — see [`sdks/python/aep/instrument.py`](sdks/python/aep/instrument.py).

See [`sdks/python/README.md`](sdks/python/README.md) for the full Python SDK reference.

### Go SDK

```bash
# The Go SDK is a subdirectory module of this monorepo.
go get github.com/surpradhan/agent-event-protocol/sdks/go@latest

# Emit an event
package main
import (
    "context"
    "log"
    "os"
    "github.com/surpradhan/agent-event-protocol/sdks/go/aep"
)

func main() {
    event, _ := aep.CreateEvent(
        "agent://my-agent",
        aep.EventTypeTaskCreated,
        "ses_001",
        "trc_001",
        map[string]interface{}{"task": "analyze data"},
        nil,
    )
    
    client := aep.NewClient()
    // Ingest always needs a write-scoped key. NewClient() does not read the
    // environment, so set it explicitly (export AEP_API_KEY first).
    client.SetAPIKey(os.Getenv("AEP_API_KEY"))
    defer client.Close()
    
    resp, err := client.Emit(context.Background(), event)
    if err != nil {
        log.Fatal(err)
    }
    log.Printf("Emitted: %s", resp.ID)
}
```

See [`sdks/go/README.md`](sdks/go/README.md) for the full Go SDK reference.

### Node.js / TypeScript SDK

```bash
npm install @surpradhan/aep   # from sdks/node/ (Node >= 20, dual ESM + CJS)
```

```ts
import { AEPClient, createEvent } from "@surpradhan/aep";

const event = createEvent(
  "agent://my-agent",
  "task.created",
  "ses_001",
  "trc_001",
  { task: "analyze data" },
  { agentRole: "orchestrator" },
);

// Reads AEP_INGEST_URL / AEP_API_KEY from the environment when not passed in.
const client = new AEPClient({ apiKey: process.env.AEP_API_KEY });
await client.emit(event);
```

```ts
// Zero-code auto-instrumentation for LangChain.js / LangGraph:
import { instrument } from "@surpradhan/aep";
await instrument();           // then run your graph as usual — emits a full AEP DAG
```

See [`sdks/node/README.md`](sdks/node/README.md) for the full Node SDK reference.

**Vercel AI SDK** is supported via the OpenTelemetry bridge — flip on
`experimental_telemetry: { isEnabled: true }`, point an OTEL Collector running
the AEP exporter at AEP, and `generateText` / `streamText` / `ai.toolCall` spans
land as AEP events with full trace/causation preserved. See
[`docs/integrations/vercel-ai-sdk.md`](docs/integrations/vercel-ai-sdk.md) for
the wiring and an honest write-up of the current mapping gaps.

### Production Deployment (With Auth)

```bash
# Set required security tokens
export DASHBOARD_TOKEN=$(openssl rand -hex 32)
export ADMIN_TOKEN=$(openssl rand -hex 32)

# Start the server
PORT=8787 npm run ingest

# Deploy behind TLS reverse proxy (nginx, ELB, CloudFront)
# See SECURITY.md for complete production checklist
```

**Key differences from dev mode:**
- ✅ `DASHBOARD_TOKEN` & `ADMIN_TOKEN` **required** (not set = 503 Service Unavailable)
- ✅ **TLS/HTTPS** via reverse proxy (no direct exposure)
- ✅ Network isolation (VPC, security groups, firewall rules)
- 🔒 See [SECURITY.md](./SECURITY.md) for complete hardening guide

---

## 💡 Why AEP?

| Challenge | Solution |
|-----------|----------|
| **Multi-agent workflows are hard to debug** | Live causation DAG shows exactly which agent called what, when, and why |
| **Black-box agent behavior** | Structured event logs let you audit decisions and trace reasoning |
| **Distributed agent traces are fragmented** | Single trace ID ties together all agents, sub-agents, and tool calls |
| **Performance issues are invisible** | Metrics track latency, throughput, and error rates per agent |
| **Compliance auditing is manual** | Structured logs with signatures enable automated compliance checks |

---

## ✨ Core Features

**📋 Event Protocol**
- 12 structured event types: Task (created/completed/updated/failed), Tool (called/result), Memory (read/write), Handoff (started/completed), Error/Policy (raised/blocked)
- JSON Schema validation with AJV
- Distributed tracing via `trace_id` + `session_id` + `parent_session_id`
- HMAC-SHA256 event signing for authenticity

**🔌 Ingest API**
- High-throughput event ingestion with deduplication
- Automatic tenant isolation per API key
- Rate limiting + HMAC verification
- Returns 202 Accepted for async processing

**📊 Live Dashboard**
- Real-time causation DAG (shows call chains)
- Session timeline with event swim lanes
- Multi-agent workflow tree visualization
- Server-Sent Events (SSE) for instant updates
- Dark mode support

**⚙️ CLI Toolkit**
```bash
aep emit --type task.created --source agent://my-agent --session ses_123 --trace trc_456
aep session ses_123 --type task.created --q "search term"
aep export ses_123 --format json|csv --out export.json
npm run export -- --format jsonl|csv|parquet --compression none|gzip|brotli --sink local|s3 --all-tenants
aep workflow trc_456
aep validate events.json
```

**📈 Observability**
- Prometheus `/metrics` endpoint for monitoring
- Structured JSON logs with Pino
- Health checks (`/health`, `/ready`)
- Rejection logs with rejection reasons

**🔐 Security & Isolation**
- API key authentication (Bearer token format)
- Multi-tenant isolation (per-tenant scopes)
- Optional HMAC signing for event verification
- Dashboard token protection (dev mode optional)

---

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Dev | Prod |
|---|---|---|---|
| `PORT` | `8787` | Same | Same (behind TLS reverse proxy) |
| `DATABASE_PATH` | `./data/aep.db` | Local SQLite | Durable storage + backups |
| `DASHBOARD_TOKEN` | (unset) | Open (no auth) | **REQUIRED** |
| `ADMIN_TOKEN` | (unset) | Disabled | **REQUIRED** |
| `NODE_ENV` | (unset) | Optional | Set to `production` |

**Development mode:** Dashboard and read endpoints are open (rapid iteration, NOT for shared networks).  
**Production mode:** All endpoints require auth, must deploy behind TLS reverse proxy with strong tokens (`openssl rand -hex 32`).

See [AUTH.md](./AUTH.md) for auth setup, [SECURITY.md](./SECURITY.md) for hardening, and [SETUP.md](./SETUP.md) for troubleshooting.

---

## Docker

```bash
cp .env.example .env
# .env.example sets NODE_ENV=production, where the server fails closed:
# set DASHBOARD_TOKEN (and ADMIN_TOKEN) in .env or the dashboard returns 503
# and unauthenticated reads return 401.
docker compose up -d
```

To run the pre-built image directly (without Compose):

```bash
docker build -t aep-ingest .
docker run -p 8787:8787 \
  -e ADMIN_TOKEN=change-me \
  -e DASHBOARD_TOKEN=change-me \
  -v aep_data:/data \
  aep-ingest
```

---

## API Response Formats

Reference these common response structures when building clients and integrations.

**202 Accepted** — `POST /events` (async ingest)
```json
{ "accepted": true, "duplicate": false, "id": "evt_01HXYZ..." }
```

**200 OK** — `GET /sessions`
```json
{ "sessions": [ { "session_id": "ses_01HXYZ...", "created_at": "..." } ], "next_cursor": "..." }
```

**200 OK** — `GET /sessions/{sessionId}/events`
```json
{ "session_id": "ses_01HXYZ...", "events": [ { "id": "evt_...", "type": "task.created", ... } ] }
```

**200 OK** — `GET /sessions/{sessionId}/audit-bundle` and `GET /workflows/{traceId}/audit-bundle`
```json
{
  "aep_audit_version": "0.1.0",
  "manifest": { "scope": { "session_id": "ses_01HXYZ..." }, "event_count": 12, "content_digest": "…", "content_digest_alg": "sha256", "exported_at": "..." },
  "events": [ { "id": "evt_...", "type": "task.created", ... } ],
  "signature": { "alg": "hmac-sha256", "value": "…" }
}
```
Returns a tamper-evident, HMAC-signed audit bundle (Phase 14). Verify offline with `aep audit verify <bundle.json>`. Append `?format=pdf` for a human-readable PDF report rendering (the JSON bundle remains the verifiable artifact), or render locally with `aep audit render <bundle.json>`. Requires `AUDIT_SIGNING_SECRET` to be configured server-side, else **503**.

**400 Bad Request** — schema or validation failure
```json
{ "accepted": false, "errors": [ "/ must have required property 'session_id'", "/type must be one of: task.created, ..." ] }
```

**401 Unauthorized** — authentication failure (missing/invalid/revoked API key)
```json
{ "error": "Invalid API key" }
```
See [AUTH.md](./AUTH.md) for details on key authentication and scoping.

**403 Forbidden** — insufficient permissions
```json
{ "error": "Forbidden" }
```
Typically indicates cross-tenant access attempt or insufficient scopes for the requested operation.

---

## 📚 Documentation

| Resource | Purpose |
|----------|---------|
| **[OpenAPI Docs](http://localhost:8787/docs)** | Interactive API reference (Swagger UI) |
| **[openapi.json](http://localhost:8787/openapi.json)** | Machine-readable OpenAPI 3.1 spec |
| **[sdks/python/README.md](./sdks/python/README.md)** | Python SDK reference — install, quick start, API, exceptions |
| **[sdks/go/README.md](./sdks/go/README.md)** | Go SDK reference — install, quick start, API, CLI, examples |
| **[AUTH.md](./AUTH.md)** | API key management, tenant scoping, HMAC signing |
| **[CONTRIBUTING.md](./CONTRIBUTING.md)** | Development setup, code style, contribution workflow |
| **[SECURITY.md](./SECURITY.md)** | Threat model, vulnerability disclosure, production deployment checklist |
| **[SETUP.md](./SETUP.md)** | Installation, configuration, troubleshooting |
| **[OPERATIONS.md](./OPERATIONS.md)** | Operations & deployment: Postgres backend, projects/tiers/quotas, retention/pruning (cron + k8s CronJob), S3/cloud export (Phase 17) |
| **[CHANGELOG.md](./CHANGELOG.md)** | Version history (Phases 1–17) and breaking changes |
| **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** | Community standards and expectations |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────┐
│           Your Agents                    │
│  JS · Python SDK · CLI · raw HTTP        │
└────────────────┬─────────────────────────┘
                 │ POST /events { type, source, session_id, trace_id, … }
                 ↓
┌─────────────────────────────────┐
│     AEP Ingest Server           │
│  - Validate (JSON Schema)       │
│  - Authenticate (Bearer token)  │
│  - Deduplicate (UUID + time)    │
│  - Sign (HMAC-SHA256)           │
│  - Store (SQLite)               │
└────────┬────────────────────────┘
         │
         ↓ Real-time SSE
┌─────────────────────────────────┐
│     Live Dashboard              │
│  - Session timeline             │
│  - Causation DAG                │
│  - Workflow tree                │
│  - Metrics/rejection logs       │
└─────────────────────────────────┘
```

**Key Guarantees:**
- ✅ **Causation chains**: trace_id + parent_session_id preserve call hierarchy
- ✅ **Deduplication**: event UUID + timestamp prevent double-processing
- ✅ **Authenticity**: HMAC signatures verify event origin
- ✅ **Tenant isolation**: API keys scoped to tenants; cross-tenant access rejected
- ✅ **Real-time visibility**: SSE updates push to dashboard instantly

---

## 🧪 Testing

**JavaScript server (Node.js) — 82 tests**
```bash
npm test                  # full suite (55 unit + 27 integration)
npm run test:unit         # 55 unit tests (event protocol, validation, CLI)
npm run test:integration  # 27 integration tests (HTTP server flow)
npm run lint              # ESLint checks
```

**Python SDK — 118 tests**
```bash
cd sdks/python
pip install -e ".[dev]"
pytest tests/unit/        # 107 unit tests (no server needed)
pytest tests/integration/ # 11 integration tests (auto-skip if server is down)
```

**Go SDK — 80+ tests**
```bash
cd sdks/go
go test ./...            # 69+ unit tests + 11 integration tests (auto-skip if server is down)
```

**Test Coverage:**
- ✅ Event protocol validation, creation, signing (all 12 event types)
- ✅ JSON Schema validation with payload schema caching + TTL
- ✅ API endpoints (auth, rate limiting, deduplication, exports)
- ✅ Client libraries (sync + async, error handling, timeouts)
- ✅ Multi-tenant isolation (per-API-key scoping)
- ✅ HMAC-SHA256 signing and verification (constant-time)
- ✅ CLI argument parsing and command behavior
- ✅ Dashboard functionality (SSE, filtering, exports)

---

## 🤝 Contributing

We welcome contributions! Here's how:

1. **Fork** the repo
2. **Create a feature branch** (`git checkout -b feature/my-feature`)
3. **Make your changes** and write tests
4. **Lint & test** (`npm run lint:fix && npm test`)
5. **Commit** with clear messages
6. **Push** and open a Pull Request

**Areas we're looking for help:**
- 📱 Mobile dashboard (React Native)
- 📈 Advanced metrics & analytics
- 🌍 Internationalization
- 📚 Docs & tutorials

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines.

---

## ❓ Getting Help

- **Questions?** Open an [issue](https://github.com/surpradhan/agent-event-protocol/issues) with the `question` label or start a [discussion](https://github.com/surpradhan/agent-event-protocol/discussions)
- **Found a bug?** Submit an [issue](https://github.com/surpradhan/agent-event-protocol/issues) with steps to reproduce
- **Security issue?** See [SECURITY.md](./SECURITY.md) for responsible disclosure
- **Have an idea?** Start a [discussion](https://github.com/surpradhan/agent-event-protocol/discussions) or open a feature request
- **Community standards?** Check out our [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

---

## 📄 License

MIT License: see [LICENSE](./LICENSE) for details.

---

## 🔮 Roadmap

- [x] JavaScript/TypeScript — Server + dashboard + CLI + docs
- [x] Python SDK — [`sdks/python/`](sdks/python/) · sync + async clients, validator, HMAC signing, demo
- [x] Go SDK — [`sdks/go/`](sdks/go/) · sync + async clients, validator, HMAC signing, CLI, demo
- [x] Node.js / TypeScript SDK core — [`sdks/node/`](sdks/node/) · `@surpradhan/aep` · event factory, validator, HMAC signing (cross-language parity), `fetch` client, dual ESM+CJS (Phase 12g PR1)
- [x] Kubernetes operator — [`operator/`](operator/) · `AgentInstrumentation` CRD, sidecar-injection webhook, Helm chart
- [x] OTEL (OpenTelemetry) bridge — [`sdks/python/aep/otel/`](sdks/python/aep/otel/) · span-to-event mapper + `AEPSpanExporter`
- [x] OTEL Collector plugin — [`otelbridge/`](otelbridge/) · Collector exporter (span → AEP event) + ocb build config + demo
- [x] **LangGraph auto-instrumentation** — [`aep.instrument()`](sdks/python/aep/instrument.py) · zero-code patching for LangGraph workflows
- [x] **CrewAI auto-instrumentation** — [`aep.instrument()`](sdks/python/aep/instrument.py) · zero-code event-bus subscription for CrewAI crews (Phase 12c)
- [x] **AutoGen auto-instrumentation** — [`aep.instrument()`](sdks/python/aep/instrument.py) · zero-code `run_stream` tap for AutoGen AgentChat teams (Phase 12d)
- [x] **OpenAI Agents SDK auto-instrumentation** — [`aep.instrument()`](sdks/python/aep/instrument.py) · zero-code tracing-processor registration for `Runner.run` (Phase 12e)
- [x] **Anthropic Claude Agent SDK auto-instrumentation** — [`aep.instrument()`](sdks/python/aep/instrument.py) · zero-code hook injection for `query()` / `ClaudeSDKClient` (Phase 12f)
- [x] **Node.js / LangChain.js auto-instrumentation** — [`instrument()`](sdks/node/src/instrument.ts) · zero-code `CompiledStateGraph` callback injection for LangGraph (Phase 12g PR2)
- [x] **Vercel AI SDK** — docs-only path through the OTEL bridge: `experimental_telemetry` → OTEL Collector → [`otelbridge/`](otelbridge/) AEP exporter (see [`docs/integrations/vercel-ai-sdk.md`](docs/integrations/vercel-ai-sdk.md))
- [x] Advanced filtering & visualization in dashboard (Phase 15)
- [x] Webhook integration for alerts (Phase 16)
- [x] S3/cloud export for long-term storage (Phase 17: JSONL/CSV/Parquet, gzip/brotli, local + S3 sink, export-before-prune)

---

**Made with ❤️ for the AI agent community** · [Star us on GitHub!](https://github.com/surpradhan/agent-event-protocol)
