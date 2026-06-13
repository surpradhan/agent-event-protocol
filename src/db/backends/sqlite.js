"use strict";

/**
 * src/db/backends/sqlite.js — SQLite implementation of the StorageBackend contract
 *
 * Backed by better-sqlite3 (a synchronous driver).  Every public method is
 * declared `async` to satisfy the StorageBackend contract — the underlying
 * SQLite calls run synchronously and the returned Promise resolves immediately.
 * This keeps the public DB API identical to a future Postgres backend whose
 * driver is genuinely async.
 *
 * The SQL here is byte-for-byte the SQL that previously lived in src/db/index.js
 * — only the wrapping (a class + async signatures + an awaited init()) changed.
 *
 * Environment variables
 * ---------------------
 * DATABASE_PATH  — path to the SQLite file (default: <project-root>/data/aep.db)
 */

const fs               = require("fs");
const path             = require("path");
const Database         = require("better-sqlite3");
const { runMigrations } = require("../migrate");
const { StorageBackend } = require("./interface");

// Pure, backend-agnostic helpers (formatSession, buildTree, computeMaxDepth,
// cursor codec, applyTextFilter) live in ./_helpers so the SQLite and Postgres
// backends share byte-identical logic and therefore identical return shapes.
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

const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "..", "data", "aep.db");

// ---------------------------------------------------------------------------
// SqliteBackend
// ---------------------------------------------------------------------------

class SqliteBackend extends StorageBackend {
  /**
   * @param {{ dbPath?: string }} [opts]
   */
  constructor({ dbPath } = {}) {
    super();
    this._dbPath = dbPath || process.env.DATABASE_PATH || DEFAULT_DB_PATH;
    this._db = null;
    this._stmts = null;
    this._insertEventTx = null;
    this._pruneTx = null;
  }

