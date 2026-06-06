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
  applyTextFilter
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
    label       TEXT    NOT NULL DEFAULT '',
    scopes      TEXT    NOT NULL DEFAULT '["read","write"]',
    hmac_secret TEXT,
    created_at  TEXT    NOT NULL,
    revoked_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id);
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

  async getSessionEvents(sessionId, { type = "", q = "", tenantId = null } = {}) {
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

  async getMetrics(tenantId = null) {
    // Server-wide request counters are only meaningful for admin (tenantId=null).
    // For tenant-scoped requests, set to 0 to prevent data leakage about other tenants.
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

    const acceptedRes = tenantId
      ? await this._pool.query("SELECT COUNT(*) AS n FROM events WHERE tenant_id = $1", [tenantId])
      : await this._pool.query("SELECT COUNT(*) AS n FROM events");
    const accepted = Number(acceptedRes.rows[0].n);

    const byTypeRes = tenantId
      ? await this._pool.query("SELECT type, COUNT(*) AS n FROM events WHERE tenant_id = $1 GROUP BY type", [tenantId])
      : await this._pool.query("SELECT type, COUNT(*) AS n FROM events GROUP BY type");
    const byType = {};
    for (const r of byTypeRes.rows) byType[r.type] = Number(r.n);

    const wfRes = tenantId
      ? await this._pool.query("SELECT COUNT(DISTINCT trace_id) AS n FROM sessions WHERE tenant_id = $1", [tenantId])
      : await this._pool.query("SELECT COUNT(DISTINCT trace_id) AS n FROM sessions");
    const workflow_count = Number(wfRes.rows[0].n);

    const subRes = tenantId
      ? await this._pool.query("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL AND tenant_id = $1", [tenantId])
      : await this._pool.query("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL");
    const subagent_session_count = Number(subRes.rows[0].n);

    // Compute max_tree_depth across relevant sessions (in-memory traversal).
    const depthRes = tenantId
      ? await this._pool.query("SELECT session_id, parent_session_id FROM sessions WHERE tenant_id = $1", [tenantId])
      : await this._pool.query("SELECT session_id, parent_session_id FROM sessions");
    const max_tree_depth = computeMaxDepth(depthRes.rows);

    return {
      received,
      accepted,
      rejected,
      duplicates,
      byType,
      session_count: await this.getSessionCount(tenantId),
      workflow_count,
      subagent_session_count,
      max_tree_depth
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
         (id, key_hash, key_prefix, tenant_id, label, scopes, hmac_secret, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.key_hash,
        record.key_prefix,
        record.tenant_id,
        record.label,
        record.scopes,
        record.hmac_secret ?? null,
        record.created_at
      ]
    );
  }

  async getApiKeyByHash(keyHash) {
    const { rows } = await this._pool.query(
      `SELECT id, key_hash, key_prefix, tenant_id, label, scopes, hmac_secret,
              created_at, revoked_at
       FROM   api_keys
       WHERE  key_hash = $1`,
      [keyHash]
    );
    return rows[0] || null;
  }

  async getApiKeyById(id) {
    const { rows } = await this._pool.query(
      `SELECT id, key_hash, key_prefix, tenant_id, label, scopes, hmac_secret,
              created_at, revoked_at
       FROM   api_keys
       WHERE  id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  async listApiKeys() {
    const { rows } = await this._pool.query(
      `SELECT id, key_prefix, tenant_id, label, scopes, created_at, revoked_at
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

  async getPaginatedEvents(sessionId, { type = "", q = "", tenantId = null, limit = 100, cursor = null } = {}) {
    const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);
    const decoded  = decodeCursor(cursor);

    const sql = `
      SELECT raw_payload
      FROM   events
      WHERE  session_id = $1
        AND  ($2::text IS NULL OR tenant_id = $3)
        AND  ($4::text = '' OR type = $5)
        AND  ($6::text IS NULL OR time > $7 OR (time = $8 AND id > $9))
      ORDER  BY time ASC, id ASC
      LIMIT  $10
    `;

    const params = [
      sessionId,
      tenantId ?? null,
      tenantId ?? null,
      type || "",
      type || "",
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
