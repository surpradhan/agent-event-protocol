# AEP MVP

Minimal reference implementation for AEP v0.2:
- envelope validation (JSON Schema + core event type gate + optional payload schema validation)
- event factory utility
- HTTP ingest endpoint with id dedupe
- session/metrics APIs for demo observability
- browser dashboard with session timelines, causation DAG, workflow tree view, and real-time SSE updates
- **`aep` CLI** with `emit`, `session`, `export`, `workflow`, and `validate` commands
- **OpenAPI 3.1 spec** at `GET /openapi.json` with Swagger UI at `GET /docs`
- **82-test suite** (unit + integration) with GitHub Actions CI
- four concrete demos: support agent, IT ops agent, research agent, and a multi-agent sub-agent demo
- **API key auth** with tenant isolation on all ingest and read endpoints
- **HMAC-SHA256 signature verification** on ingest (opt-in per key)
- **Dashboard auth gate** — token-protected UI with sessionStorage-based session persistence
- **Cursor-based pagination** on `GET /sessions` and `GET /sessions/:id/events` (`?limit` + `?cursor`, opaque `next_cursor` in responses)
- **Per-API-key rate limiting** on the ingest endpoint (`RATE_LIMIT_RPM`, default 300 req/min) with `X-RateLimit-*` headers
- **Graceful shutdown** — `SIGTERM`/`SIGINT` drains in-flight requests and closes DB cleanly before exit
- **Docker** — multi-stage `Dockerfile` (node:20-alpine) + `docker-compose.yml` with named SQLite volume
- **`.env.example`** — every configuration variable documented with type, default, and production guidance
- **Prometheus metrics** at `GET /metrics/prometheus` — event counters, per-type breakdown, HTTP request counts, and latency histograms
- **Structured JSON logging** via pino — all log lines include `service`, `method`, `path`, `status` context; level controlled by `LOG_LEVEL`
- **Enhanced health probes** — `GET /health` checks DB connectivity (HTTP 503 if degraded); `GET /ready` verifies schema migrations have run

## Requirements
- Node.js 20+ (tested with Node 20 and 22)

## Setup
```bash
npm install
```

## Environment variables

A fully-documented template is provided in `.env.example`. Copy it to `.env` before production use.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | TCP port the server listens on |
| `DATABASE_PATH` | `./data/aep.db` | Path to the SQLite database file |
| `ADMIN_TOKEN` | *(unset)* | Secret for `/admin/*` key-management endpoints. If unset, admin routes return 503. |
| `DASHBOARD_TOKEN` | *(unset)* | Secret for dashboard access and read endpoints. If unset, all reads are open (dev mode). |
| `LOG_LEVEL` | `info` | Pino log level: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `LOG_PRETTY` | `false` | Set to `true` for human-readable logs (requires `pino-pretty`; dev only) |
| `RATE_LIMIT_RPM` | `300` | Max ingest requests per API key per minute. Set to `0` to disable. |

## Testing

Run the full test suite (unit + integration):
```bash
npm test
```

Run suites individually:
```bash
npm run test:unit         # 55 tests — validator, createEvent, coreEventTypes
npm run test:integration  # 27 tests — all HTTP endpoints
```

Tests use Node.js's built-in `node:test` runner — no additional test dependencies. The integration suite spins up an isolated in-memory database and an ephemeral server port so it never touches `data/aep.db`.

CI runs automatically on every push and pull request via `.github/workflows/ci.yml` (Node 20 and 22 matrix).

## CLI (`aep`)

After `npm install`, the `aep` binary is available via `npx aep` or, after `npm link`, as a global `aep` command.

```bash
aep --help                # global usage
aep <command> --help      # per-command help
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

## API Documentation

An interactive OpenAPI 3.1 spec is available at runtime:

```
GET /openapi.json   — machine-readable spec (no auth required)
GET /docs           — Swagger UI (served via CDN, no auth required)
```

## Validate event JSON
```bash
npm run validate -- ./examples/sample-event.json
```

## Run ingest API

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
# Ingest
curl -X POST http://localhost:8787/events \
  -H "Authorization: Bearer aep_<key>" \
  -H "Content-Type: application/json" \
  -d @my-event.json

# Read
curl http://localhost:8787/sessions \
  -H "Authorization: Bearer aep_<key>"
```