  /**
   * Open the SQLite connection, ensure the parent directory exists, run any
   * pending migrations, and prepare statements.  Idempotent.
   */
  async init() {
    if (this._db) return;

    // Ensure the parent directory exists (e.g. data/ on first run).
    // ":memory:" and other special paths have no real directory — skip those.
    if (this._dbPath !== ":memory:") {
      const dbDir = path.dirname(this._dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    }

    const db = new Database(this._dbPath);

    // Apply any pending migrations at startup.
    runMigrations(db);

    this._db = db;
    this._prepareStatements();
  }

  /**
   * Prepare all reusable statements once (much faster than re-preparing).
   */
  _prepareStatements() {
    const db = this._db;

    this._stmts = {
      // ----- events -----
      insertEvent: db.prepare(`
        INSERT OR IGNORE INTO events (
          id, specversion, time, source, type,
          session_id, trace_id,
          parent_session_id, agent_role, subject,
          causation_id, idempotency_key,
          raw_payload, ingested_at, tenant_id
        ) VALUES (
          @id, @specversion, @time, @source, @type,
          @session_id, @trace_id,
          @parent_session_id, @agent_role, @subject,
          @causation_id, @idempotency_key,
          @raw_payload, @ingested_at, @tenant_id
        )
      `),

      // Full-access (admin/dashboard) — no tenant filter
      getEventsBySession: db.prepare(`
        SELECT raw_payload
        FROM   events
        WHERE  session_id = ?
        ORDER  BY time ASC
      `),

      getEventsBySessionAndType: db.prepare(`
        SELECT raw_payload
        FROM   events
        WHERE  session_id = ?
          AND  type       = ?
        ORDER  BY time ASC
      `),

      // Tenant-scoped variants
      getEventsBySessionTenant: db.prepare(`
        SELECT raw_payload
        FROM   events
        WHERE  session_id = ? AND tenant_id = ?
        ORDER  BY time ASC
      `),

      getEventsBySessionTypeTenant: db.prepare(`
        SELECT raw_payload
        FROM   events
        WHERE  session_id = ? AND type = ? AND tenant_id = ?
        ORDER  BY time ASC
      `),

      // ----- sessions -----
      upsertSession: db.prepare(`
        INSERT INTO sessions
          (session_id, trace_id, source, parent_session_id, agent_role,
           event_count, started_at, updated_at, tenant_id)
        VALUES
          (@session_id, @trace_id, @source, @parent_session_id, @agent_role,
           1, @time, @time, @tenant_id)
        ON CONFLICT (session_id) DO UPDATE SET
          event_count = event_count + 1,
          updated_at  = MAX(updated_at, excluded.updated_at)
      `),

      // Full-access (admin/dashboard)
      getAllSessions: db.prepare(`
        SELECT session_id, trace_id, source, parent_session_id, agent_role,
               event_count, started_at, updated_at
        FROM   sessions
        ORDER  BY updated_at DESC
      `),

      // Tenant-scoped
      getAllSessionsTenant: db.prepare(`
        SELECT session_id, trace_id, source, parent_session_id, agent_role,
               event_count, started_at, updated_at
        FROM   sessions
        WHERE  tenant_id = ?
        ORDER  BY updated_at DESC
      `),

      getSessionCount: db.prepare(`SELECT COUNT(*) AS n FROM sessions`),

      getSessionCountTenant: db.prepare(`
        SELECT COUNT(*) AS n FROM sessions WHERE tenant_id = ?
      `),

      // ----- server_metrics -----
      getCounter: db.prepare(`SELECT value FROM server_metrics WHERE key = ?`),

      incrementCounter: db.prepare(`
        UPDATE server_metrics SET value = value + 1 WHERE key = ?
      `),

      // For getMetrics: accepted count and per-type breakdown live in events table.
      getAcceptedCount: db.prepare(`SELECT COUNT(*) AS n FROM events`),
      getAcceptedCountTenant: db.prepare(`
        SELECT COUNT(*) AS n FROM events WHERE tenant_id = ?
      `),

      getByType: db.prepare(`
        SELECT type, COUNT(*) AS n FROM events GROUP BY type
      `),
      getByTypeTenant: db.prepare(`
        SELECT type, COUNT(*) AS n FROM events WHERE tenant_id = ? GROUP BY type
      `),

      // ----- session tree / workflow -----

      // Full-access
      getSession: db.prepare(`
        SELECT session_id, trace_id, source, parent_session_id, agent_role,
               event_count, started_at, updated_at
        FROM   sessions
        WHERE  session_id = ?
      `),

      // Tenant-scoped
      getSessionTenant: db.prepare(`
        SELECT session_id, trace_id, source, parent_session_id, agent_role,
               event_count, started_at, updated_at
        FROM   sessions
        WHERE  session_id = ? AND tenant_id = ?
      `),

      // Recursive CTE: fetch a session and every descendant (all depths). Full-access.
      getDescendants: db.prepare(`
        WITH RECURSIVE descendants AS (
          SELECT session_id, trace_id, source, parent_session_id, agent_role,
                 event_count, started_at, updated_at
          FROM   sessions
          WHERE  session_id = ?
          UNION ALL
          SELECT s.session_id, s.trace_id, s.source, s.parent_session_id, s.agent_role,
                 s.event_count, s.started_at, s.updated_at
          FROM   sessions s
          INNER  JOIN descendants d ON s.parent_session_id = d.session_id
        )
        SELECT * FROM descendants
      `),

      // Tenant-scoped descendants CTE
      getDescendantsTenant: db.prepare(`
        WITH RECURSIVE descendants AS (
          SELECT session_id, trace_id, source, parent_session_id, agent_role,
                 event_count, started_at, updated_at
          FROM   sessions
          WHERE  session_id = ? AND tenant_id = ?
          UNION ALL
          SELECT s.session_id, s.trace_id, s.source, s.parent_session_id, s.agent_role,
                 s.event_count, s.started_at, s.updated_at
          FROM   sessions s
          INNER  JOIN descendants d ON s.parent_session_id = d.session_id
        )
        SELECT * FROM descendants
      `),

      // Full-access
      getSessionsByTraceId: db.prepare(`
        SELECT session_id, trace_id, source, parent_session_id, agent_role,
               event_count, started_at, updated_at
        FROM   sessions
        WHERE  trace_id = ?
        ORDER  BY started_at ASC
      `),

      // Tenant-scoped
      getSessionsByTraceIdTenant: db.prepare(`
        SELECT session_id, trace_id, source, parent_session_id, agent_role,
               event_count, started_at, updated_at
        FROM   sessions
        WHERE  trace_id = ? AND tenant_id = ?
        ORDER  BY started_at ASC
      `),

      // ----- metrics additions -----

      getWorkflowCount: db.prepare(`
        SELECT COUNT(DISTINCT trace_id) AS n FROM sessions
      `),
      getWorkflowCountTenant: db.prepare(`
        SELECT COUNT(DISTINCT trace_id) AS n FROM sessions WHERE tenant_id = ?
      `),

      getSubagentSessionCount: db.prepare(`
        SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL
      `),
      getSubagentSessionCountTenant: db.prepare(`
        SELECT COUNT(*) AS n FROM sessions
        WHERE  parent_session_id IS NOT NULL AND tenant_id = ?
      `),

      getAllSessionsForDepth: db.prepare(`
        SELECT session_id, parent_session_id FROM sessions
      `),
      getAllSessionsForDepthTenant: db.prepare(`
        SELECT session_id, parent_session_id FROM sessions WHERE tenant_id = ?
      `),

      // ----- api_keys -----
      insertApiKey: db.prepare(`
        INSERT INTO api_keys
          (id, key_hash, key_prefix, tenant_id, project_id, label, scopes, hmac_secret, created_at)
        VALUES
          (@id, @key_hash, @key_prefix, @tenant_id, @project_id, @label, @scopes, @hmac_secret, @created_at)
      `),

      getApiKeyByHash: db.prepare(`
        SELECT id, key_hash, key_prefix, tenant_id, project_id, label, scopes, hmac_secret,
               created_at, revoked_at
        FROM   api_keys
        WHERE  key_hash = ?
      `),

      getApiKeyById: db.prepare(`
        SELECT id, key_hash, key_prefix, tenant_id, project_id, label, scopes, hmac_secret,
               created_at, revoked_at
        FROM   api_keys
        WHERE  id = ?
      `),

      listApiKeys: db.prepare(`
        SELECT id, key_prefix, tenant_id, project_id, label, scopes, created_at, revoked_at
        FROM   api_keys
        ORDER  BY created_at DESC
      `),

      revokeApiKey: db.prepare(`
        UPDATE api_keys SET revoked_at = ? WHERE id = ?
      `),

      // ----- projects (Phase 13 PR-C) -----
      insertProject: db.prepare(`
        INSERT INTO projects
          (id, name, tenant_id, tier, event_quota, retention_days, created_at, region)
        VALUES
          (@id, @name, @tenant_id, @tier, @event_quota, @retention_days, @created_at, @region)
      `),

      getProject: db.prepare(`
        SELECT id, name, tenant_id, tier, event_quota, retention_days, created_at, region
        FROM   projects
        WHERE  id = ?
      `),

      listProjects: db.prepare(`
        SELECT id, name, tenant_id, tier, event_quota, retention_days, created_at, region
        FROM   projects
        ORDER  BY created_at DESC
      `),

      // Per-project quota accounting: events carry tenant_id, so a project's
      // usage is the count of events for the project's tenant.
      getProjectEventCount: db.prepare(`
        SELECT COUNT(*) AS n FROM events WHERE tenant_id = ?
      `),

      // ----- retention / pruning (Phase 13 PR-D) -----

      // Count events older than a cutoff for a tenant (dry-run / reporting).
      countEventsBefore: db.prepare(`
        SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND time < ?
      `),

      // Capture the set of sessions that will lose events to a prune, BEFORE
      // the delete runs.  Both cleanup steps below are scoped to this set so a
      // prune never rewrites aggregates on sessions that lost nothing.
      affectedSessionsBefore: db.prepare(`
        SELECT DISTINCT session_id FROM events WHERE tenant_id = ? AND time < ?
      `),

      // Delete events older than a cutoff for a tenant.
      deleteEventsBefore: db.prepare(`
        DELETE FROM events WHERE tenant_id = ? AND time < ?
      `),

      // API-key access log (Phase 14 PR-E).
      insertAccessLog: db.prepare(`
        INSERT INTO api_key_access_log
          (id, api_key_id, tenant_id, method, path, status, ts)
        VALUES
          (@id, @api_key_id, @tenant_id, @method, @path, @status, @ts)
      `),

      // ----- saved queries (Phase 15-B) -----
      insertSavedQuery: db.prepare(`
        INSERT INTO saved_queries
          (id, tenant_id, name, spec, created_at, updated_at)
        VALUES
          (@id, @tenant_id, @name, @spec, @created_at, @updated_at)
      `),

      getSavedQuery: db.prepare(`
        SELECT id, tenant_id, name, spec, created_at, updated_at
        FROM   saved_queries
        WHERE  id = ? AND tenant_id = ?
      `),

      listSavedQueries: db.prepare(`
        SELECT id, tenant_id, name, spec, created_at, updated_at
        FROM   saved_queries
        WHERE  tenant_id = ?
        ORDER  BY created_at DESC
      `),

      deleteSavedQuery: db.prepare(`
        DELETE FROM saved_queries WHERE id = ? AND tenant_id = ?
      `),

      // ----- webhooks (Phase 16-A) -----
      insertWebhook: db.prepare(`
        INSERT INTO webhooks
          (id, tenant_id, target_url, event_types, enabled, created_at, updated_at)
        VALUES
          (@id, @tenant_id, @target_url, @event_types, @enabled, @created_at, @updated_at)
      `),

      getWebhook: db.prepare(`
        SELECT id, tenant_id, target_url, event_types, enabled, created_at, updated_at
        FROM   webhooks
        WHERE  id = ? AND tenant_id = ?
      `),

      listWebhooks: db.prepare(`
        SELECT id, tenant_id, target_url, event_types, enabled, created_at, updated_at
        FROM   webhooks
        WHERE  tenant_id = ?
        ORDER  BY created_at DESC
      `),

      updateWebhook: db.prepare(`
        UPDATE webhooks
        SET    target_url = @target_url,
               event_types = @event_types,
               enabled = @enabled,
               updated_at = @updated_at
        WHERE  id = @id AND tenant_id = @tenant_id
      `),

      deleteWebhook: db.prepare(`
        DELETE FROM webhooks WHERE id = ? AND tenant_id = ?
      `),

      // ----- webhook deliveries (Phase 16-B) -----
      insertWebhookDelivery: db.prepare(`
        INSERT INTO webhook_deliveries
          (id, webhook_id, tenant_id, event_id, event_type, status, attempts,
           last_status_code, last_error, created_at, updated_at)
        VALUES
          (@id, @webhook_id, @tenant_id, @event_id, @event_type, @status, @attempts,
           @last_status_code, @last_error, @created_at, @updated_at)
      `),

      getWebhookDelivery: db.prepare(`
        SELECT id, webhook_id, tenant_id, event_id, event_type, status, attempts,
               last_status_code, last_error, created_at, updated_at
        FROM   webhook_deliveries
        WHERE  id = ? AND tenant_id = ?
      `),

      updateWebhookDelivery: db.prepare(`
        UPDATE webhook_deliveries
        SET    status = @status,
               attempts = @attempts,
               last_status_code = @last_status_code,
               last_error = @last_error,
               updated_at = @updated_at
        WHERE  id = @id AND tenant_id = @tenant_id
      `)
    };

    // Transactional insert: event row + session upsert as a single unit.
    this._insertEventTx = db.transaction((event, tenantId) => {
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

      const info = this._stmts.insertEvent.run(row);

      if (info.changes === 0) {
        // id already present → duplicate; nothing more to do
        return { isDuplicate: true };
      }

      // Upsert the session summary row.
      this._stmts.upsertSession.run({
        session_id:        event.session_id,
        trace_id:          event.trace_id,
        source:            event.source,
        parent_session_id: event.parent_session_id ?? null,
        agent_role:        event.agent_role        ?? null,
        time:              event.time,
        tenant_id:         tenantId || "default"
      });

      return { isDuplicate: false };
    });

    // Transactional prune: delete old events + reconcile session summaries as a
    // single atomic unit, so a session is never left with stale aggregates.
    //
    // Both cleanup steps are scoped to ONLY the sessions that actually lost
    // events (captured before the delete).  Reconciling tenant-wide would
    // silently rewrite started_at on out-of-time-order sessions that lost
    // nothing — a value the insert path never produces — and does needless
    // per-session subquery work on the whole tenant.
    this._pruneTx = db.transaction((tenantId, cutoff) => {
      // Affected session IDs: the sessions whose events match the delete
      // predicate.  Captured BEFORE the delete (same predicate as the delete).
      const affected = this._stmts.affectedSessionsBefore
        .all(tenantId, cutoff)
        .map(r => r.session_id);

      const delInfo = this._stmts.deleteEventsBefore.run(tenantId, cutoff);
      const events_deleted = delInfo.changes;

      // Nothing was deleted → no affected sessions; skip the cleanup work.
      if (events_deleted === 0) {
        return { events_deleted: 0, sessions_deleted: 0 };
      }

      // Parameterized IN (...) list over the affected session IDs (SQLite has
      // no array binding).
      const placeholders = affected.map(() => "?").join(", ");

      // Delete-empties must run BEFORE reconcile so reconcile never hits a
      // zero-event session (which would set started_at/updated_at to NULL and
      // violate the NOT NULL columns).  Restricted to the affected set.
      const emptyInfo = this._db
        .prepare(
          `DELETE FROM sessions
           WHERE  tenant_id = ?
             AND  session_id IN (${placeholders})
             AND  session_id NOT IN (
                    SELECT DISTINCT session_id FROM events WHERE tenant_id = ?
                  )`
        )
        .run(tenantId, ...affected, tenantId);
      const sessions_deleted = emptyInfo.changes;

      // Recompute aggregates only for the affected sessions that still exist.
      this._db
        .prepare(
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
           WHERE tenant_id = ? AND session_id IN (${placeholders})`
        )
        .run(tenantId, ...affected);

      return { events_deleted, sessions_deleted };
    });
  }

  // ----- health -----

  async ping() {
    this._db.prepare("SELECT 1").get();
    return true;
  }

  async schemaReady() {
    const row = this._db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get();
    return !!row;
  }

  // ----- events -----

  async insertEvent(event, tenantId) {
    return this._insertEventTx(event, tenantId);
  }

  async getSessionEvents(sessionId, { type = "", q = "", tenantId = null } = {}) {
    let rows;

    if (tenantId) {
      // Tenant-scoped: only return events belonging to this tenant.
      if (type) {
        rows = this._stmts.getEventsBySessionTypeTenant.all(sessionId, type, tenantId);
      } else {
        rows = this._stmts.getEventsBySessionTenant.all(sessionId, tenantId);
      }
    } else {
      // Full access (admin/dashboard): no tenant filter.
      if (type) {
        rows = this._stmts.getEventsBySessionAndType.all(sessionId, type);
      } else {
        rows = this._stmts.getEventsBySession.all(sessionId);
      }
    }

    const events = rows.map(r => JSON.parse(r.raw_payload));
    return applyTextFilter(events, q);
  }

  async getAllSessions(tenantId = null) {
    const rows = tenantId
      ? this._stmts.getAllSessionsTenant.all(tenantId)
      : this._stmts.getAllSessions.all();

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
    return tenantId
      ? this._stmts.getSessionCountTenant.get(tenantId).n
      : this._stmts.getSessionCount.get().n;
  }

  async getMetrics(tenantId = null) {
    // Server-wide request counters are only meaningful for admin (tenantId=null).
    // For tenant-scoped requests, set to 0 to prevent data leakage about other tenants.
    const received   = !tenantId ? (this._stmts.getCounter.get("received")?.value   ?? 0) : 0;
    const rejected   = !tenantId ? (this._stmts.getCounter.get("rejected")?.value   ?? 0) : 0;
    const duplicates = !tenantId ? (this._stmts.getCounter.get("duplicates")?.value ?? 0) : 0;

    const accepted = tenantId
      ? this._stmts.getAcceptedCountTenant.get(tenantId).n
      : this._stmts.getAcceptedCount.get().n;

    const byTypeRows = tenantId
      ? this._stmts.getByTypeTenant.all(tenantId)
      : this._stmts.getByType.all();
    const byType = {};
    for (const row of byTypeRows) {
      byType[row.type] = row.n;
    }

    const workflow_count = tenantId
      ? this._stmts.getWorkflowCountTenant.get(tenantId).n
      : this._stmts.getWorkflowCount.get().n;

    const subagent_session_count = tenantId
      ? this._stmts.getSubagentSessionCountTenant.get(tenantId).n
      : this._stmts.getSubagentSessionCount.get().n;

    // Compute max_tree_depth across relevant sessions (in-memory traversal).
    const allRows = tenantId
      ? this._stmts.getAllSessionsForDepthTenant.all(tenantId)
      : this._stmts.getAllSessionsForDepth.all();
    const max_tree_depth = computeMaxDepth(allRows);

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
    this._stmts.incrementCounter.run(key);
  }

  // ----- session tree / workflow -----

  async getSession(sessionId, tenantId = null) {
    const row = tenantId
      ? this._stmts.getSessionTenant.get(sessionId, tenantId)
      : this._stmts.getSession.get(sessionId);
    return row ? formatSession(row) : null;
  }

  async getSessionTree(sessionId, tenantId = null) {
    const rows = tenantId
      ? this._stmts.getDescendantsTenant.all(sessionId, tenantId)
      : this._stmts.getDescendants.all(sessionId);
    if (rows.length === 0) return null;
    return buildTree(rows, sessionId);
  }

  async getWorkflow(traceId, tenantId = null) {
    const rows = tenantId
      ? this._stmts.getSessionsByTraceIdTenant.all(traceId, tenantId)
      : this._stmts.getSessionsByTraceId.all(traceId);
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
    this._stmts.insertApiKey.run(record);
  }

  async getApiKeyByHash(keyHash) {
    return this._stmts.getApiKeyByHash.get(keyHash) || null;
  }

  async getApiKeyById(id) {
    return this._stmts.getApiKeyById.get(id) || null;
  }

  async listApiKeys() {
    return this._stmts.listApiKeys.all();
  }

  async revokeApiKey(id) {
    const info = this._stmts.revokeApiKey.run(new Date().toISOString(), id);
    return info.changes > 0;
  }

  // ----- projects (Phase 13 PR-C) -----

  async createProject(record) {
    this._stmts.insertProject.run(record);
  }

  async getProject(id) {
    return this._stmts.getProject.get(id) || null;
  }

  async listProjects() {
    return this._stmts.listProjects.all();
  }

  async getProjectEventCount(tenantId) {
    return this._stmts.getProjectEventCount.get(tenantId).n;
  }

  // ----- retention / pruning (Phase 13 PR-D) -----

  async countEventsBefore(tenantId, cutoff) {
    return this._stmts.countEventsBefore.get(tenantId, cutoff).n;
  }

  async pruneEventsBefore(tenantId, cutoff) {
    return this._pruneTx(tenantId, cutoff);
  }

  // ----- analytics (Phase 14 PR-D) -----

  async getPolicyBlockedEvents(tenantId = null, { since = null, until = null } = {}) {
    // Fixed SQL with `(? IS NULL OR …)` guards (same pattern as
    // getPaginatedSessions) so the statement text is constant — SQLite caches
    // the prepared plan — while tenant/since/until each toggle on a bound NULL.
    const sql = `
      SELECT raw_payload
      FROM   events
      WHERE  type = 'policy.blocked'
        AND  (? IS NULL OR tenant_id = ?)
        AND  (? IS NULL OR time >= ?)
        AND  (? IS NULL OR time <  ?)
      ORDER  BY time ASC
    `;
    const params = [tenantId, tenantId, since, since, until, until];
    const rows = this._db.prepare(sql).all(...params);
    return rows.map(r => JSON.parse(r.raw_payload));
  }

  // ----- performance profiling (Phase 15-A) -----

  async getPerformanceEvents(tenantId = null, { since = null, until = null } = {}) {
    // The lifecycle events whose start→end pairs define latency operations
    // (task.created→completed/failed, tool.called→result). Aggregation lives in
    // the pure src/performance.js summarizer; this SELECT stays trivial and
    // dialect-identical to the Postgres backend. Constant statement text (fixed
    // IN list + `(? IS NULL OR …)` guards) keeps SQLite's plan cache warm.
    const sql = `
      SELECT raw_payload
      FROM   events
      WHERE  type IN ('task.created','task.completed','task.failed','tool.called','tool.result')
        AND  (? IS NULL OR tenant_id = ?)
        AND  (? IS NULL OR time >= ?)
        AND  (? IS NULL OR time <  ?)
      ORDER  BY time ASC
    `;
    const params = [tenantId, tenantId, since, since, until, until];
    const rows = this._db.prepare(sql).all(...params);
    return rows.map(r => JSON.parse(r.raw_payload));
  }

  // ----- workflow causation graph (Phase 15-C) -----

  async getWorkflowEvents(traceId, tenantId = null) {
    // All events of one trace, tenant-scoped, for the cross-session causation
    // graph. Pure fetch; src/workflowGraph.js shapes it, so this SELECT stays
    // trivial and dialect-identical to Postgres.
    const sql = `
      SELECT raw_payload
      FROM   events
      WHERE  trace_id = ?
        AND  (? IS NULL OR tenant_id = ?)
      ORDER  BY time ASC
    `;
    const rows = this._db.prepare(sql).all(traceId, tenantId, tenantId);
    return rows.map(r => JSON.parse(r.raw_payload));
  }

  // ----- API-key access log (Phase 14 PR-E) -----

  async recordApiKeyAccess({ id, apiKeyId, tenantId, method, path, status, ts }) {
    this._stmts.insertAccessLog.run({
      id,
      api_key_id: apiKeyId,
      tenant_id:  tenantId ?? null,
      method,
      path,
      status,
      ts
    });
  }

  async getApiKeyAccessLog(apiKeyId, { since = null, until = null, limit = 100 } = {}) {
    const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);

    // `(? IS NULL OR …)` guards keep the statement text constant for the plan
    // cache while since/until each toggle on a bound NULL.
    const where = `
      WHERE api_key_id = ?
        AND (? IS NULL OR ts >= ?)
        AND (? IS NULL OR ts <  ?)
    `;
    const whereParams = [apiKeyId, since, since, until, until];

    const total = this._db
      .prepare(`SELECT COUNT(*) AS n FROM api_key_access_log ${where}`)
      .get(...whereParams).n;

    const rows = this._db
      .prepare(`
        SELECT id, api_key_id, tenant_id, method, path, status, ts
        FROM api_key_access_log
        ${where}
        ORDER BY ts DESC
        LIMIT ?
      `)
      .all(...whereParams, pageSize);

    return { total, entries: rows.map(formatAccessLogRow) };
  }

  // ----- saved queries (Phase 15-B) -----

  async createSavedQuery(record) {
    try {
      this._stmts.insertSavedQuery.run({
        id:         record.id,
        tenant_id:  record.tenantId,
        name:       record.name,
        spec:       JSON.stringify(record.spec),
        created_at: record.createdAt,
        updated_at: record.updatedAt
      });
    } catch (err) {
      // Surface a duplicate (tenant_id, name) as a typed conflict for the route.
      if (err && /UNIQUE constraint failed/.test(err.message)) {
        const e = new Error("saved query name already exists for this tenant");
        e.code = "SAVED_QUERY_CONFLICT";
        throw e;
      }
      throw err;
    }
    return this.getSavedQuery(record.id, record.tenantId);
  }

  async getSavedQuery(id, tenantId) {
    const row = this._stmts.getSavedQuery.get(id, tenantId);
    return row ? formatSavedQueryRow(row) : null;
  }

  async listSavedQueries(tenantId) {
    return this._stmts.listSavedQueries.all(tenantId).map(formatSavedQueryRow);
  }

  async deleteSavedQuery(id, tenantId) {
    return this._stmts.deleteSavedQuery.run(id, tenantId).changes > 0;
  }

  // ----- webhooks (Phase 16-A) -----

  async createWebhook(record) {
    this._stmts.insertWebhook.run({
      id:          record.id,
      tenant_id:   record.tenantId,
      target_url:  record.targetUrl,
      event_types: JSON.stringify(record.eventTypes),
      enabled:     record.enabled ? 1 : 0,
      created_at:  record.createdAt,
      updated_at:  record.updatedAt
    });
    return this.getWebhook(record.id, record.tenantId);
  }

  async getWebhook(id, tenantId) {
    const row = this._stmts.getWebhook.get(id, tenantId);
    return row ? formatWebhookRow(row) : null;
  }

  async listWebhooks(tenantId) {
    return this._stmts.listWebhooks.all(tenantId).map(formatWebhookRow);
  }

  async updateWebhook(id, tenantId, fields, updatedAt) {
    const existing = this._stmts.getWebhook.get(id, tenantId);
    if (!existing) return null;
    const merged = {
      target_url:  fields.target_url !== undefined ? fields.target_url : existing.target_url,
      event_types:
        fields.event_types !== undefined
          ? JSON.stringify(fields.event_types)
          : existing.event_types,
      enabled:
        fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : existing.enabled,
      updated_at:  updatedAt,
      id,
      tenant_id:   tenantId
    };
    this._stmts.updateWebhook.run(merged);
    return this.getWebhook(id, tenantId);
  }

  async deleteWebhook(id, tenantId) {
    return this._stmts.deleteWebhook.run(id, tenantId).changes > 0;
  }

  // ----- webhook deliveries (Phase 16-B) -----

  async createWebhookDelivery(record) {
    this._stmts.insertWebhookDelivery.run({
      id:               record.id,
      webhook_id:       record.webhookId,
      tenant_id:        record.tenantId,
      event_id:         record.eventId,
      event_type:       record.eventType,
      status:           record.status,
      attempts:         record.attempts ?? 0,
      last_status_code: record.lastStatusCode ?? null,
      last_error:       record.lastError ?? null,
      created_at:       record.createdAt,
      updated_at:       record.updatedAt
    });
    const row = this._stmts.getWebhookDelivery.get(record.id, record.tenantId);
    return row ? formatWebhookDeliveryRow(row) : null;
  }

  async updateWebhookDelivery(id, tenantId, fields) {
    const existing = this._stmts.getWebhookDelivery.get(id, tenantId);
    if (!existing) return null;
    this._stmts.updateWebhookDelivery.run({
      id,
      tenant_id:        tenantId,
      status:           fields.status ?? existing.status,
      attempts:         fields.attempts ?? existing.attempts,
      last_status_code: fields.last_status_code ?? null,
      last_error:       fields.last_error ?? null,
      updated_at:       fields.updated_at
    });
    const row = this._stmts.getWebhookDelivery.get(id, tenantId);
    return row ? formatWebhookDeliveryRow(row) : null;
  }

  async listWebhookDeliveries(webhookId, tenantId, { since = null, until = null, limit = 100 } = {}) {
    const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);
    // `(? IS NULL OR …)` guards keep the statement text constant for the plan
    // cache while since/until each toggle on a bound NULL.
    const rows = this._db
      .prepare(`
        SELECT id, webhook_id, tenant_id, event_id, event_type, status, attempts,
               last_status_code, last_error, created_at, updated_at
        FROM   webhook_deliveries
        WHERE  webhook_id = ? AND tenant_id = ?
          AND (? IS NULL OR created_at >= ?)
          AND (? IS NULL OR created_at <  ?)
        ORDER  BY created_at DESC
        LIMIT  ?
      `)
      .all(webhookId, tenantId, since, since, until, until, pageSize);
    return rows.map(formatWebhookDeliveryRow);
  }

  // ----- custom-analytics event fetch (Phase 15-B) -----

  async getEventsForQuery(tenantId = null, { since = null, until = null } = {}) {
    // Fetch the tenant-scoped, time-windowed raw envelopes for a custom query.
    // All filtering / grouping / aggregation happens in pure JS (src/customQuery.js)
    // so this SELECT stays trivial and dialect-identical to the Postgres backend.
    const sql = `
      SELECT raw_payload
      FROM   events
      WHERE  (? IS NULL OR tenant_id = ?)
        AND  (? IS NULL OR time >= ?)
        AND  (? IS NULL OR time <  ?)
      ORDER  BY time ASC
    `;
    const params = [tenantId, tenantId, since, since, until, until];
    return this._db.prepare(sql).all(...params).map(r => JSON.parse(r.raw_payload));
  }

  // ----- pagination -----

  async getPaginatedSessions(tenantId = null, { limit = 50, cursor = null } = {}) {
    const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
    const decoded  = decodeCursor(cursor);

    // Use a fixed SQL query with parameterized WHERE conditions to ensure
    // the statement is always the same (enabling SQLite's prepared statement cache).
    const sql = `
      SELECT session_id, trace_id, source, parent_session_id, agent_role,
             event_count, started_at, updated_at
      FROM   sessions
      WHERE  (? IS NULL OR tenant_id = ?)
        AND  (? IS NULL OR updated_at < ? OR (updated_at = ? AND session_id < ?))
      ORDER  BY updated_at DESC, session_id DESC
      LIMIT  ?
    `;

    const params = [
      tenantId,                         // Check 1: tenant_id filter
      tenantId,                         // Used if tenant filter is active
      decoded?.updated_at,              // Check 2: cursor filter
      decoded?.updated_at,              // Used if cursor filter is active
      decoded?.updated_at,              // Used if cursor filter AND same timestamp
      decoded?.session_id,              // Used if cursor filter AND same timestamp
      pageSize + 1                      // fetch one extra to detect the next page
    ];

    const rows = this._db.prepare(sql).all(...params);

    let next_cursor = null;
    if (rows.length > pageSize) {
      rows.pop();
      const last   = rows[rows.length - 1];
      next_cursor  = encodeCursor({ updated_at: last.updated_at, session_id: last.session_id });
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

    // Use a fixed SQL query with parameterized WHERE conditions to ensure
    // the statement is always the same (enabling SQLite's prepared statement cache).
    const sql = `
      SELECT raw_payload
      FROM   events
      WHERE  session_id = ?
        AND  (? IS NULL OR tenant_id = ?)
        AND  (? = '' OR type = ?)
        AND  (? IS NULL OR time > ? OR (time = ? AND id > ?))
      ORDER  BY time ASC, id ASC
      LIMIT  ?
    `;

    const params = [
      sessionId,                          // session_id = ?
      tenantId,                           // tenant check: filter or NULL
      tenantId,                           // used if tenant filter is active
      type || "",                         // type check: value or empty string
      type,                               // used if type filter is active
      decoded?.time,                      // cursor check: filter or NULL
      decoded?.time,                      // used if cursor filter is active (time >)
      decoded?.time,                      // used if cursor filter AND same time (time =)
      decoded?.id,                        // used if cursor filter AND same time (id >)
      pageSize + 1                        // fetch one extra to detect the next page
    ];

    const rows = this._db.prepare(sql).all(...params);

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
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

module.exports = { SqliteBackend };
