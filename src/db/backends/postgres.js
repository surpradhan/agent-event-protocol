"use strict";

/**
 * src/db/backends/postgres.js — PostgreSQL implementation of the StorageBackend
 * contract (Phase 13 PR-B).
 *
 * Backed by `pg` (node-postgres) with a connection Pool — a genuinely async
 * driver.  Every method mirrors SqliteBackend's semantics **exactly**: same
 * return shapes, same ordering, same cursor encoding, same duplicate-detection
 * behaviour.  The only differences are dialect-level:
 *
 *   • Placeholders        @named / ?  →  $1, $2, …
 *   • Duplicate insert     INSERT OR IGNORE  →  INSERT … ON CONFLICT (id) DO NOTHING
 *                          (duplicate detected via result.rowCount === 0)
 *   • Greatest-of-two      MAX(a, b)  →  GREATEST(a, b)   (MAX is an aggregate in PG)
 *   • Schema probe         sqlite_master  →  to_regclass('public.events')
 *   • COUNT(*) returns a   bigint, which the pg driver hands back as a *string* —
 *     every count is coerced with Number() so the public shape stays numeric,
 *     identical to better-sqlite3.
 *
 * Timestamp columns (time, started_at, updated_at, ingested_at, created_at,
 * revoked_at) are stored as **TEXT** ISO-8601 strings — deliberately, not
 * TIMESTAMPTZ — so the cursor-pagination comparisons (`updated_at < $n`,
 * `time > $n`) are byte-for-byte lexicographic exactly like SQLite.  ISO-8601
 * sorts lexicographically == chronologically, so ordering is preserved.
 *
 * The pure helpers (formatSession / buildTree / computeMaxDepth / cursor codec /
 * applyTextFilter) are shared with SqliteBackend via ./_helpers — there is no
 * Postgres-specific copy, which is what guarantees parity.
 *
 * Environment variables
 * ---------------------
 * DATABASE_URL — Postgres connection string (e.g.
 *                postgres://user:pass@host:5432/aep).  When unset, the `pg`
 *                Pool falls back to the standard libpq env vars
 *                (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE).
 */

const { Pool } = require("pg");
const { StorageBackend } = require("./interface");

const {
  formatSession,
  buildTree,
  computeMaxDepth,
  decodeCursor,
  encodeCursor,
  applyTextFilter,
  formatAccessLogRow,
  formatSavedQueryRow,
  formatWebhookRow,
  formatWebhookDeliveryRow
} = require("./_helpers");

