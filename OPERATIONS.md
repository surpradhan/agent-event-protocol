# AEP Operations & Deployment Guide

**Last Updated:** 2026-06-06 · Covers Phase 13 (Hosted SaaS): Postgres backend, projects / tiers / quotas, and retention / pruning.

This guide is for **operators** running AEP in production. It picks up where
[SETUP.md](./SETUP.md) (integration) and [SECURITY.md](./SECURITY.md) (hardening)
leave off and focuses on the storage, multi-tenancy, and data-lifecycle controls
introduced in Phase 13:

1. [Choosing a storage backend](#1-choosing-a-storage-backend)
2. [Postgres production deployment](#2-postgres-production-deployment)
3. [Projects, tiers & quotas](#3-projects-tiers--quotas)
4. [Retention & pruning runbook](#4-retention--pruning-runbook)
5. [Phase 13 production checklist](#5-phase-13-production-checklist)

Everything below is verified against the source. Where a value comes from code,
the file is cited (e.g. `src/tiers.js`) so you can confirm it yourself.

---

## 1. Choosing a storage backend

AEP speaks to its database through a single `StorageBackend` interface
(`src/db/backends/interface.js`), so the rest of the server is identical no
matter which engine you run. Two backends ship today, selected by the
`STORAGE_BACKEND` environment variable:

| Backend | `STORAGE_BACKEND` | Best for | Connection setting |
|---|---|---|---|
| SQLite | `sqlite` (default) | Local dev, single-node, low volume | `DATABASE_PATH` (default `./data/aep.db`) |
| Postgres | `postgres` | Production, durability, higher throughput | `DATABASE_URL` (or `PG*` libpq vars) |

**Switching engines requires no code changes** — only `STORAGE_BACKEND` plus the
matching connection variable. The two backends are kept at strict behavioural
parity by the `Postgres parity tests` CI job, which runs the full integration
suite against a real `postgres:16` container.

### SQLite (default)

```bash
STORAGE_BACKEND=sqlite DATABASE_PATH=./data/aep.db npm run ingest
```

SQLite stores everything in one file and survives restarts. It is the right
choice for development and small single-node deployments, but it is a
single-writer database: it does not scale across multiple server instances and a
busy ingest path can contend with a concurrent pruning job (see
[§4](#4-retention--pruning-runbook)). For anything production-grade, use Postgres.

### Postgres (production)

```bash
STORAGE_BACKEND=postgres \
DATABASE_URL=postgres://aep:secret@db.internal:5432/aep \
npm run ingest
```

When `DATABASE_URL` is unset, the `pg` driver falls back to the standard libpq
environment variables (`PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` /
`PGDATABASE`) — useful when your platform injects those directly
(`src/db/backends/postgres.js`).

### The schema is created idempotently on boot

Both backends run their schema setup on `db.init()` at startup — `CREATE TABLE
IF NOT EXISTS …`, `CREATE INDEX IF NOT EXISTS …`, and `INSERT … ON CONFLICT DO
NOTHING` for seed rows. There is **no separate migration step to run**: point the
server at an empty database and it will create the `events`, `sessions`,
`api_keys`, `projects`, and `server_metrics` tables (plus the seeded `default`
project) on first start. Re-running against an existing database is a no-op. The
`GET /ready` probe returns 200 only once `init()` has completed and the schema is
present — wire it to a Kubernetes `readinessProbe`.

---

## 2. Postgres production deployment

### Connection string

```
postgres://<user>:<password>@<host>:<port>/<database>
# e.g.
postgres://aep:s3cret@db.internal:5432/aep
```

Pass it as `DATABASE_URL`. Keep the password out of source control — inject it
from a secrets manager / Kubernetes Secret, never the committed `.env`.

### Minimal docker-compose example

The bundled `docker-compose.yml` runs the server against a SQLite volume. To run
Postgres instead, add a `db` service and switch the app's env. A minimal overlay:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER:     aep
      POSTGRES_PASSWORD: ${PGPASSWORD:?set PGPASSWORD}
      POSTGRES_DB:       aep
    volumes:
      - aep_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aep -d aep"]
      interval: 5s
      timeout: 3s
      retries: 10

  aep:
    build: .
    depends_on:
      db:
        condition: service_healthy
    environment:
      STORAGE_BACKEND: postgres
      DATABASE_URL:    postgres://aep:${PGPASSWORD}@db:5432/aep
      ADMIN_TOKEN:     ${ADMIN_TOKEN:?set ADMIN_TOKEN}
      DASHBOARD_TOKEN: ${DASHBOARD_TOKEN:?set DASHBOARD_TOKEN}
    ports:
      - "${HOST_PORT:-8787}:8787"

volumes:
  aep_pgdata:
```

The server creates its schema on first boot, so no init container or migration
job is needed. For a managed Postgres (RDS, Cloud SQL, Neon, Supabase, …), drop
the `db` service and point `DATABASE_URL` at the managed instance's connection
string — append `?sslmode=require` if the provider mandates TLS (the `pg` driver
honours libpq-style query parameters).

### Connection pooling & sizing

`PostgresBackend` opens a single `pg` connection `Pool` per process
(`src/db/backends/postgres.js`). Notes for sizing it:

- **Pool size:** the pool uses `pg`'s defaults (max 10 connections per process).
  Plan total Postgres `max_connections` as *(server instances × 10) + headroom
  for the prune job and any external clients (e.g. PgBouncer, psql)*.
- **Multi-instance:** each server replica is its own pool. Behind a connection
  pooler (PgBouncer in transaction mode), a few hundred app connections collapse
  onto a small server-side pool — recommended past a handful of replicas.
- **Transactions:** ingest (`insertEvent`) and pruning (`pruneEventsBefore`) each
  run inside a single `BEGIN … COMMIT` and check out one pooled client for the
  duration, so a backlog of either can briefly saturate the pool — size with
  headroom for ingest bursts.
- **Timestamps are stored as ISO-8601 `TEXT`, not `TIMESTAMPTZ`.** This is
  deliberate: lexicographic ordering equals chronological ordering, which keeps
  cursor pagination and the retention cutoff comparison byte-identical to SQLite.
  Don't "fix" these columns to a timestamp type — it would break parity.

---

## 3. Projects, tiers & quotas

A **project** is the unit that owns ingested data and carries a subscription
tier. A seeded `default` project (enterprise / unlimited) absorbs all legacy keys
and data, so a single-tenant deployment that never touches the projects API
behaves exactly as it did pre-Phase-13.

### Creating a project

```bash
curl -s -X POST http://localhost:8787/admin/projects \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Prod","tenantId":"acme","tier":"team"}'
```

`tier` is one of `free` | `team` | `enterprise` (defaults to `free`). The tier's
default `event_quota` and `retention_days` are materialised onto the project row
at creation. You can override either per-project in the request body
(`src/server.js` → `POST /admin/projects`):

```bash
# Per-project overrides: a number sets the limit; null means unlimited.
-d '{"tenantId":"acme","tier":"team","eventQuota":2000000,"retentionDays":60}'
```

The create response returns the project record; `GET /admin/projects` and
`GET /admin/projects/:id` additionally include the project's current usage. List
and inspect:

```bash
curl -s http://localhost:8787/admin/projects     -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s http://localhost:8787/admin/projects/<id> -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Binding an API key to a project

Pass `projectId` when minting a key. Keys minted without it land in the `default`
project:

```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"acme","projectId":"<project-id>","label":"acme-prod","scopes":["read","write"]}'
```

Every event ingested with that key is metered against — and retained according
to — its project.

### Tier defaults and how to override them

Built-in defaults (`src/tiers.js`):

| Tier | `event_quota` | `retention_days` |
|---|---|---|
| `free` | 100,000 | 30 |
| `team` | 5,000,000 | 90 |
| `enterprise` | unlimited | unlimited (keep forever) |

> The PRD frames free as "unlimited events up to 5 GB". This repo meters by
> **event count, not bytes**, so the free tier is translated to a conservative
> finite event quota so the quota path is enforceable and testable.

Every default is overridable via environment variables — set these on the server
(and on the prune job, since it reads `retention_days`) so limits can be tuned
without a code change. A value of `unlimited` (case-insensitive) or empty maps to
no limit:

```bash
TIER_FREE_EVENT_QUOTA=100000
TIER_FREE_RETENTION_DAYS=30
TIER_TEAM_EVENT_QUOTA=5000000
TIER_TEAM_RETENTION_DAYS=90
TIER_ENTERPRISE_EVENT_QUOTA=unlimited
TIER_ENTERPRISE_RETENTION_DAYS=unlimited
```

> **Note:** env overrides change the *tier defaults applied to projects created
> afterwards*. Projects already created keep the `event_quota` / `retention_days`
> values stored on their row; change those via per-project overrides at creation
> time (a future PR may add an update endpoint).

### What a 429 / Retry-After means for clients

When a project reaches its `event_quota`, `POST /events` returns **HTTP 429** with
a `Retry-After: 3600` header (`src/middleware/quota.js`):

```json
{
  "accepted": false,
  "error": "Event quota exceeded for this project",
  "quota": 100000,
  "usage": 100000,
  "project": "<project-id>"
}
```

Clients should back off and retry after the indicated interval (the official
SDKs already honour `Retry-After`). This is distinct from the per-key **rate
limit** 429 (`RATE_LIMIT_RPM`, documented in SETUP.md §16) — same status code,
different cause: rate limiting throttles *request frequency*; the quota caps
*total stored events* for the project.

#### Operational knobs & documented caveats

- **`QUOTA_ENFORCEMENT`** (default `true`): set to `false` to record usage but
  never block ingest — useful for a staged rollout before turning enforcement on.
- **`QUOTA_REFRESH_MS`** (default `10000`): how stale the in-memory per-project
  usage counter may get before it re-counts against the database.
- **Metered by `tenant_id`, not `project_id`.** Events predate projects and carry
  `tenant_id`; quota (and pruning) are scoped by the project's tenant. This is
  exact when one project owns a tenant — the expected model.
- **Event count, not bytes.** The limit is a number of accepted events, not
  storage size.
- **Soft, single-node limit.** The usage counter is per-process and in-memory, so
  with multiple replicas the effective ceiling can drift by up to one refresh
  window × instance count. Hard global enforcement would need a shared counter
  (Redis / a per-ingest DB upsert) — out of scope for Phase 13.

### Data residency (Phase 14 PR-G)

A project can **declare** the region its data should reside in — `EU` / `US` /
`APAC` / `global` — at creation:

```bash
curl -s -X POST http://localhost:8787/admin/projects \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tenantId":"acme","tier":"team","region":"EU"}'
```

The deployment declares where its storage **actually** lives via the
`DATA_RESIDENCY_REGION` env var. Each project response then carries:

- `region` — the project's declared region (`null` = unspecified), and
- `regionEnforced` — `true` only when `DATA_RESIDENCY_REGION` satisfies the
  project's declared region (or it asks for none / `global`). **A `false` flag
  means the data is NOT physically in the region the project requires** — monitor
  it as a residency-violation signal.

When `DATA_RESIDENCY_REGION` is set, exported audit bundles also record
`data_residency_region` in their **signed manifest**, so the evidence is
self-describing about where the data resided.

> **Important — this is a control, not routing.** AEP does **not** route storage
> by region: a single deployment writes to one backend, so `DATA_RESIDENCY_REGION`
> is your *attestation* of that backend's location and `regionEnforced` is a
> *mismatch signal*. True multi-region residency requires infrastructure —
> separate per-region ingest endpoints + storage — which is outside the
> application layer. Run one AEP deployment per region and point each region's
> tenants at the matching endpoint.

---

## 4. Retention & pruning runbook

### What the prune job does

Phase 13 stores each project's `retention_days` but deliberately ships **no
always-on scheduler**. Retention is enforced by an operator-invoked, run-once
job (`src/prune.js` → `src/retention.js`). One pass:

1. Lists every project.
2. For each project with a **positive, finite** `retention_days`, computes a
   cutoff of `now − retention_days` and deletes events older than it (scoped to
   the project's `tenant_id`), inside a single transaction.
3. Reconciles the derived `sessions` summaries for the affected sessions only —
   deletes now-empty sessions and recomputes `event_count` / `started_at` /
   `updated_at` for the rest.

It uses the **same storage backend as the server** (`STORAGE_BACKEND` +
`DATABASE_PATH` / `DATABASE_URL`), so it prunes the live database.

### CLI usage

```bash
npm run prune                 # delete expired events for all projects
npm run prune -- --dry-run    # report what WOULD be deleted, change nothing
npm run prune -- --json       # machine-readable summary on stdout
npm run prune -- --help       # usage
```

`--dry-run` JSON summary shape:

```json
{
  "dryRun": true,
  "projects_scanned": 1,
  "projects_pruned": 0,
  "events_deleted": 0,
  "sessions_deleted": 0,
  "details": []
}
```

> **Always `--dry-run` first** against a new schedule or after changing a
> retention policy, and read the `details[]` per-project breakdown before letting
> the real run delete anything.

### Keep-forever rule & tenant-scoping caveat

- A project with `retention_days` **NULL / 0 / negative** means *keep forever*
  and is never pruned. This covers the seeded `default` enterprise project, so a
  default deployment prunes nothing until you create finite-retention projects.
- Pruning is **scoped by `tenant_id`** (carried over from quota metering, see
  `src/retention.js`). Exact when one project owns a tenant. If a single tenant
  ever has multiple projects with *different* retention windows, the shortest
  applicable window would over-prune the others' data — avoid mapping multiple
  differing-retention projects onto one tenant until per-project event tagging
  lands.

### Idempotency & observability

- **Idempotent.** Re-running prune is safe: a second run immediately after a
  first finds nothing newly past the cutoff and deletes nothing (until time
  advances). The job short-circuits when zero events match.
- **Structured logs.** The job logs one structured line per project it touches —
  `project_id`, `tenant_id`, `retention_days`, `cutoff`, `events_deleted`,
  `sessions_deleted`, `dry_run` — at `info` level via Pino. Scrape these to
  confirm the schedule ran and how much it removed.
- **Exit codes.** `0` on success, `1` on failure — wire alerting to a non-zero
  exit / a missing success log.

### Scheduling recipe — crontab

Run nightly at 03:15. Pass the **same** backend env the server uses so the job
prunes the live database. For Postgres (recommended in production):

```cron
# /etc/cron.d/aep-prune  —  nightly retention pass at 03:15
15 3 * * *  aep  cd /opt/agent-event-protocol && \
  STORAGE_BACKEND=postgres \
  DATABASE_URL='postgres://aep:secret@db.internal:5432/aep' \
  /usr/bin/npm run prune >> /var/log/aep-prune.log 2>&1
```

For SQLite, swap the two DB vars for `DATABASE_PATH=/opt/agent-event-protocol/data/aep.db`.
Because SQLite is single-writer, schedule the SQLite prune during a low-ingest
window to avoid lock contention with the running server — another reason to
prefer Postgres in production.

> Secrets in a crontab file are readable by anyone who can read the file. Prefer
> sourcing them from an env file with restricted permissions
> (`EnvironmentFile=` under systemd, or `. /etc/aep/prune.env` in the cron line).

### Scheduling recipe — Kubernetes CronJob

Reuse the server image (it contains `src/prune.js`) and point it at the **same
DB Secret** the server Deployment uses. Override the container command to run the
prune job instead of the server:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: aep-prune
  namespace: aep
spec:
  schedule: "15 3 * * *"          # nightly 03:15 UTC
  concurrencyPolicy: Forbid       # never overlap two prune runs
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      activeDeadlineSeconds: 1800
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: prune
              image: aep-ingest:latest          # same image as the server
              command: ["node", "src/prune.js"] # run the job, not the server
              # args: ["--dry-run"]             # uncomment to validate first
              env:
                - name: STORAGE_BACKEND
                  value: "postgres"
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: aep-db               # the SAME secret the server uses
                      key: database-url
                # Mirror any TIER_*_RETENTION_DAYS overrides set on the server so
                # the job reads the same policy for projects created afterwards.
```

Notes:

- `concurrencyPolicy: Forbid` plus the job's own short-circuit-on-zero behaviour
  keeps runs from piling up if one is slow.
- Validate with `--dry-run` (uncomment the `args` line) and check the pod logs —
  the structured per-project line tells you exactly what a real run would delete:
  `kubectl -n aep logs job/<job-name>`.
- This CronJob deploys the **AEP server image**. The `operator/` directory is a
  separate concern — it injects instrumentation sidecars into *your agent* pods
  and does not deploy the AEP server or the prune job.

---

## 5. Phase 13 production checklist

Phase 13 (Hosted SaaS groundwork) is complete: Postgres backend (PR-B),
projects / tiers / quotas (PR-C), retention / pruning (PR-D), and these ops docs
(PR-E). Before going live:

- [ ] **Backend:** `STORAGE_BACKEND=postgres` with `DATABASE_URL` (or `PG*`)
      pointed at a durable, backed-up Postgres. Confirm `GET /ready` returns 200.
- [ ] **Auth:** `ADMIN_TOKEN` and `DASHBOARD_TOKEN` set; server behind TLS.
      (See [SECURITY.md](./SECURITY.md).)
- [ ] **Projects:** real projects created on the right tiers; production API keys
      bound to their project via `projectId` (not the seeded `default`).
- [ ] **Quotas:** `QUOTA_ENFORCEMENT=true` once validated; `TIER_*` overrides set
      to match your plan; clients handle `429` + `Retry-After`.
- [ ] **Retention:** `npm run prune` scheduled (cron or k8s CronJob) against the
      same DB; validated with `--dry-run`; the prune job has the same `TIER_*`
      retention env as the server; success/failure is alerted on.
- [ ] **Observability:** `/metrics/prometheus` scraped; prune job logs collected.
- [ ] **Signature enforcement:** the server accepts **only** payload-covering
      `canon:"v2"` per-event signatures — legacy v1 (envelope-only) signatures are
      rejected with `401`, and (as of issue #65 Phase E) there is **no**
      `REQUIRE_CANON_V2` escape hatch to re-accept them. Confirm your emitters sign
      v2 (the published SDK default). See [AUTH.md](./AUTH.md) for the
      accept/reject matrix.

---

*See also: [SETUP.md](./SETUP.md) (integration & API reference),
[SECURITY.md](./SECURITY.md) (hardening), [AUTH.md](./AUTH.md) (keys, tenants,
HMAC), and [CHANGELOG.md](./CHANGELOG.md) (version history).*