See [AUTH.md](./AUTH.md) for the full auth reference, including HMAC signing setup.

Health check (no auth required):
```bash
curl http://localhost:8787/health
```

Dashboard (pass `?token=<DASHBOARD_TOKEN>` if auth is enabled):
```bash
http://localhost:8787/dashboard
# or, with token:
http://localhost:8787/dashboard?token=change-me
```

## Docker

A production-ready Docker setup is included.

**Build and start with compose:**
```bash
cp .env.example .env          # fill in ADMIN_TOKEN, DASHBOARD_TOKEN, etc.
docker compose up -d
docker compose logs -f aep    # tail structured JSON logs
```

The compose file mounts a named Docker volume (`aep_data`) for the SQLite database, maps the container's port 8787 to the host (overridable via `HOST_PORT` in `.env`), and configures a `HEALTHCHECK` that polls `GET /health`.

**Build the image directly:**
```bash
docker build -t aep-ingest .
docker run -p 8787:8787 \
  -e ADMIN_TOKEN=change-me \
  -e DASHBOARD_TOKEN=change-me \
  -v aep_data:/data \
  aep-ingest
```

## Emit a sample event
In a separate terminal while ingest is running:
```bash
npm run emit:example
```

## Run Concrete Agent Demos
In a separate terminal while ingest is running:

```bash
npm run demo:support
npm run demo:itops
npm run demo:research
npm run demo:subagent
```

Each demo emits a realistic event chain with shared `session_id` and `trace_id`:
- **support**: ticket triage, KB lookup, tool calls, resolution — `agent_role: standalone`
- **itops**: incident triage, metric check, policy block, handoff — `agent_role: standalone`
- **research**: search workflow, synthesis memory write, report completion — `agent_role: standalone`
- **subagent**: orchestrator spawning parallel web, arXiv, and patent retrieval sub-agents — demonstrates `agent_role: orchestrator/subagent` and `parent_session_id` linkage; after emitting events the demo calls `GET /sessions/:id/tree`, `GET /workflows/:traceId`, and `GET /metrics` to verify the server reconstructs the hierarchy correctly

## API Endpoints

Authentication requirements are shown in brackets. `[key:write]` = API key with write scope, `[key:read or dash]` = API key with read scope OR dashboard token (full access), `[admin]` = `ADMIN_TOKEN` bearer, `[none]` = no auth.

### Event ingest
- `POST /events` **[key:write]** — ingest a single event (validated, deduplicated). Verifies HMAC-SHA256 signature if the key has a signing secret configured.

### Sessions
- `GET /sessions` **[key:read or dash]** — paginated session list filtered to the caller's tenant. Query params: `?limit=<1-500>` (default 50), `?cursor=<token>`. Response includes `next_cursor` (null when exhausted).
- `GET /sessions/:sessionId/events` **[key:read or dash]** — ordered event timeline, tenant-scoped. Query params: `?type=<eventType>`, `?q=<searchText>`, `?limit=<1-1000>` (default 100), `?cursor=<token>`. Response includes `next_cursor`.
- `GET /sessions/:sessionId/tree` **[key:read or dash]** — the session and all of its descendants as a recursive tree. Shape: `{ session, children: [{ session, children: [...] }] }`
- `GET /sessions/:sessionId/export?format=json|csv` **[key:read or dash]** — export filtered session events

### Workflows (multi-agent traces)
- `GET /workflows/:traceId` **[key:read or dash]** — all sessions sharing a `trace_id`, assembled into a tree using `parent_session_id`. Shape: `{ trace_id, session_count, tree: [{ session, children: [...] }] }`

### Real-time stream
- `GET /stream` **[key:read or dash]** — Server-Sent Events endpoint. Delivers an `event.received` frame within milliseconds of every accepted ingest. Tenant-scoped: keys only receive events for their tenant; dashboard token receives all. Also emits `connected` on handshake and `: heartbeat` every 15 seconds.

### Metrics
- `GET /metrics` **[key:read or dash]** — counters and session/workflow aggregates, scoped to the caller's tenant. Fields: `received`, `accepted`, `rejected`, `duplicates`, `byType`, `session_count`, `workflow_count`, `subagent_session_count`, `max_tree_depth`.
- `GET /metrics/prometheus` **[none]** — Prometheus text format (0.0.4). Exports event counters, per-type breakdown, HTTP request counts and latency histograms. Unauthenticated so scrapers can reach it without an API key — restrict at the network layer if needed.

