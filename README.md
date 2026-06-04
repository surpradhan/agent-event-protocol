# 🤖 Agent Event Protocol (AEP)

> Structured observability for AI agent systems: capture, trace, and debug agent workflows in real time.

[![GitHub](https://img.shields.io/badge/GitHub-surpradhan/agent--event--protocol-blue?logo=github)](https://github.com/surpradhan/agent-event-protocol)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Tests: 200+](https://img.shields.io/badge/tests-200%2B-brightgreen)](#testing)

**Stop flying blind with AI agents.** AEP is a lightweight, structured observability framework for multi-agent systems. Capture causation chains, debug orchestration logic, visualize agent workflows: all in real time.

Perfect for:
- 🎯 **Orchestrators** managing multiple agents and sub-agents
- 🔍 **Researchers** studying agent behavior and decision trees
- 🏢 **Enterprises** auditing agent actions for compliance
- 👨‍💻 **Developers** debugging complex agentic systems

---

## 🚀 Quick Start (2 minutes)

**Requirements:** Node.js 20+

### Local Development (No Auth)

```bash
# 1. Clone & install
git clone https://github.com/surpradhan/agent-event-protocol.git
cd agent-event-protocol
npm install

# 2. Start the ingest server
npm run ingest

# 3. In another terminal: emit a sample event
npm run emit:example

# 4. Open the live dashboard (no auth required in dev mode)
open http://localhost:8787/dashboard
```

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
with AEPClient() as client:
    print(client.emit(event))
EOF

# Run the multi-agent research demo
python sdks/python/demos/subagent_research.py
```

See [`sdks/python/README.md`](sdks/python/README.md) for the full Python SDK reference.

### Go SDK

```bash
# Add to go.mod (or use github.com/surpradhan/aep-go)
go get github.com/surpradhan/aep-go

# Emit an event
package main
import (
    "context"
    "log"
    "github.com/surpradhan/aep-go/aep"
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
    defer client.Close()
    
    resp, err := client.Emit(context.Background(), event)
    if err != nil {
        log.Fatal(err)
    }
    log.Printf("Emitted: %s", resp.ID)
}
```

See [`sdks/go/README.md`](sdks/go/README.md) for the full Go SDK reference.

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
docker compose up -d
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
| **[CHANGELOG.md](./CHANGELOG.md)** | Version history (Phases 1-11) and breaking changes |
| **[PRD.md](./PRD.md)** | Product vision, roadmap, and success metrics (Phases 12+) |
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
- 🔌 OpenTelemetry Collector plugin (receiver + exporter) — builds on the shipped SDK bridge
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
- [x] Kubernetes operator — [`operator/`](operator/) · `AgentInstrumentation` CRD, sidecar-injection webhook, Helm chart
- [x] OTEL (OpenTelemetry) bridge — [`sdks/python/aep/otel/`](sdks/python/aep/otel/) · span-to-event mapper + `AEPSpanExporter` (Collector plugin in progress)
- [ ] Advanced filtering & visualization in dashboard
- [ ] Webhook integration for alerts
- [ ] S3/cloud export for long-term storage

---

**Made with ❤️ for the AI agent community** · [Star us on GitHub!](https://github.com/surpradhan/agent-event-protocol)
