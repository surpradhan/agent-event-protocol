# Agent Event Protocol (AEP)

> **Structured observability for AI agent systems** — capture, trace, and debug agent workflows in real time with a self-hosted event protocol, ingest API, and live dashboard.

[![CI](https://github.com/your-org/aep/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/aep/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## What is AEP?

As AI agents become more capable — and more complex — understanding what they're actually doing in production becomes critical. AEP is a lightweight, open protocol that gives you **full visibility into agent execution**: what tasks ran, which tools were called, when handoffs occurred between agents, and where things went wrong.

It defines a common **event envelope schema**, an **HTTP ingest pipeline**, and a set of **APIs and tooling** that let you observe, trace, and debug agent executions in real time — without changing how your agents are orchestrated.

**AEP is purely an observability layer.** It doesn't run your agents or change their behaviour. You emit events; AEP captures, validates, and visualises them.

---

## How it works

```
Your agent(s)
     │
     │  POST /events  (JSON event envelope)
     ▼
 AEP Ingest Server
     │  validates · deduplicates · stores
     ▼
  SQLite DB ──► REST APIs ──► Dashboard (live)
                          └──► CLI tools
                          └──► Prometheus metrics
```

Events carry a standard envelope (`session_id`, `trace_id`, `type`, `payload`, ...) that AEP uses to reconstruct session timelines, causation chains, and multi-agent workflow trees.

---

## Quick Start

**Requirements:** Node.js 20+

```bash
# 1. Install dependencies
npm install

# 2. Start the ingest server (dev mode — no auth required)
npm run ingest

# 3. In a second terminal, emit a sample event
npm run emit:example

# 4. Open the dashboard
open http://localhost:8787/dashboard
```

That's it. You'll see your event appear in the live dashboard within milliseconds.

**Want to try a realistic agent workflow?** Run one of the built-in demos:

```bash
npm run demo:support    # support ticket triage agent
npm run demo:itops      # IT ops incident response agent
npm run demo:research   # research & synthesis agent
npm run demo:subagent   # orchestrator + 3 parallel sub-agents
```

---

## Features

### Protocol & validation
- JSON Schema event envelope (v0.2.0) with 12 core event types across 5 categories: Task, Tool, Memory, Handoff, Error/Policy
- `createEvent` factory utility — auto-generates IDs, timestamps, and validates on construction
- Optional per-payload schema validation via `payload.$schema`
- Multi-agent support via `parent_session_id` and `agent_role` fields (`orchestrator` / `subagent` / `standalone`)

### Ingest API
- `POST /events` with schema validation, deduplication by event ID, and HMAC-SHA256 signature verification (opt-in per API key)
- At-least-once delivery; duplicates detected atomically via SQLite unique index
- Per-API-key rate limiting (`RATE_LIMIT_RPM`, default 300 req/min) with `X-RateLimit-*` headers
- Cursor-based pagination on all list endpoints

### Dashboard
- Live session timeline with event type colour-coding and replay controls
- **Causation DAG** — SVG graph of events linked by `causation_id`, with cross-session edge support
- **Workflow tree** — collapsible multi-agent session hierarchy grouped by `trace_id`
- Real-time push via Server-Sent Events (no polling)
- One-click export to JSON or CSV

### Observability
- `GET /metrics/prometheus` — Prometheus text format with event counters, per-type breakdowns, HTTP latency histograms
- Structured JSON logging via pino (`LOG_LEVEL` / `LOG_PRETTY`)
- `GET /health` (liveness) and `GET /ready` (readiness) probes — both check DB connectivity

### Developer experience
- **`aep` CLI** — `emit`, `session`, `export`, `workflow`, and `validate` commands
- **OpenAPI 3.1 spec** at `GET /openapi.json`; interactive Swagger UI at `GET /docs`
- **82-test suite** (55 unit + 27 integration) using Node's built-in test runner — no extra dependencies
- GitHub Actions CI on Node 20 and 22

### Production-ready
- API key auth with tenant isolation on all endpoints
- Docker: multi-stage `Dockerfile` (node:20-alpine) + `docker-compose.yml` with named SQLite volume
- Graceful shutdown — `SIGTERM`/`SIGINT` drains in-flight requests and closes DB before exit
- `.env.example` with every variable documented

---

## Requirements

- Node.js 20+ (tested on Node 20 and 22)

---

## Setup

```bash
npm install
```

### Environment variables

A fully-documented template is provided in `.env.example`. Copy it to `.env` before any network-accessible deployment.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | TCP port the server listens on |
| `DATABASE_PATH` | `./data/aep.db` | Path to the SQLite database file |
| `ADMIN_TOKEN` | *(unset)* | Secret for `/admin/*` key-management endpoints. If unset, admin routes return 503. |
| `DASHBOARD_TOKEN` | *(unset)* | Secret for dashboard access and read endpoints. If unset, all reads are open (dev mode). |
| `LOG_LEVEL` | `info` | Pino log level: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `LOG_PRETTY` | `false` | Set to `true` for human-readable logs (requires `pino-pretty`; dev only) |
| `RATE_LIMIT_RPM` | `300` | Max ingest requests per API key per minute. Set to `0` to disable. |

---

## Running the server

**Dev mode** (no auth required on read endpoints):
```bash
npm run ingest
```

**With auth enabled** (recommended for any network-accessible deployment):
```bash
ADMIN_TOKEN=change-me DASHBOARD_TOKEN=change-me npm run ingest
```

Once `ADMIN_TOKEN` is set, generate an API key before emitting events:
```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"my-org","label":"dev key","scopes":["read","write"]}'
```

The response includes the raw key (shown once only). Pass it on subsequent requests:
```bash
# Ingest an event
curl -X POST http://localhost:8787/events \
  -H "Authorization: Bearer aep_<key>" \
  -H "Content-Type: application/json" \
  -d @my-event.json

# Read sessions
curl http://localhost:8787/sessions \
  -H "Authorization: Bearer aep_<key>"
```

See [AUTH.md](./AUTH.md) for the full auth reference, including HMAC signing setup.

**Health check** (no auth required):
```bash
curl http://localhost:8787/health
```

**Dashboard:**
```bash
# Dev mode (no auth)
open http://localhost:8787/dashboard

# With DASHBOARD_TOKEN set
open "http://localhost:8787/dashboard?token=change-me"
```

---

## Docker

```bash
# Copy and configure environment
cp .env.example .env   # fill in ADMIN_TOKEN, DASHBOARD_TOKEN, etc.

# Start with Docker Compose
docker compose up -d
docker compose logs -f aep
```

The compose file mounts a named volume (`aep_data`) for SQLite, maps port 8787 (overridable via `HOST_PORT`), and configures a `HEALTHCHECK` that polls `GET /health`.

**Build and run the image directly:**
```bash
docker build -t aep-ingest .
docker run -p 8787:8787 \
  -e ADMIN_TOKEN=change-me \
  -e DASHBOARD_TOKEN=change-me \
  -v aep_data:/data \
  aep-ingest
```

---

## Testing

Run the full suite (unit + integration):
```bash
npm test
```

Run individually:
```bash
npm run test:unit         # 55 tests — validator, createEvent, coreEventTypes
npm run test:integration  # 27 tests — all HTTP endpoints
```

Tests use Node.js's built-in `node:test` runner — no extra test dependencies. The integration suite spins up an isolated in-memory database and ephemeral server port, so it never touches `data/aep.db`.

CI runs automatically on every push and pull request via `.github/workflows/ci.yml` (Node 20 and 22 matrix).

---

## CLI (`aep`)

After `npm install`, the `aep` binary is available via `npx aep` or (after `npm link`) as a global `aep` command.

```bash
aep --help              # global usage
aep <command> --help    # per-command help
```

### aep emit
Emit a single event to the ingest server:
```bash
aep emit \
  --type task.created \
  --source agent://my-agent \
  --session ses_abc \
  --trace trc_xyz \
  --key $AEP_API_KEY \
  --payload '{"task":"Summarise report"}'
```

Optional flags: `--id`, `--time`, `--role` (agent_role), `--parent` (parent_session_id), `--subject`, `--cause` (causation_id), `--idem` (idempotency_key), `--labels <json>`, `--server <url>`.

### aep session
Print the event timeline for a session:
```bash
aep session ses_abc --key $AEP_API_KEY
aep session ses_abc --type tool.called --key $AEP_API_KEY
aep session ses_abc --q "web_search" --key $AEP_API_KEY
```

### aep export
Export session events to stdout or a file:
```bash
aep export ses_abc --format csv --out events.csv --key $AEP_API_KEY
aep export ses_abc --format json --key $AEP_API_KEY
```

### aep workflow
Fetch and print the full multi-agent workflow tree for a `trace_id`:
```bash
aep workflow trc_xyz --key $AEP_API_KEY
```

### aep validate
Validate a local event JSON file (single event or array):
```bash
aep validate examples/sample-event.json
# exit 0 on success, exit 2 on validation failure
```

Global flags available on all commands: `--server <url>` (default `http://localhost:8787`), `--key <api-key>`. Both can also be set via `AEP_SERVER` and `AEP_API_KEY` environment variables.

---

## API Reference

Interactive docs are available at runtime: open `http://localhost:8787/docs` for Swagger UI, or `GET /openapi.json` for the raw OpenAPI 3.1 spec.

Authentication requirements are shown in brackets: `[key:write]` = API key with write scope; `[key:read or dash]` = API key with read scope OR dashboard token; `[admin]` = `ADMIN_TOKEN` bearer; `[none]` = no auth.

### Event ingest
- `POST /events` **[key:write]** — ingest a single event (validated, deduplicated, HMAC-verified if key has a signing secret)

### Sessions
- `GET /sessions` **[key:read or dash]** — paginated session list (tenant-scoped). Query: `?limit=<1-500>`, `?cursor=<token>`
- `GET /sessions/:sessionId/events` **[key:read or dash]** — ordered event timeline. Query: `?type`, `?q`, `?limit=<1-1000>`, `?cursor`
- `GET /sessions/:sessionId/tree` **[key:read or dash]** — session and all descendants as a recursive tree
- `GET /sessions/:sessionId/export?format=json|csv` **[key:read or dash]** — export filtered events

### Workflows (multi-agent traces)
- `GET /workflows/:traceId` **[key:read or dash]** — all sessions sharing a `trace_id`, assembled into a hierarchy via `parent_session_id`

### Real-time stream
- `GET /stream` **[key:read or dash]** — Server-Sent Events. Delivers `event.received` frames within milliseconds of ingest. Emits `connected` on handshake and `: heartbeat` every 15 seconds.

### Metrics
- `GET /metrics` **[key:read or dash]** — counters and aggregates (tenant-scoped): received, accepted, rejected, duplicates, by-type breakdown, session/workflow counts, max tree depth
- `GET /metrics/prometheus` **[none]** — Prometheus text format 0.0.4. Unauthenticated so scrapers can reach it — restrict at the network layer if needed.

### Admin — key management
- `POST /admin/keys` **[admin]** — generate a new API key. Body: `{ tenantId, label?, scopes?, hmacSecret? }`
- `GET /admin/keys` **[admin]** — list all keys (raw keys and secrets never returned)
- `DELETE /admin/keys/:id` **[admin]** — revoke a key immediately

### API docs
- `GET /openapi.json` **[none]** — OpenAPI 3.1 specification
- `GET /docs` **[none]** — Swagger UI

### Health
- `GET /health` **[none]** — liveness probe. Returns `{ ok, service, version, checks: { db } }`. HTTP 503 if DB unreachable.
- `GET /ready` **[none]** — readiness probe. HTTP 200 only when DB is connected and migrations have run. Use for Kubernetes `readinessProbe` / load-balancer health checks.

---

## Dashboard

### Sessions view
- Event type filter and free-text search across IDs, types, and payloads
- Replay controls (`Prev`, `Autoplay`, `Next`) for step-by-step walkthrough
- One-click export to JSON or CSV
- **Causation DAG** — SVG graph of events linked by `causation_id`, laid out using longest-path topological ordering (roots left, caused events flow right). Cross-session causation edges appear as dashed stubs labelled "↗ cross-session". Clicking any node syncs the replay position.

### Workflows view
- Groups all sessions by `trace_id` and renders a collapsible nested tree
- Each node shows session ID, `agent_role` badge, event count, and age
- Clicking a node navigates to that session in the Sessions view

### Real-time updates
- Persistent `EventSource('/stream')` SSE connection replaces polling
- Live status pill (green pulsing dot) shows connection health
- Metric counters update optimistically; the active session timeline refreshes automatically

### Event type colour scheme

| Category | Types | Colour |
|---|---|---|
| Task | `task.created`, `task.updated`, `task.completed`, `task.failed` | Blue family |
| Tool | `tool.called`, `tool.result` | Purple family |
| Memory | `memory.read`, `memory.write` | Orange family |
| Handoff | `handoff.started`, `handoff.completed` | Teal family |
| Error / Policy | `error.raised`, `policy.blocked` | Red family |

---

## Persistence

Events and session metadata are stored in SQLite at `data/aep.db` (created automatically on first run). All data survives server restarts.

To use a custom path:
```bash
DATABASE_PATH=/var/data/aep.db npm run ingest
```

The schema is managed by a versioned migration system in `src/db/migrations/`. Pending migrations are applied automatically on startup. To add a new migration, drop a `NNN_description.js` file into that directory.

**Delivery semantics:** at-least-once. Deduplication is enforced by a unique index on `events.id` in SQLite — duplicates are detected atomically without a prior read.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full version history and migration guides.