### Admin — key management
- `POST /admin/keys` **[admin]** — generate a new API key. Body: `{ tenantId, label?, scopes?, hmacSecret? }`
- `GET /admin/keys` **[admin]** — list all keys (raw keys and secrets are never returned)
- `DELETE /admin/keys/:id` **[admin]** — revoke a key immediately

### API documentation
- `GET /openapi.json` **[none]** — OpenAPI 3.1 specification document (JSON)
- `GET /docs` **[none]** — Swagger UI (rendered from CDN against `/openapi.json`)

### Health
- `GET /health` **[none]** — liveness probe. Returns `{ ok, service, version, checks: { db } }`. HTTP 200 when healthy; HTTP 503 if the database is unreachable.
- `GET /ready` **[none]** — readiness probe. Returns HTTP 200 only when the DB is connected and migrations have run. Use this for Kubernetes `readinessProbe` / load-balancer health checks.

## Dashboard Features

### Sessions view
- Event type filter and free-text search across IDs/types/payloads
- Replay controls (`Prev`, `Autoplay`, `Next`) for step-by-step walkthrough
- One-click session export to JSON or CSV
- **Causation DAG** — a second sub-tab renders an SVG graph of events linked by `causation_id`.
  Layout uses longest-path topological ordering (roots on the left, caused events flow right).
  Cross-session causation edges (where `causation_id` points outside the current session) are shown
  as dashed stubs labelled "↗ cross-session". Clicking any node shows its details and syncs the
  replay position so switching back to the timeline highlights the same event.

### Workflows view
- A second top-level tab groups all sessions by `trace_id` and fetches `GET /workflows/:traceId`.
- Renders a collapsible nested tree: each node shows session ID, `agent_role` badge, event count,
  and age. Clicking a node navigates to that session in the Sessions view.
- Parent → child nesting directly represents cross-session causation
  (the `parent_session_id` / `handoff.started` relationship).

### Auth gate
- If `DASHBOARD_TOKEN` is configured, an overlay prompts for the token on first load. The token is stored in `sessionStorage` and sent as `Authorization: Bearer` on all subsequent API calls (including the SSE connection and file exports).
- If `DASHBOARD_TOKEN` is not set, the dashboard is open — suitable for local development only.

### Real-time updates
- Replaces 5-second polling with a persistent `EventSource('/stream')` SSE connection.
- A live status pill (green pulsing dot / "Live" label) shows connection health.
- Received/accepted metric counters update optimistically on each incoming frame; the active
  session timeline refreshes automatically when a new event arrives for it.

### Event type colour scheme
All 12 core event types have distinct colour palettes in both the timeline (left-border accent +
badge) and the causation DAG (node fill/stroke/text):

| Category | Types | Colour |
|---|---|---|
| Task | `task.created`, `task.updated`, `task.completed`, `task.failed` | Blue family |
| Tool | `tool.called`, `tool.result` | Purple family |
| Memory | `memory.read`, `memory.write` | Orange family |
| Handoff | `handoff.started`, `handoff.completed` | Teal family |
| Error / Policy | `error.raised`, `policy.blocked` | Red family |

## Persistence

Events and session metadata are stored in a SQLite database at `data/aep.db` (created automatically on first run). All data survives server restarts.

To use a custom path, set `DATABASE_PATH` before starting the server:

```bash
DATABASE_PATH=/var/data/aep.db npm run ingest
```

The database schema is managed by a versioned migration system in `src/db/migrations/`. On startup, any pending migrations are applied automatically. Adding a new migration is as simple as dropping a new `NNN_description.js` file into that directory — the runner picks it up in order.

## Notes
- Delivery semantics are at-least-once.
- Deduplication is enforced by a unique index on `events.id` in SQLite — duplicates are detected atomically without a prior read.

---

## Schema Changelog

### Phase 7 — Production Hardening (2026-03-24)

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

### Phase 6 — Testing & Developer Experience (2026-03-24)

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

`app.listen()` is now guarded by `require.main === module`, and `module.exports = { app }` is added at the bottom. This allows the integration test suite to import the Express app directly without starting a server. Running `node src/server.js` directly is unchanged.

---

### Phase 5 — Auth & Multi-Tenancy (2026-03-24)

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

### v0.2.0 (2026-03-22)

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
