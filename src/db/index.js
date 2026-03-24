"use strict";

/**
 * src/db/index.js — SQLite-backed persistence layer
 *
 * Replaces the in-memory Map / Set stores from the original server.js with a
 * durable SQLite database.  The public interface is intentionally thin and
 * mirrors the operations the server previously performed against its Maps/Sets,
 * so swapping in this module requires minimal changes to server.js.
 *
 * Public API
 * ----------
 * insertEvent(event)          → { isDuplicate: boolean }
 * getSessionEvents(sid, opts) → Event[]   (sorted by time ASC, filtered)
 * getAllSessions()            → SessionMeta[]  (sorted by updated_at DESC)
 * getSessionCount()          → number
 * getMetrics()               → MetricsSnapshot
 * incrementCounter(key)      → void   (key: 'received'|'rejected'|'duplicates')
 *
 * All functions are synchronous (better-sqlite3 is a sync driver).
 *
 * Environment variables
 * ---------------------
 * DATABASE_PATH  — path to the SQLite file (default: <project-root>/data/aep.db)
 */

const fs           = require("fs");
const path         = require("path");
const Database     = require("better-sqlite3");
const { runMigrations } = require("./migrate");

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "aep.db");
const dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH;

// Ensure the parent directory exists (e.g. data/ on first run).
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Apply any pending migrations at startup.
runMigrations(db);

// ---------------------------------------------------------------------------
// Prepared statements (created once, reused for every call — much faster)
// ---------------------------------------------------------------------------

