# Changelog

All notable changes to AEP are documented here.

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
