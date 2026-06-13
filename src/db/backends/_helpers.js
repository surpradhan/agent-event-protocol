"use strict";

/**
 * src/db/backends/_helpers.js — backend-agnostic pure helpers
 *
 * These functions operate on plain arrays / strings and never touch a DB
 * handle, so every StorageBackend implementation can share them verbatim.
 * They were originally defined inline in sqlite.js (Phase 13 PR-A); PR-B
 * lifts them here so the Postgres backend reuses the *exact* same logic
 * (identical return shapes, ordering, cursor encoding, and text filtering)
 * rather than duplicating — guaranteeing cross-backend parity by construction.
 *
 * Nothing in this module is SQLite- or Postgres-specific.
 */

// ---------------------------------------------------------------------------
// Session row formatting
// ---------------------------------------------------------------------------

/**
 * Format a raw sessions row into the public session shape (all fields included).
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
 */
function buildTree(rows, rootId) {
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
 */
function computeMaxDepth(rows) {
  if (rows.length === 0) return 0;

  const idSet    = new Set(rows.map(r => r.session_id));
  const byParent = {};

  for (const row of rows) {
    const parent =
      row.parent_session_id && idSet.has(row.parent_session_id)
        ? row.parent_session_id
        : null;
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push(row.session_id);
  }

  const memo = {};
  function depthOf(id, visited = new Set()) {
    if (memo[id] !== undefined) return memo[id];
    if (visited.has(id)) return 1; // Cycle detected
    if (visited.size > 1000) return 1; // Depth limit exceeded

    const children = byParent[id] || [];
    if (children.length === 0) {
      memo[id] = 1;
      return 1;
    }

    visited.add(id);
    const childDepths = children.map(child => depthOf(child, visited));
    visited.delete(id);

    const depth = 1 + Math.max(...childDepths);
    memo[id] = depth;
    return depth;
  }

  const roots = rows.filter(
    r => !r.parent_session_id || !idSet.has(r.parent_session_id)
  );

  if (roots.length === 0) return 0;
  return Math.max(...roots.map(r => depthOf(r.session_id)));
}

// ---------------------------------------------------------------------------
// Cursor codec (base64url JSON)
// ---------------------------------------------------------------------------

/**
 * Decode a base64url cursor string.  Returns null on any error.
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
 */
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// Free-text filter
// ---------------------------------------------------------------------------

/**
 * Apply the free-text `q` filter to an array of events (mirrors the original
 * in-memory implementation: matches id, type, causation_id, or payload).
 */
function applyTextFilter(events, q) {
  if (!q) return events;
  const query = q.toLowerCase();
  return events.filter(e => {
    const payload = JSON.stringify(e.payload || {}).toLowerCase();
    return (
      e.id.toLowerCase().includes(query) ||
      e.type.toLowerCase().includes(query) ||
      (e.causation_id || "").toLowerCase().includes(query) ||
      payload.includes(query)
    );
  });
}

/**
 * Normalize an api_key_access_log row to the API shape, coercing `status` to a
 * Number (Postgres returns INTEGER columns as JS numbers already, but COUNT and
 * some drivers can surface strings — this keeps both backends byte-identical).
 * @param {object} row
 * @returns {{ id: string, api_key_id: string, tenant_id: string|null,
 *             method: string, path: string, status: number, ts: string }}
 */
function formatAccessLogRow(row) {
  return {
    id:         row.id,
    api_key_id: row.api_key_id,
    tenant_id:  row.tenant_id ?? null,
    method:     row.method,
    path:       row.path,
    status:     Number(row.status),
    ts:         row.ts
  };
}

/**
 * Normalise a saved_queries row (both backends store `spec` as JSON TEXT) into the
 * public shape, parsing the spec back into an object.
 * @param {object} row
 * @returns {{ id: string, tenant_id: string, name: string, spec: object,
 *             created_at: string, updated_at: string }}
 */
function formatSavedQueryRow(row) {
  let spec = null;
  try {
    spec = JSON.parse(row.spec);
  } catch {
    spec = null; // defensively tolerate a corrupt stored spec rather than throw
  }
  return {
    id:         row.id,
    tenant_id:  row.tenant_id,
    name:       row.name,
    spec,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * Shape a raw webhooks row into the public API representation. `event_types` is
 * stored as JSON text and parsed back to an array; `enabled` is stored 0/1 and
 * surfaced as a boolean. Defensive against a corrupt stored filter.
 *
 * @returns {{ id: string, tenant_id: string, target_url: string,
 *             event_types: string[], enabled: boolean,
 *             created_at: string, updated_at: string }}
 */
function formatWebhookRow(row) {
  let eventTypes = [];
  try {
    const parsed = JSON.parse(row.event_types);
    eventTypes = Array.isArray(parsed) ? parsed : [];
  } catch {
    eventTypes = []; // tolerate a corrupt stored filter rather than throw
  }
  return {
    id:          row.id,
    tenant_id:   row.tenant_id,
    target_url:  row.target_url,
    event_types: eventTypes,
    enabled:     row.enabled === 1 || row.enabled === true,
    created_at:  row.created_at,
    updated_at:  row.updated_at
  };
}

module.exports = {
  formatSession,
  buildTree,
  computeMaxDepth,
  decodeCursor,
  encodeCursor,
  applyTextFilter,
  formatAccessLogRow,
  formatSavedQueryRow,
  formatWebhookRow
};