const stmts = {
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
      (id, key_hash, key_prefix, tenant_id, label, scopes, hmac_secret, created_at)
    VALUES
      (@id, @key_hash, @key_prefix, @tenant_id, @label, @scopes, @hmac_secret, @created_at)
  `),

  getApiKeyByHash: db.prepare(`
    SELECT id, key_hash, key_prefix, tenant_id, label, scopes, hmac_secret,
           created_at, revoked_at
    FROM   api_keys
    WHERE  key_hash = ?
  `),

  getApiKeyById: db.prepare(`
    SELECT id, key_hash, key_prefix, tenant_id, label, scopes, hmac_secret,
           created_at, revoked_at
    FROM   api_keys
    WHERE  id = ?
  `),

  listApiKeys: db.prepare(`
    SELECT id, key_prefix, tenant_id, label, scopes, created_at, revoked_at
    FROM   api_keys
    ORDER  BY created_at DESC
  `),

  revokeApiKey: db.prepare(`
    UPDATE api_keys SET revoked_at = ? WHERE id = ?
  `)
};

// ---------------------------------------------------------------------------
// Transactional insert: event row + session upsert as a single unit
// ---------------------------------------------------------------------------

const insertEventTx = db.transaction((event, tenantId) => {
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

  const info = stmts.insertEvent.run(row);

  if (info.changes === 0) {
    // id already present → duplicate; nothing more to do
    return { isDuplicate: true };
  }

  // Upsert the session summary row.
  stmts.upsertSession.run({
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist an accepted event.  Idempotent: re-submitting the same event.id
 * returns { isDuplicate: true } without modifying any rows.
 *
 * @param {object} event      — validated AEP event envelope
 * @param {string} [tenantId] — tenant that owns this event (from the API key)
 * @returns {{ isDuplicate: boolean }}
 */
function insertEvent(event, tenantId) {
  return insertEventTx(event, tenantId);
}

/**
 * Return the full event objects for a session, sorted chronologically.
 * Optionally filter by event type and/or a free-text query.
 *
 * @param {string} sessionId
 * @param {{ type?: string, q?: string, tenantId?: string|null }} opts
 * @returns {object[]}
 */
function getSessionEvents(sessionId, { type = "", q = "", tenantId = null } = {}) {
  let rows;

  if (tenantId) {
    // Tenant-scoped: only return events belonging to this tenant.
    if (type) {
      rows = stmts.getEventsBySessionTypeTenant.all(sessionId, type, tenantId);
    } else {
      rows = stmts.getEventsBySessionTenant.all(sessionId, tenantId);
    }
  } else {
    // Full access (admin/dashboard): no tenant filter.
    if (type) {
      rows = stmts.getEventsBySessionAndType.all(sessionId, type);
    } else {
      rows = stmts.getEventsBySession.all(sessionId);
    }
  }

  // Parse raw_payload back to event objects.
  let events = rows.map(r => JSON.parse(r.raw_payload));

  // Free-text filter (mirrors the original in-memory implementation).
  if (q) {
    const query = q.toLowerCase();
    events = events.filter(e => {
      const payload = JSON.stringify(e.payload || {}).toLowerCase();
      return (
        e.id.toLowerCase().includes(query) ||
        e.type.toLowerCase().includes(query) ||
        (e.causation_id || "").toLowerCase().includes(query) ||
        payload.includes(query)
      );
    });
  }

  return events;
}

/**
 * Return session metadata for all sessions, most-recently-updated first.
 * Shape is identical to what the old Map-iteration produced.
 *
 * @param {string|null} [tenantId] — if provided, only return sessions for this tenant
 * @returns {Array<{session_id, trace_id, source, event_count, started_at, updated_at}>}
 */
function getAllSessions(tenantId = null) {
  const rows = tenantId
    ? stmts.getAllSessionsTenant.all(tenantId)
    : stmts.getAllSessions.all();

  return rows.map(row => ({
    session_id:  row.session_id,
    trace_id:    row.trace_id,
    source:      row.source,
    event_count: row.event_count,
    started_at:  row.started_at,
    updated_at:  row.updated_at
  }));
}

/**
 * Return the total number of sessions.
 * @param {string|null} [tenantId]
 * @returns {number}
 */
function getSessionCount(tenantId = null) {
  return tenantId
    ? stmts.getSessionCountTenant.get(tenantId).n
    : stmts.getSessionCount.get().n;
}

/**
 * Return a metrics snapshot consistent with the original /metrics response.
 *
 * - received / rejected / duplicates are server-wide counters (not per-tenant).
 * - accepted, byType, session_count are tenant-scoped when tenantId is given.
 * - session_count is derived from the sessions table.
 *
 * @param {string|null} [tenantId] — scope metrics to this tenant (null = all)
 * @returns {{ received, accepted, rejected, duplicates, byType, session_count }}
 */
function getMetrics(tenantId = null) {
  // Server-wide request counters are not per-tenant.
  const received   = stmts.getCounter.get("received")?.value   ?? 0;
  const rejected   = stmts.getCounter.get("rejected")?.value   ?? 0;
  const duplicates = stmts.getCounter.get("duplicates")?.value ?? 0;

  const accepted = tenantId
    ? stmts.getAcceptedCountTenant.get(tenantId).n
    : stmts.getAcceptedCount.get().n;

  const byTypeRows = tenantId
    ? stmts.getByTypeTenant.all(tenantId)
    : stmts.getByType.all();
  const byType = {};
  for (const row of byTypeRows) {
    byType[row.type] = row.n;
  }

  const workflow_count = tenantId
    ? stmts.getWorkflowCountTenant.get(tenantId).n
    : stmts.getWorkflowCount.get().n;

  const subagent_session_count = tenantId
    ? stmts.getSubagentSessionCountTenant.get(tenantId).n
    : stmts.getSubagentSessionCount.get().n;

  // Compute max_tree_depth across relevant sessions (in-memory traversal).
  const allRows = tenantId
    ? stmts.getAllSessionsForDepthTenant.all(tenantId)
    : stmts.getAllSessionsForDepth.all();
  const max_tree_depth = computeMaxDepth(allRows);

  return {
    received,
    accepted,
    rejected,
    duplicates,
    byType,
    session_count: getSessionCount(tenantId),
    workflow_count,
    subagent_session_count,
    max_tree_depth
  };
}

/**
 * Atomically increment one of the persisted server counters.
 * Valid keys: 'received', 'rejected', 'duplicates'.
 *
 * @param {'received'|'rejected'|'duplicates'} key
 */
function incrementCounter(key) {
  stmts.incrementCounter.run(key);
}

// ---------------------------------------------------------------------------
// Tree helpers (pure, operate on in-memory arrays)
// ---------------------------------------------------------------------------

/**
 * Format a raw sessions row into the public session shape (all fields included).
 * @param {object} row
 * @returns {object}
 */
function formatSession(row) {
  return {
    session_id:        row.session_id,
    trace_id:          row.trace_id,
    source:            row.source,
    parent_session_id: row.parent_session_id ?? null,
    agent_role:        row.agent_role        ?? null,
    event_count:       row.event_count,
    started_at:        row.started_at,
    updated_at:        row.updated_at
  };
}

/**
 * Given a flat array of session rows and a root session_id, build a recursive
 * tree structure: { session, children: [{ session, children: [...] }] }.
 *
 * @param {object[]} rows    — all rows to consider (must include the root row)
 * @param {string}   rootId  — session_id of the tree root
 * @returns {{ session: object, children: object[] }}
 */
function buildTree(rows, rootId) {
  // Index rows by session_id and build parent→children adjacency list.
  const byId     = {};
  const byParent = {};

  for (const row of rows) {
    byId[row.session_id] = row;
    const parent = row.parent_session_id || null;
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push(row.session_id);
  }

  function buildNode(id) {
    const childIds = byParent[id] || [];
    return {
      session:  formatSession(byId[id]),
      children: childIds.map(buildNode)
    };
  }

  return buildNode(rootId);
}

/**
 * Compute the maximum tree depth across all sessions.  Groups sessions by
 * trace_id, builds a tree per trace, then returns the deepest leaf depth.
 * A single-session workflow has depth 1.
 *
 * @param {Array<{ session_id: string, parent_session_id: string|null }>} rows
 * @returns {number}
 */
function computeMaxDepth(rows) {
  if (rows.length === 0) return 0;

  const idSet    = new Set(rows.map(r => r.session_id));
  const byParent = {};

  for (const row of rows) {
    // A session is a root if its parent doesn't exist in the current set.
    const parent =
      row.parent_session_id && idSet.has(row.parent_session_id)
        ? row.parent_session_id
        : null;
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push(row.session_id);
  }

  function depthOf(id) {
    const children = byParent[id] || [];
    if (children.length === 0) return 1;
    return 1 + Math.max(...children.map(depthOf));
  }

  const roots = rows.filter(
    r => !r.parent_session_id || !idSet.has(r.parent_session_id)
  );

  if (roots.length === 0) return 0;
  return Math.max(...roots.map(r => depthOf(r.session_id)));
}

// ---------------------------------------------------------------------------
// Public API — tree / workflow
// ---------------------------------------------------------------------------

/**
 * Return a single session's metadata, or null if not found.
 *
 * @param {string} sessionId
 * @param {string|null} [tenantId]
 * @returns {object|null}
 */
function getSession(sessionId, tenantId = null) {
  const row = tenantId
    ? stmts.getSessionTenant.get(sessionId, tenantId)
    : stmts.getSession.get(sessionId);
  return row ? formatSession(row) : null;
}

/**
 * Return the session and all of its descendants as a recursive tree.
 * Shape: { session, children: [{ session, children: [...] }] }
 *
 * @param {string} sessionId
 * @param {string|null} [tenantId]
 * @returns {{ session: object, children: object[] } | null}
 */
function getSessionTree(sessionId, tenantId = null) {
  const rows = tenantId
    ? stmts.getDescendantsTenant.all(sessionId, tenantId)
    : stmts.getDescendants.all(sessionId);
  if (rows.length === 0) return null;
  return buildTree(rows, sessionId);
}

/**
 * Return all sessions sharing a trace_id assembled into a tree (or forest of
 * trees if there are multiple roots).  The primary entry point for viewing a
 * full multi-agent workflow.
 *
 * @param {string} traceId
 * @param {string|null} [tenantId]
 * @returns {{ trace_id: string, sessions: object[], tree: object[] } | null}
 */
function getWorkflow(traceId, tenantId = null) {
  const rows = tenantId
    ? stmts.getSessionsByTraceIdTenant.all(traceId, tenantId)
    : stmts.getSessionsByTraceId.all(traceId);
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

// ---------------------------------------------------------------------------
// API Key management
// ---------------------------------------------------------------------------

/**
 * Persist a new API key record.
 * The caller is responsible for hashing the key before calling this.
 *
 * @param {{ id, key_hash, key_prefix, tenant_id, label, scopes, hmac_secret, created_at }} record
 */
function createApiKey(record) {
  stmts.insertApiKey.run(record);
}

/**
 * Look up an API key by its SHA-256 hash.
 * Returns the full record (including hmac_secret) or null if not found.
 *
 * @param {string} keyHash  — SHA-256 hex digest of the raw key
 * @returns {object|null}
 */
function getApiKeyByHash(keyHash) {
  return stmts.getApiKeyByHash.get(keyHash) || null;
}

/**
 * Look up an API key by its UUID.
 *
 * @param {string} id
 * @returns {object|null}
 */
function getApiKeyById(id) {
  return stmts.getApiKeyById.get(id) || null;
}

/**
 * Return all API keys (without key_hash or hmac_secret for safety).
 *
 * @returns {object[]}
 */
function listApiKeys() {
  return stmts.listApiKeys.all();
}

/**
 * Mark an API key as revoked.
 *
 * @param {string} id   — the key's UUID
 * @returns {boolean}   — true if a row was updated
 */
function revokeApiKey(id) {
  const info = stmts.revokeApiKey.run(new Date().toISOString(), id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Cursor-based pagination helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64url cursor string.  Returns null on any error.
 * @param {string|undefined} cursor
 * @returns {object|null}
 */
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * Encode a cursor object to a base64url string.
 * @param {object} obj
 * @returns {string}
 */
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/**
 * Return a paginated list of sessions, most-recently-updated first.
 *
 * Cursor encodes { updated_at, session_id } of the last returned session.
 * Secondary sort on session_id ensures a stable, unambiguous ordering when
 * multiple sessions share the same updated_at timestamp.
 *
 * @param {string|null} tenantId
 * @param {{ limit?: number|string, cursor?: string }} opts
 * @returns {{ sessions: object[], next_cursor: string|null }}
 */
function getPaginatedSessions(tenantId = null, { limit = 50, cursor = null } = {}) {
  const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
  const decoded  = decodeCursor(cursor);

  const conditions = [];
  const params     = [];

  if (tenantId) {
    conditions.push("tenant_id = ?");
    params.push(tenantId);
  }

  if (decoded && decoded.updated_at && decoded.session_id) {
    conditions.push(
      "(updated_at < ? OR (updated_at = ? AND session_id < ?))"
    );
    params.push(decoded.updated_at, decoded.updated_at, decoded.session_id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT session_id, trace_id, source, parent_session_id, agent_role,
           event_count, started_at, updated_at
    FROM   sessions
    ${where}
    ORDER  BY updated_at DESC, session_id DESC
    LIMIT  ?
  `;
  params.push(pageSize + 1); // fetch one extra to detect the next page

  const rows = db.prepare(sql).all(...params);

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

/**
 * Return a paginated event timeline for a single session (chronological order).
 *
 * Cursor encodes { time, id } of the last returned event.  Secondary sort on
 * the event id (UUID) ensures stability when two events share an identical
 * timestamp.
 *
 * Note: the optional `q` free-text filter is applied in memory after the SQL
 * cursor window is fetched.  When `q` is active, a page may contain fewer
 * items than `limit`; next_cursor is still valid and clients should continue
 * paging until next_cursor is null.
 *
 * @param {string} sessionId
 * @param {{ type?: string, q?: string, tenantId?: string|null, limit?: number|string, cursor?: string }} opts
 * @returns {{ events: object[], next_cursor: string|null }}
 */
function getPaginatedEvents(sessionId, { type = "", q = "", tenantId = null, limit = 100, cursor = null } = {}) {
  const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);
  const decoded  = decodeCursor(cursor);

  const conditions = ["session_id = ?"];
  const params     = [sessionId];

  if (tenantId) {
    conditions.push("tenant_id = ?");
    params.push(tenantId);
  }

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  if (decoded && decoded.time && decoded.id) {
    conditions.push("(time > ? OR (time = ? AND id > ?))");
    params.push(decoded.time, decoded.time, decoded.id);
  }

  const sql = `
    SELECT raw_payload
    FROM   events
    WHERE  ${conditions.join(" AND ")}
    ORDER  BY time ASC, id ASC
    LIMIT  ?
  `;
  params.push(pageSize + 1);

  let rows = db.prepare(sql).all(...params);

  let next_cursor = null;
  if (rows.length > pageSize) {
    rows.pop();
    const lastEvent = JSON.parse(rows[rows.length - 1].raw_payload);
    next_cursor     = encodeCursor({ time: lastEvent.time, id: lastEvent.id });
  }

  let events = rows.map(r => JSON.parse(r.raw_payload));

  // Free-text filter applied in-memory (matches original getSessionEvents behaviour)
  if (q) {
    const query = q.toLowerCase();
    events = events.filter(e => {
      const payload = JSON.stringify(e.payload || {}).toLowerCase();
      return (
        e.id.toLowerCase().includes(query) ||
        e.type.toLowerCase().includes(query) ||
        (e.causation_id || "").toLowerCase().includes(query) ||
        payload.includes(query)
      );
    });
  }

  return { events, next_cursor };
}

// ---------------------------------------------------------------------------
// Graceful-shutdown helper
// ---------------------------------------------------------------------------

/**
 * Close the SQLite connection cleanly.
 * Called during graceful shutdown (SIGTERM / SIGINT).
 */
function closeDb() {
  db.close();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  insertEvent,
  getSessionEvents,
  getAllSessions,
  getSession,
  getSessionTree,
  getWorkflow,
  getSessionCount,
  getMetrics,
  incrementCounter,
  // Pagination
  getPaginatedSessions,
  getPaginatedEvents,
  // API key management
  createApiKey,
  getApiKeyByHash,
  getApiKeyById,
  listApiKeys,
  revokeApiKey,
  // Graceful shutdown
  closeDb,
  // Expose the raw db instance for tests / introspection — not used by server.js
  _db: db
};