// ---------------------------------------------------------------------------
// Schema DDL — mirrors src/db/migrations/{001_initial,002_auth}.js, translated
// to Postgres types.  Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING).
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
  -- ----- events ------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS events (
    id                TEXT    NOT NULL PRIMARY KEY,
    specversion       TEXT    NOT NULL DEFAULT '0.2.0',
    time              TEXT    NOT NULL,
    source            TEXT    NOT NULL,
    type              TEXT    NOT NULL,
    session_id        TEXT    NOT NULL,
    trace_id          TEXT    NOT NULL,
    parent_session_id TEXT,
    agent_role        TEXT,
    subject           TEXT,
    causation_id      TEXT,
    idempotency_key   TEXT,
    raw_payload       TEXT    NOT NULL,
    ingested_at       TEXT    NOT NULL,
    tenant_id         TEXT    NOT NULL DEFAULT 'default'
  );

  CREATE INDEX IF NOT EXISTS idx_events_session_id     ON events (session_id);
  CREATE INDEX IF NOT EXISTS idx_events_session_type   ON events (session_id, type);
  CREATE INDEX IF NOT EXISTS idx_events_session_role   ON events (session_id, agent_role);
  CREATE INDEX IF NOT EXISTS idx_events_time           ON events (time);
  CREATE INDEX IF NOT EXISTS idx_events_trace_id       ON events (trace_id);
  CREATE INDEX IF NOT EXISTS idx_events_tenant_id      ON events (tenant_id);
  CREATE INDEX IF NOT EXISTS idx_events_tenant_session ON events (tenant_id, session_id);

  -- ----- sessions ----------------------------------------------------------
  CREATE TABLE IF NOT EXISTS sessions (
    session_id        TEXT    NOT NULL PRIMARY KEY,
    trace_id          TEXT    NOT NULL,
    source            TEXT    NOT NULL,
    parent_session_id TEXT,
    agent_role        TEXT,
    event_count       INTEGER NOT NULL DEFAULT 0,
    started_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    tenant_id         TEXT    NOT NULL DEFAULT 'default'
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_updated_at      ON sessions (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_trace_id        ON sessions (trace_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id       ON sessions (tenant_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_tenant_updated  ON sessions (tenant_id, updated_at DESC);

  -- ----- server_metrics ----------------------------------------------------
  CREATE TABLE IF NOT EXISTS server_metrics (
    key   TEXT    NOT NULL PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  INSERT INTO server_metrics (key, value) VALUES
    ('received', 0), ('rejected', 0), ('duplicates', 0)
  ON CONFLICT (key) DO NOTHING;

  -- ----- api_keys ----------------------------------------------------------
  CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT    NOT NULL PRIMARY KEY,
    key_hash    TEXT    NOT NULL UNIQUE,
    key_prefix  TEXT    NOT NULL,
    tenant_id   TEXT    NOT NULL,
    project_id  TEXT    NOT NULL DEFAULT 'default',
    label       TEXT    NOT NULL DEFAULT '',
    scopes      TEXT    NOT NULL DEFAULT '["read","write"]',
    hmac_secret TEXT,
    created_at  TEXT    NOT NULL,
    revoked_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_api_keys_tenant  ON api_keys (tenant_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys (project_id);

  -- ----- projects (Phase 13 PR-C) ------------------------------------------
  CREATE TABLE IF NOT EXISTS projects (
    id             TEXT    NOT NULL PRIMARY KEY,
    name           TEXT    NOT NULL DEFAULT '',
    tenant_id      TEXT    NOT NULL,
    tier           TEXT    NOT NULL DEFAULT 'free',
    event_quota    INTEGER,
    retention_days INTEGER,
    created_at     TEXT    NOT NULL,
    region         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects (tenant_id);

  -- Phase 14 PR-G: mirrors migration 005 for already-existing Postgres DBs
  -- (the CREATE above only adds the column on a fresh database).
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS region TEXT;

  -- Seed the 'default' project so legacy keys/data keep working unchanged.
  INSERT INTO projects
    (id, name, tenant_id, tier, event_quota, retention_days, created_at)
  VALUES
    ('default', 'Default Project', 'default', 'enterprise', NULL, NULL,
     '1970-01-01T00:00:00.000Z')
  ON CONFLICT (id) DO NOTHING;

  -- ----- api_key_access_log (Phase 14 PR-E) --------------------------------
  -- Mirrors src/db/migrations/004_access_logs.js.  One row per authenticated
  -- request when ACCESS_LOG_ENABLED is set; empty otherwise.
  CREATE TABLE IF NOT EXISTS api_key_access_log (
    id          TEXT    NOT NULL PRIMARY KEY,
    api_key_id  TEXT    NOT NULL,
    tenant_id   TEXT,
    method      TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    status      INTEGER NOT NULL,
    ts          TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_access_log_key_ts ON api_key_access_log (api_key_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_access_log_ts     ON api_key_access_log (ts);

  -- ----- saved_queries (Phase 15-B) ----------------------------------------
  -- Mirrors src/db/migrations/006_saved_queries.js.  Per-tenant library of named
  -- custom-analytics query specs (JSON text; data only, never executed as SQL).
  CREATE TABLE IF NOT EXISTS saved_queries (
    id          TEXT NOT NULL PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    spec        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (tenant_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_saved_queries_tenant ON saved_queries (tenant_id, created_at DESC);

  -- ----- webhooks (Phase 16-A) ---------------------------------------------
  -- Mirrors src/db/migrations/007_webhooks.js.  Per-tenant registry of outbound
  -- webhook endpoints (target URL + event-type filter + enabled flag).  The
  -- target URL is SSRF-validated before insert; event_types is JSON text
  -- (["*"] or a subset of the core types), data only.
  CREATE TABLE IF NOT EXISTS webhooks (
    id             TEXT    NOT NULL PRIMARY KEY,
    tenant_id      TEXT    NOT NULL,
    target_url     TEXT    NOT NULL,
    event_types    TEXT    NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    signing_secret TEXT,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON webhooks (tenant_id, created_at DESC);

  -- Phase 16-C: mirrors migration 009 for already-existing Postgres DBs (the
  -- CREATE above only adds the column on a fresh database).
  ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS signing_secret TEXT;

  -- ----- webhook_deliveries (Phase 16-B) -----------------------------------
  -- Mirrors src/db/migrations/008_webhook_deliveries.js.  One row per
  -- (event → webhook) delivery: terminal status + attempt count + last HTTP
  -- code / error.  No FK (immutable history, survives webhook deletion).
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id               TEXT    NOT NULL PRIMARY KEY,
    webhook_id       TEXT    NOT NULL,
    tenant_id        TEXT    NOT NULL,
    event_id         TEXT    NOT NULL,
    event_type       TEXT    NOT NULL,
    status           TEXT    NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_status_code INTEGER,
    last_error       TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries (webhook_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant  ON webhook_deliveries (tenant_id, created_at DESC);
`;

// Standard projection of a sessions row (column order matches SqliteBackend).
const SESSION_COLS = `session_id, trace_id, source, parent_session_id, agent_role,
                      event_count, started_at, updated_at`;

// ---------------------------------------------------------------------------
// PostgresBackend
// ---------------------------------------------------------------------------

class PostgresBackend extends StorageBackend {
  /**
   * @param {{ connectionString?: string }} [opts]
   */
  constructor({ connectionString } = {}) {
    super();
    this._connectionString = connectionString || process.env.DATABASE_URL || null;
    this._pool = null;
  }

  /**
   * Open the pool and ensure the schema exists.  Idempotent — a second call
   * after a successful init is a no-op.
   */
  async init() {
    if (this._pool) return;

    const pool = this._connectionString
      ? new Pool({ connectionString: this._connectionString })
      : new Pool();

    // Create tables / indexes / seed rows if they don't already exist.
    await pool.query(SCHEMA_DDL);

    this._pool = pool;
  }

  // ----- health -----

  async ping() {
    await this._pool.query("SELECT 1");
    return true;
  }

  async schemaReady() {
    const { rows } = await this._pool.query(
      "SELECT to_regclass('public.events') AS reg"
    );
    return rows[0].reg !== null;
  }

  // ----- events -----

  async insertEvent(event, tenantId) {
    const row = {
      id:                event.id,
      specversion:       event.specversion || "0.2.0",
      time:              event.time,
      source:            event.source,
      type:              event.type,
      session_id:        event.session_id,
      trace_id:          event.trace_id,
      parent_session_id: event.parent_session_id ?? null,
      agent_role:        event.agent_role        ?? null,
      subject:           event.subject           ?? null,
      causation_id:      event.causation_id      ?? null,
      idempotency_key:   event.idempotency_key   ?? null,
      raw_payload:       JSON.stringify(event),
      ingested_at:       new Date().toISOString(),
      tenant_id:         tenantId || "default"
    };

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      const insert = await client.query(
        `INSERT INTO events (
           id, specversion, time, source, type,
           session_id, trace_id,
           parent_session_id, agent_role, subject,
           causation_id, idempotency_key,
           raw_payload, ingested_at, tenant_id
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7,
           $8, $9, $10,
           $11, $12,
           $13, $14, $15
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.specversion, row.time, row.source, row.type,
          row.session_id, row.trace_id,
          row.parent_session_id, row.agent_role, row.subject,
          row.causation_id, row.idempotency_key,
          row.raw_payload, row.ingested_at, row.tenant_id
        ]
      );

      if (insert.rowCount === 0) {
        // id already present → duplicate; nothing more to do.
        await client.query("COMMIT");
        return { isDuplicate: true };
      }

      // Upsert the session summary row (event.time drives both started_at and
      // updated_at on first insert; updated_at advances to the max on conflict).
      await client.query(
        `INSERT INTO sessions
           (session_id, trace_id, source, parent_session_id, agent_role,
            event_count, started_at, updated_at, tenant_id)
         VALUES
           ($1, $2, $3, $4, $5, 1, $6, $6, $7)
         ON CONFLICT (session_id) DO UPDATE SET
           event_count = sessions.event_count + 1,
           updated_at  = GREATEST(sessions.updated_at, EXCLUDED.updated_at)`,
        [
          event.session_id,
          event.trace_id,
          event.source,
          event.parent_session_id ?? null,
          event.agent_role        ?? null,
          event.time,
          tenantId || "default"
        ]
      );

      await client.query("COMMIT");
      return { isDuplicate: false };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getSessionEvents(sessionId, { type = "", q = "", role = "", tenantId = null } = {}) {
    let sql = "SELECT raw_payload FROM events WHERE session_id = $1";
    const params = [sessionId];

    if (tenantId) {
      params.push(tenantId);
      sql += ` AND tenant_id = $${params.length}`;
    }
    if (type) {
      params.push(type);
      sql += ` AND type = $${params.length}`;
    }
    if (role) {
      params.push(role);
      sql += ` AND agent_role = $${params.length}`;
    }
    sql += " ORDER BY time ASC";

    const { rows } = await this._pool.query(sql, params);
    const events = rows.map(r => JSON.parse(r.raw_payload));
    return applyTextFilter(events, q);
  }

  async getAllSessions(tenantId = null) {
    const sql = tenantId
      ? `SELECT ${SESSION_COLS} FROM sessions WHERE tenant_id = $1 ORDER BY updated_at DESC`
      : `SELECT ${SESSION_COLS} FROM sessions ORDER BY updated_at DESC`;
    const { rows } = await this._pool.query(sql, tenantId ? [tenantId] : []);

    return rows.map(row => ({
      session_id:  row.session_id,
      trace_id:    row.trace_id,
      source:      row.source,
      event_count: row.event_count,
      started_at:  row.started_at,
      updated_at:  row.updated_at
    }));
  }

  async getSessionCount(tenantId = null) {
    const sql = tenantId
      ? "SELECT COUNT(*) AS n FROM sessions WHERE tenant_id = $1"
      : "SELECT COUNT(*) AS n FROM sessions";
    const { rows } = await this._pool.query(sql, tenantId ? [tenantId] : []);
    return Number(rows[0].n);
  }

  async getMetrics(tenantId = null, { since, until } = {}) {
    // Server-wide request counters live in server_metrics (no timestamps) — always lifetime totals.
    let received = 0, rejected = 0, duplicates = 0;
    if (!tenantId) {
      const { rows } = await this._pool.query(
        "SELECT key, value FROM server_metrics WHERE key IN ('received','rejected','duplicates')"
      );
      const byKey = {};
      for (const r of rows) byKey[r.key] = Number(r.value);
      received   = byKey.received   ?? 0;
      rejected   = byKey.rejected   ?? 0;
      duplicates = byKey.duplicates ?? 0;
    }

    const windowed = (since !== null && since !== undefined) || (until !== null && until !== undefined);

    // Build WHERE clauses dynamically for the windowed path.
    const evtConds  = [];
    const evtParams = [];
    const sesConds  = [];
    const sesParams = [];
    if (tenantId) {
      evtConds.push(`tenant_id = $${evtParams.push(tenantId)}`);
      sesConds.push(`tenant_id = $${sesParams.push(tenantId)}`);
    }
    if (since) {
      evtConds.push(`time >= $${evtParams.push(since)}`);
      sesConds.push(`started_at >= $${sesParams.push(since)}`);
    }
    if (until) {
      evtConds.push(`time < $${evtParams.push(until)}`);
      sesConds.push(`started_at < $${sesParams.push(until)}`);
    }
    const evtWhere = evtConds.length ? "WHERE " + evtConds.join(" AND ") : "";
    const sesWhere = sesConds.length ? "WHERE " + sesConds.join(" AND ") : "";

    const acceptedRes = await this._pool.query(
      `SELECT COUNT(*) AS n FROM events ${evtWhere}`, evtParams
    );
    const accepted = Number(acceptedRes.rows[0].n);

    const byTypeRes = await this._pool.query(
      `SELECT type, COUNT(*) AS n FROM events ${evtWhere} GROUP BY type`, evtParams
    );
    const byType = {};
    for (const r of byTypeRes.rows) byType[r.type] = Number(r.n);

    const wfRes = await this._pool.query(
      `SELECT COUNT(DISTINCT trace_id) AS n FROM sessions ${sesWhere}`, sesParams
    );
    const workflow_count = Number(wfRes.rows[0].n);

    const subCond = sesWhere ? sesWhere + " AND" : "WHERE";
    const subRes = await this._pool.query(
      `SELECT COUNT(*) AS n FROM sessions ${subCond} parent_session_id IS NOT NULL`, sesParams
    );
    const subagent_session_count = Number(subRes.rows[0].n);

    const session_count_res = await this._pool.query(
      `SELECT COUNT(*) AS n FROM sessions ${sesWhere}`, sesParams
    );
    const session_count = Number(session_count_res.rows[0].n);

    // max_tree_depth is not meaningful over an arbitrary time window; skip it there.
    let max_tree_depth = 0;
    if (!windowed) {
      const depthRes = tenantId
        ? await this._pool.query("SELECT session_id, parent_session_id FROM sessions WHERE tenant_id = $1", [tenantId])
        : await this._pool.query("SELECT session_id, parent_session_id FROM sessions");
      max_tree_depth = computeMaxDepth(depthRes.rows);
    }

    return {
      received,
      accepted,
      rejected,
      duplicates,
      byType,
      session_count,
      workflow_count,
      subagent_session_count,
      max_tree_depth,
      windowed: windowed ? { since: since ?? null, until: until ?? null } : undefined,
    };
  }

  async incrementCounter(key) {
    await this._pool.query(
      "UPDATE server_metrics SET value = value + 1 WHERE key = $1",
      [key]
    );
  }

  // ----- session tree / workflow -----

  async getSession(sessionId, tenantId = null) {
    const sql = tenantId
      ? `SELECT ${SESSION_COLS} FROM sessions WHERE session_id = $1 AND tenant_id = $2`
      : `SELECT ${SESSION_COLS} FROM sessions WHERE session_id = $1`;
    const params = tenantId ? [sessionId, tenantId] : [sessionId];
    const { rows } = await this._pool.query(sql, params);
    return rows[0] ? formatSession(rows[0]) : null;
  }

  async getSessionTree(sessionId, tenantId = null) {
    // Recursive CTE: anchor row (optionally tenant-scoped) + every descendant.
    // The recursive arm joins children regardless of tenant — byte-identical to
    // SqliteBackend's getDescendants/getDescendantsTenant.
    const sql = tenantId
      ? `WITH RECURSIVE descendants AS (
           SELECT ${SESSION_COLS}
           FROM   sessions
           WHERE  session_id = $1 AND tenant_id = $2
           UNION ALL
           SELECT s.session_id, s.trace_id, s.source, s.parent_session_id, s.agent_role,
                  s.event_count, s.started_at, s.updated_at
           FROM   sessions s
           INNER  JOIN descendants d ON s.parent_session_id = d.session_id
         )
         SELECT * FROM descendants`
      : `WITH RECURSIVE descendants AS (
           SELECT ${SESSION_COLS}
           FROM   sessions
           WHERE  session_id = $1
           UNION ALL
           SELECT s.session_id, s.trace_id, s.source, s.parent_session_id, s.agent_role,
                  s.event_count, s.started_at, s.updated_at
           FROM   sessions s
           INNER  JOIN descendants d ON s.parent_session_id = d.session_id
         )
         SELECT * FROM descendants`;
    const params = tenantId ? [sessionId, tenantId] : [sessionId];
    const { rows } = await this._pool.query(sql, params);
    if (rows.length === 0) return null;
    return buildTree(rows, sessionId);
  }

  async getWorkflow(traceId, tenantId = null) {
    const sql = tenantId
      ? `SELECT ${SESSION_COLS} FROM sessions WHERE trace_id = $1 AND tenant_id = $2 ORDER BY started_at ASC`
      : `SELECT ${SESSION_COLS} FROM sessions WHERE trace_id = $1 ORDER BY started_at ASC`;
    const params = tenantId ? [traceId, tenantId] : [traceId];
    const { rows } = await this._pool.query(sql, params);
    if (rows.length === 0) return null;

    const idSet = new Set(rows.map(r => r.session_id));

    // Roots: sessions whose parent is absent or not part of this trace.
    const roots = rows.filter(
      r => !r.parent_session_id || !idSet.has(r.parent_session_id)
    );

    const tree = roots.map(root => buildTree(rows, root.session_id));

    return {
      trace_id: traceId,
      session_count: rows.length,
      tree
    };
  }

  // ----- api key management -----

  async createApiKey(record) {
    await this._pool.query(
      `INSERT INTO api_keys
         (id, key_hash, key_prefix, tenant_id, project_id, label, scopes, hmac_secret, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        record.key_hash,
        record.key_prefix,
        record.tenant_id,
        record.project_id ?? "default",
        record.label,
        record.scopes,
        record.hmac_secret ?? null,
        record.created_at
      ]
    );
  }

  async getApiKeyByHash(keyHash) {
    const { rows } = await this._pool.query(
      `SELECT id, key_hash, key_prefix, tenant_id, project_id, label, scopes, hmac_secret,
              created_at, revoked_at
       FROM   api_keys
       WHERE  key_hash = $1`,
      [keyHash]
    );
    return rows[0] || null;
  }

  async getApiKeyById(id) {
    const { rows } = await this._pool.query(
      `SELECT id, key_hash, key_prefix, tenant_id, project_id, label, scopes, hmac_secret,
              created_at, revoked_at
       FROM   api_keys
       WHERE  id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  async listApiKeys() {
    const { rows } = await this._pool.query(
      `SELECT id, key_prefix, tenant_id, project_id, label, scopes, created_at, revoked_at
       FROM   api_keys
       ORDER  BY created_at DESC`
    );
    return rows;
  }

  async revokeApiKey(id) {
    const result = await this._pool.query(
      "UPDATE api_keys SET revoked_at = $1 WHERE id = $2",
      [new Date().toISOString(), id]
    );
    return result.rowCount > 0;
  }

  // ----- projects (Phase 13 PR-C) -----

  async createProject(record) {
    await this._pool.query(
      `INSERT INTO projects
         (id, name, tenant_id, tier, event_quota, retention_days, created_at, region)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.name,
        record.tenant_id,
        record.tier,
        record.event_quota ?? null,
        record.retention_days ?? null,
        record.created_at,
        record.region ?? null
      ]
    );
  }

  async getProject(id) {
    const { rows } = await this._pool.query(
      `SELECT id, name, tenant_id, tier, event_quota, retention_days, created_at, region
       FROM   projects
       WHERE  id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  async listProjects() {
    const { rows } = await this._pool.query(
      `SELECT id, name, tenant_id, tier, event_quota, retention_days, created_at, region
       FROM   projects
       ORDER  BY created_at DESC`
    );
    return rows;
  }

  async getProjectEventCount(tenantId) {
    const { rows } = await this._pool.query(
      "SELECT COUNT(*) AS n FROM events WHERE tenant_id = $1",
      [tenantId]
    );
    return Number(rows[0].n);
  }

  async listEventTenantIds() {
    // Distinct tenants that actually have events (issue #122) — see the SQLite
    // backend for the dialect-identical query and the NULL-exclusion rationale.
    const { rows } = await this._pool.query(
      `SELECT DISTINCT tenant_id FROM events
       WHERE tenant_id IS NOT NULL
       ORDER BY tenant_id ASC`
    );
    return rows.map((r) => r.tenant_id);
  }

  // ----- retention / pruning (Phase 13 PR-D) -----

  async countEventsBefore(tenantId, cutoff) {
    // COUNT(*) returns bigint-as-string in pg → coerce with Number().
    const { rows } = await this._pool.query(
      "SELECT COUNT(*) AS n FROM events WHERE tenant_id = $1 AND time < $2",
      [tenantId, cutoff]
    );
    return Number(rows[0].n);
  }

  async pruneEventsBefore(tenantId, cutoff) {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      // Affected session IDs: the sessions whose events match the delete
      // predicate, captured BEFORE the delete (same predicate as the delete).
      // Both cleanup steps below are scoped to this set — reconciling tenant-
      // wide would silently rewrite started_at on out-of-time-order sessions
      // that lost nothing, and do needless per-session subquery work.
      const affectedRes = await client.query(
        "SELECT DISTINCT session_id FROM events WHERE tenant_id = $1 AND time < $2",
        [tenantId, cutoff]
      );
      const affected = affectedRes.rows.map(r => r.session_id);

      // result.rowCount is already a JS number (unlike COUNT(*)'s bigint string).
      const del = await client.query(
        "DELETE FROM events WHERE tenant_id = $1 AND time < $2",
        [tenantId, cutoff]
      );
      const events_deleted = del.rowCount;

      // Nothing deleted → no affected sessions; skip the cleanup work.
      if (events_deleted === 0) {
        await client.query("COMMIT");
        return { events_deleted: 0, sessions_deleted: 0 };
      }

      // Postgres supports array binding, so the affected set is passed as a
      // single $2 array param (= ANY($2)).  Semantically identical to the
      // SqliteBackend's IN (...) list over the same captured set.
      //
      // Delete-empties must run BEFORE reconcile so reconcile never hits a
      // zero-event session (which would set started_at/updated_at to NULL and
      // violate the NOT NULL columns).  Restricted to the affected set.
      const empties = await client.query(
        `DELETE FROM sessions
         WHERE  tenant_id = $1
           AND  session_id = ANY($2)
           AND  session_id NOT IN (
                  SELECT DISTINCT session_id FROM events WHERE tenant_id = $1
                )`,
        [tenantId, affected]
      );
      const sessions_deleted = empties.rowCount;

      // Recompute aggregates only for the affected sessions that still exist.
      await client.query(
        `UPDATE sessions
         SET
           event_count = (
             SELECT COUNT(*) FROM events e
             WHERE e.session_id = sessions.session_id AND e.tenant_id = sessions.tenant_id
           ),
           started_at = (
             SELECT MIN(e.time) FROM events e
             WHERE e.session_id = sessions.session_id AND e.tenant_id = sessions.tenant_id
           ),
           updated_at = (
             SELECT MAX(e.time) FROM events e
             WHERE e.session_id = sessions.session_id AND e.tenant_id = sessions.tenant_id
           )
         WHERE tenant_id = $1 AND session_id = ANY($2)`,
        [tenantId, affected]
      );

      await client.query("COMMIT");
      return { events_deleted, sessions_deleted };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ----- analytics (Phase 14 PR-D) -----

  async getPolicyBlockedEvents(tenantId = null, { since = null, until = null } = {}) {
    // Built dynamically (same shape as getSessionEvents): conditions are only
    // appended when their value is present, so no IS NULL params and thus no
    // ::text cast workaround is needed.
    let sql = "SELECT raw_payload FROM events WHERE type = 'policy.blocked'";
    const params = [];
    if (tenantId) {
      params.push(tenantId);
      sql += ` AND tenant_id = $${params.length}`;
    }
    if (since) {
      params.push(since);
      sql += ` AND time >= $${params.length}`;
    }
    if (until) {
      params.push(until);
      sql += ` AND time < $${params.length}`;
    }
    sql += " ORDER BY time ASC";

    const { rows } = await this._pool.query(sql, params);
    return rows.map(r => JSON.parse(r.raw_payload));
  }

  // ----- performance profiling (Phase 15-A) -----

  async getPerformanceEvents(tenantId = null, { since = null, until = null } = {}) {
    // Built dynamically (same shape as getPolicyBlockedEvents): conditions are
    // only appended when present, so no IS NULL params / ::text cast needed. The
    // pure src/performance.js summarizer does all aggregation, so this stays
    // dialect-identical to the SQLite backend.
    let sql =
      "SELECT raw_payload FROM events WHERE type IN " +
      "('task.created','task.completed','task.failed','tool.called','tool.result')";
    const params = [];
    if (tenantId) {
      params.push(tenantId);
      sql += ` AND tenant_id = $${params.length}`;
    }
    if (since) {
      params.push(since);
      sql += ` AND time >= $${params.length}`;
    }
    if (until) {
      params.push(until);
      sql += ` AND time < $${params.length}`;
    }
    sql += " ORDER BY time ASC";

    const { rows } = await this._pool.query(sql, params);
    return rows.map(r => JSON.parse(r.raw_payload));
  }

  // ----- workflow causation graph (Phase 15-C) -----

  async getWorkflowEvents(traceId, tenantId = null) {
    // All events of one trace, tenant-scoped. Conditions appended only when
    // present (same shape as getPolicyBlockedEvents), so no ::text cast needed.
    let sql = "SELECT raw_payload FROM events WHERE trace_id = $1";
    const params = [traceId];
    if (tenantId) {
      params.push(tenantId);
      sql += ` AND tenant_id = $${params.length}`;
    }
    sql += " ORDER BY time ASC";

    const { rows } = await this._pool.query(sql, params);
    return rows.map(r => JSON.parse(r.raw_payload));
  }

  // ----- API-key access log (Phase 14 PR-E) -----

  async recordApiKeyAccess({ id, apiKeyId, tenantId, method, path, status, ts }) {
    await this._pool.query(
      `INSERT INTO api_key_access_log
         (id, api_key_id, tenant_id, method, path, status, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, apiKeyId, tenantId ?? null, method, path, status, ts]
    );
  }

  async getApiKeyAccessLog(apiKeyId, { since = null, until = null, limit = 100 } = {}) {
    const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);

    // Built dynamically (same shape as getSessionEvents): conditions only
    // appended when present, so no IS NULL params / ::text cast needed.
    let where = "WHERE api_key_id = $1";
    const params = [apiKeyId];
    if (since) {
      params.push(since);
      where += ` AND ts >= $${params.length}`;
    }
    if (until) {
      params.push(until);
      where += ` AND ts < $${params.length}`;
    }

    const totalRes = await this._pool.query(
      `SELECT COUNT(*) AS n FROM api_key_access_log ${where}`,
      params
    );
    const total = Number(totalRes.rows[0].n);

    const listRes = await this._pool.query(
      `SELECT id, api_key_id, tenant_id, method, path, status, ts
       FROM api_key_access_log
       ${where}
       ORDER BY ts DESC
       LIMIT $${params.length + 1}`,
      [...params, pageSize]
    );

    return { total, entries: listRes.rows.map(formatAccessLogRow) };
  }

  // ----- saved queries (Phase 15-B) -----

  async createSavedQuery(record) {
    try {
      await this._pool.query(
        `INSERT INTO saved_queries
           (id, tenant_id, name, spec, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          record.id,
          record.tenantId,
          record.name,
          JSON.stringify(record.spec),
          record.createdAt,
          record.updatedAt
        ]
      );
    } catch (err) {
      // unique_violation → typed conflict for the route (mirrors SQLite).
      if (err && err.code === "23505") {
        const e = new Error("saved query name already exists for this tenant");
        e.code = "SAVED_QUERY_CONFLICT";
        throw e;
      }
      throw err;
    }
    return this.getSavedQuery(record.id, record.tenantId);
  }

  async getSavedQuery(id, tenantId) {
    const { rows } = await this._pool.query(
      `SELECT id, tenant_id, name, spec, created_at, updated_at
       FROM saved_queries WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return rows[0] ? formatSavedQueryRow(rows[0]) : null;
  }

  async listSavedQueries(tenantId) {
    const { rows } = await this._pool.query(
      `SELECT id, tenant_id, name, spec, created_at, updated_at
       FROM saved_queries WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return rows.map(formatSavedQueryRow);
  }

  async deleteSavedQuery(id, tenantId) {
    const res = await this._pool.query(
      `DELETE FROM saved_queries WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return res.rowCount > 0;
  }

  // ----- webhooks (Phase 16-A) -----

  async createWebhook(record) {
    await this._pool.query(
      `INSERT INTO webhooks
         (id, tenant_id, target_url, event_types, enabled, signing_secret, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.tenantId,
        record.targetUrl,
        JSON.stringify(record.eventTypes),
        record.enabled ? 1 : 0,
        record.signingSecret ?? null,
        record.createdAt,
        record.updatedAt
      ]
    );
    return this.getWebhook(record.id, record.tenantId);
  }

  async getWebhook(id, tenantId) {
    const { rows } = await this._pool.query(
      `SELECT id, tenant_id, target_url, event_types, enabled, created_at, updated_at
       FROM webhooks WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return rows[0] ? formatWebhookRow(rows[0]) : null;
  }

  async getWebhookSigningSecret(id, tenantId) {
    const { rows } = await this._pool.query(
      `SELECT signing_secret FROM webhooks WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return rows[0] ? rows[0].signing_secret : null;
  }

  async listWebhooks(tenantId) {
    const { rows } = await this._pool.query(
      `SELECT id, tenant_id, target_url, event_types, enabled, created_at, updated_at
       FROM webhooks WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return rows.map(formatWebhookRow);
  }

  async updateWebhook(id, tenantId, fields, updatedAt) {
    const existing = await this.getWebhook(id, tenantId);
    if (!existing) return null;
    const targetUrl =
      fields.target_url !== undefined ? fields.target_url : existing.target_url;
    const eventTypes =
      fields.event_types !== undefined ? fields.event_types : existing.event_types;
    const enabled =
      fields.enabled !== undefined ? fields.enabled : existing.enabled;
    await this._pool.query(
      `UPDATE webhooks
       SET target_url = $1, event_types = $2, enabled = $3, updated_at = $4
       WHERE id = $5 AND tenant_id = $6`,
      [targetUrl, JSON.stringify(eventTypes), enabled ? 1 : 0, updatedAt, id, tenantId]
    );
    return this.getWebhook(id, tenantId);
  }

  async deleteWebhook(id, tenantId) {
    const res = await this._pool.query(
      `DELETE FROM webhooks WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return res.rowCount > 0;
  }

  // ----- webhook deliveries (Phase 16-B) -----

  async createWebhookDelivery(record) {
    await this._pool.query(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, tenant_id, event_id, event_type, status, attempts,
          last_status_code, last_error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.id,
        record.webhookId,
        record.tenantId,
        record.eventId,
        record.eventType,
        record.status,
        record.attempts ?? 0,
        record.lastStatusCode ?? null,
        record.lastError ?? null,
        record.createdAt,
        record.updatedAt
      ]
    );
    return this._getWebhookDelivery(record.id, record.tenantId);
  }

  async _getWebhookDelivery(id, tenantId) {
    const { rows } = await this._pool.query(
      `SELECT id, webhook_id, tenant_id, event_id, event_type, status, attempts,
              last_status_code, last_error, created_at, updated_at
       FROM webhook_deliveries WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return rows[0] ? formatWebhookDeliveryRow(rows[0]) : null;
  }

  async updateWebhookDelivery(id, tenantId, fields) {
    const existing = await this._getWebhookDelivery(id, tenantId);
    if (!existing) return null;
    await this._pool.query(
      `UPDATE webhook_deliveries
       SET status = $1, attempts = $2, last_status_code = $3, last_error = $4, updated_at = $5
       WHERE id = $6 AND tenant_id = $7`,
      [
        fields.status ?? existing.status,
        fields.attempts ?? existing.attempts,
        fields.last_status_code ?? null,
        fields.last_error ?? null,
        fields.updated_at,
        id,
        tenantId
      ]
    );
    return this._getWebhookDelivery(id, tenantId);
  }

  async listWebhookDeliveries(webhookId, tenantId, { since = null, until = null, limit = 100 } = {}) {
    const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);
    const { rows } = await this._pool.query(
      `SELECT id, webhook_id, tenant_id, event_id, event_type, status, attempts,
              last_status_code, last_error, created_at, updated_at
       FROM webhook_deliveries
       WHERE webhook_id = $1 AND tenant_id = $2
         AND ($3::text IS NULL OR created_at >= $3)
         AND ($4::text IS NULL OR created_at <  $4)
       ORDER BY created_at DESC
       LIMIT $5`,
      [webhookId, tenantId, since, until, pageSize]
    );
    return rows.map(formatWebhookDeliveryRow);
  }

  // ----- custom-analytics event fetch (Phase 15-B) -----

  async getEventsForQuery(tenantId = null, { since = null, until = null } = {}) {
    // Same shape as getPerformanceEvents but without the type constraint: filtering
    // is done in pure JS (src/customQuery.js), so this stays dialect-identical.
    let sql = "SELECT raw_payload FROM events WHERE 1=1";
    const params = [];
    if (tenantId) {
      params.push(tenantId);
      sql += ` AND tenant_id = $${params.length}`;
    }
    if (since) {
      params.push(since);
      sql += ` AND time >= $${params.length}`;
    }
    if (until) {
      params.push(until);
      sql += ` AND time < $${params.length}`;
    }
    sql += " ORDER BY time ASC";

    const { rows } = await this._pool.query(sql, params);
    return rows.map(r => JSON.parse(r.raw_payload));
  }

  // ----- pagination -----

  async getPaginatedSessions(tenantId = null, { limit = 50, cursor = null } = {}) {
    const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
    const decoded  = decodeCursor(cursor);

    // ::text casts on the IS NULL params let Postgres infer their type — without
    // them PG errors "could not determine data type of parameter". The keyset
    // predicate is otherwise identical to SqliteBackend's.
    const sql = `
      SELECT ${SESSION_COLS}
      FROM   sessions
      WHERE  ($1::text IS NULL OR tenant_id = $2)
        AND  ($3::text IS NULL OR updated_at < $4 OR (updated_at = $5 AND session_id < $6))
      ORDER  BY updated_at DESC, session_id DESC
      LIMIT  $7
    `;

    const params = [
      tenantId ?? null,
      tenantId ?? null,
      decoded?.updated_at ?? null,
      decoded?.updated_at ?? null,
      decoded?.updated_at ?? null,
      decoded?.session_id ?? null,
      pageSize + 1
    ];

    const { rows } = await this._pool.query(sql, params);

    let next_cursor = null;
    if (rows.length > pageSize) {
      rows.pop();
      const last  = rows[rows.length - 1];
      next_cursor = encodeCursor({ updated_at: last.updated_at, session_id: last.session_id });
    }

    return {
      sessions: rows.map(row => ({
        session_id:        row.session_id,
        trace_id:          row.trace_id,
        source:            row.source,
        parent_session_id: row.parent_session_id ?? null,
        agent_role:        row.agent_role        ?? null,
        event_count:       row.event_count,
        started_at:        row.started_at,
        updated_at:        row.updated_at
      })),
      next_cursor
    };
  }

  async getPaginatedEvents(sessionId, { type = "", q = "", role = "", tenantId = null, limit = 100, cursor = null } = {}) {
    const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);
    const decoded  = decodeCursor(cursor);

    const sql = `
      SELECT raw_payload
      FROM   events
      WHERE  session_id = $1
        AND  ($2::text IS NULL OR tenant_id = $3)
        AND  ($4::text = '' OR type = $5)
        AND  ($6::text = '' OR agent_role = $7)
        AND  ($8::text IS NULL OR time > $9 OR (time = $10 AND id > $11))
      ORDER  BY time ASC, id ASC
      LIMIT  $12
    `;

    const params = [
      sessionId,
      tenantId ?? null,
      tenantId ?? null,
      type || "",
      type || "",
      role || "",
      role || "",
      decoded?.time ?? null,
      decoded?.time ?? null,
      decoded?.time ?? null,
      decoded?.id ?? null,
      pageSize + 1
    ];

    const { rows } = await this._pool.query(sql, params);

    let next_cursor = null;
    if (rows.length > pageSize) {
      rows.pop();
      const lastEvent = JSON.parse(rows[rows.length - 1].raw_payload);
      next_cursor     = encodeCursor({ time: lastEvent.time, id: lastEvent.id });
    }

    const events = applyTextFilter(rows.map(r => JSON.parse(r.raw_payload)), q);
    return { events, next_cursor };
  }

  // ----- lifecycle -----

  async close() {
    if (this._pool) {
      await this._pool.end();
      this._pool = null;
    }
  }
}

module.exports = { PostgresBackend };
