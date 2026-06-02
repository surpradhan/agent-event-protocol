# 🤖 Agent Event Protocol (AEP)

> Structured observability for AI agent systems: capture, trace, and debug agent workflows in real time.

[![GitHub](https://img.shields.io/badge/GitHub-surpradhan/agent--event--protocol-blue?logo=github)](https://github.com/surpradhan/agent-event-protocol)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Tests: 92/92](https://img.shields.io/badge/tests-92%2F92-brightgreen)](#testing)

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

| Variable | Default | Dev Behavior | Prod Behavior |
|---|---|---|---|
| `PORT` | `8787` | Same port | Same port (behind reverse proxy with TLS) |
| `DATABASE_PATH` | `./data/aep.db` | Local SQLite | Should use durable storage + backups |
| `DASHBOARD_TOKEN` | *(unset)* | Dashboard open (no auth) | **REQUIRED**: 503 if unset |
| `ADMIN_TOKEN` | *(unset)* | `/admin/*` disabled | **REQUIRED**: 503 if unset |
| `NODE_ENV` | *(unset)* | Optional | Set to `production` for structured logging |

**Development mode** (all tokens unset):
- Dashboard and read endpoints are open
- Good for rapid iteration and demos
- NOT suitable for shared/untrusted networks

**Production mode** (all tokens set):
- Dashboard requires authentication
- Admin endpoints require authentication
- Must deploy behind TLS reverse proxy
- Must configure strong tokens (use `openssl rand -hex 32`)

See [AUTH.md](./AUTH.md) for auth setup, [SECURITY.md](./SECURITY.md) for production hardening, and [CHANGELOG.md](./CHANGELOG.md) for version history.

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
| **[AUTH.md](./AUTH.md)** | API key management, tenant scoping, HMAC signing |
| **[CONTRIBUTING.md](./CONTRIBUTING.md)** | Development setup, code style, contribution workflow |
| **[SECURITY.md](./SECURITY.md)** | Security guarantees, vulnerability disclosure, deployment checklist |
| **[CHANGELOG.md](./CHANGELOG.md)** | Version history and breaking changes |
| **[SETUP.md](./SETUP.md)** | Detailed installation, configuration, troubleshooting |
| **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** | Community standards and expectations |

---

## 🏗️ Architecture

```
┌─────────────────┐
│  Your Agents    │ emit events via HTTP/CLI
└────────┬────────┘
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

```bash
npm test                  # full suite (92 tests)
npm run test:unit         # 87 unit tests (event protocol, validation, CLI)
npm run test:integration  # 5 integration tests (HTTP server flow)
npm run lint              # ESLint checks
```

**Test Coverage:**
- ✅ Event protocol validation (14 types × 3 scenarios)
- ✅ CLI argument parsing (parseArgs with flags, positionals, combinations)
- ✅ API endpoint behavior (auth, rate limiting, validation)
- ✅ Dashboard functionality (SSE, filters, exports)
- ✅ Multi-tenant isolation (tenant_id enforcement)
- ✅ Error handling (graceful degradation)

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
- 🔗 Agent SDK integrations (Python, Go, etc.)
- 📈 Advanced metrics & analytics
- 🌍 Internationalization
- 🐳 Kubernetes operator
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

- [ ] Python SDK (`pip install aep`)
- [ ] Go SDK (`go get github.com/surpradhan/aep-go`)
- [ ] Kubernetes operator for automatic instrumentation
- [ ] OTEL (OpenTelemetry) bridge
- [ ] Advanced filtering & visualization in dashboard
- [ ] Webhook integration for alerts
- [ ] S3/cloud export for long-term storage

---

**Made with ❤️ for the AI agent community** · [Star us on GitHub!](https://github.com/surpradhan/agent-event-protocol)
