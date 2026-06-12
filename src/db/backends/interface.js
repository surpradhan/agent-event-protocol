"use strict";

/**
 * src/db/backends/interface.js — the StorageBackend contract
 *
 * Every persistence backend (SQLite today, Postgres in a later phase) implements
 * this interface.  The contract is intentionally **async**: every data-access
 * method returns a Promise.  better-sqlite3 happens to be a synchronous driver,
 * so the SQLite backend resolves immediately, but the async signature means a
 * future Postgres backend (whose `pg` driver is async) slots in without forcing
 * another change to the ~22 call sites in server.js / auth.js.
 *
 * Lifecycle
 * ---------
 *   await backend.init()    — open the connection and run migrations.  Must be
 *                             awaited before any data-access method is called.
 *   await backend.close()   — close the connection (graceful shutdown).
 *
 * Health
 * ------
 *   await backend.ping()         — cheap "is the connection alive" check.
 *                                  Resolves true on success, rejects on failure.
 *   await backend.schemaReady()  — resolves true once migrations have created
 *                                  the core schema (used by the readiness probe).
 *
 * Data access — see method stubs below for the full surface.  All methods that
 * accept a `tenantId` treat `null` as "all tenants" (admin / dashboard access).
 *
 * This base class exists to document the contract and to fail loudly if a
 * concrete backend forgets to implement a method.  Subclasses override every
 * method; none of the stubs below should ever execute.
 */

/* eslint-disable no-unused-vars */

class StorageBackend {
  /** Open the connection and run migrations. Idempotent. */
  async init() {
    throw new Error("StorageBackend.init() not implemented");
  }

  /** Close the connection. Idempotent. */
  async close() {
    throw new Error("StorageBackend.close() not implemented");
  }

  /** Liveness check — resolves true, rejects if the connection is unusable. */
  async ping() {
    throw new Error("StorageBackend.ping() not implemented");
  }

  /** Readiness check — resolves true once the core schema exists. */
  async schemaReady() {
    throw new Error("StorageBackend.schemaReady() not implemented");
  }

  // ----- events -----

  /** Persist an accepted event. Resolves { isDuplicate: boolean }. */
  async insertEvent(event, tenantId) {
    throw new Error("StorageBackend.insertEvent() not implemented");
  }

  /** Return all events for a session (chronological), with optional filters. */
  async getSessionEvents(sessionId, opts) {
    throw new Error("StorageBackend.getSessionEvents() not implemented");
  }

  /** Return a paginated event timeline for a session. */
  async getPaginatedEvents(sessionId, opts) {
    throw new Error("StorageBackend.getPaginatedEvents() not implemented");
  }

  // ----- sessions -----

  /** Return session metadata for all sessions (most-recently-updated first). */
  async getAllSessions(tenantId) {
    throw new Error("StorageBackend.getAllSessions() not implemented");
  }

  /** Return a paginated list of sessions. */
  async getPaginatedSessions(tenantId, opts) {
    throw new Error("StorageBackend.getPaginatedSessions() not implemented");
  }

  /** Return a single session's metadata, or null. */
  async getSession(sessionId, tenantId) {
    throw new Error("StorageBackend.getSession() not implemented");
  }

  /** Return a session and all descendants as a recursive tree, or null. */
  async getSessionTree(sessionId, tenantId) {
    throw new Error("StorageBackend.getSessionTree() not implemented");
  }

  /** Return all sessions sharing a trace_id assembled into a tree, or null. */
  async getWorkflow(traceId, tenantId) {
    throw new Error("StorageBackend.getWorkflow() not implemented");
  }

  /** Return the total number of sessions. */
  async getSessionCount(tenantId) {
    throw new Error("StorageBackend.getSessionCount() not implemented");
  }

  // ----- metrics -----

  /** Return a metrics snapshot. */
  async getMetrics(tenantId) {
    throw new Error("StorageBackend.getMetrics() not implemented");
  }

  /** Atomically increment a persisted server counter. */
  async incrementCounter(key) {
    throw new Error("StorageBackend.incrementCounter() not implemented");
  }

  // ----- api keys -----

  /** Persist a new API key record. */
  async createApiKey(record) {
    throw new Error("StorageBackend.createApiKey() not implemented");
  }

  /** Look up an API key by its SHA-256 hash, or null. */
  async getApiKeyByHash(keyHash) {
    throw new Error("StorageBackend.getApiKeyByHash() not implemented");
  }

  /** Look up an API key by its UUID, or null. */
  async getApiKeyById(id) {
    throw new Error("StorageBackend.getApiKeyById() not implemented");
  }

  /** Return all API keys (without key_hash / hmac_secret). */
  async listApiKeys() {
    throw new Error("StorageBackend.listApiKeys() not implemented");
  }

  /** Mark an API key as revoked. Resolves true if a row changed. */
  async revokeApiKey(id) {
    throw new Error("StorageBackend.revokeApiKey() not implemented");
  }

  // ----- projects (Phase 13 PR-C) -----

  /** Persist a new project record. */
  async createProject(record) {
    throw new Error("StorageBackend.createProject() not implemented");
  }

  /** Look up a project by its id, or null. */
  async getProject(id) {
    throw new Error("StorageBackend.getProject() not implemented");
  }

  /** Return all projects (most-recently-created first). */
  async listProjects() {
    throw new Error("StorageBackend.listProjects() not implemented");
  }

  /**
   * Count accepted events that currently count against a project's quota.
   * Quota is metered per project by the project's tenant_id (events carry
   * tenant_id, not project_id). Resolves a Number.
   */
  async getProjectEventCount(tenantId) {
    throw new Error("StorageBackend.getProjectEventCount() not implemented");
  }

  // ----- retention / pruning (Phase 13 PR-D) -----

  /**
   * Delete events for a tenant whose `time` is strictly older than `cutoff`
   * (an ISO-8601 string), then reconcile the derived `sessions` summary rows:
   * sessions that lost all their events are deleted, and sessions that lost
   * some are recomputed (event_count / started_at / updated_at) from their
   * remaining events.  The whole operation runs in a single transaction.
   *
   * Retention is scoped by the project's `tenant_id` (events carry tenant_id,
   * not project_id) — exactly like quota metering in PR-C.
   *
   * @param {string} tenantId  the project's tenant
   * @param {string} cutoff    ISO-8601 timestamp; events with time < cutoff go
   * @returns {Promise<{ events_deleted: number, sessions_deleted: number }>}
   *          counts as native numbers on every backend.
   */
  async pruneEventsBefore(tenantId, cutoff) {
    throw new Error("StorageBackend.pruneEventsBefore() not implemented");
  }

  /**
   * Count events for a tenant whose `time` is strictly older than `cutoff`
   * (an ISO-8601 string), without deleting anything.  Used by the prune
   * job's `--dry-run` mode to report what *would* be deleted.  Resolves a Number.
   *
   * @param {string} tenantId
   * @param {string} cutoff  ISO-8601 timestamp
   * @returns {Promise<number>}
   */
  async countEventsBefore(tenantId, cutoff) {
    throw new Error("StorageBackend.countEventsBefore() not implemented");
  }

  // ----- analytics (Phase 14 PR-D) -----

  /**
   * Return the full `policy.blocked` event envelopes for a tenant, optionally
   * restricted to a time window, ordered by `time` ascending.  Tenant-scoped
   * exactly like the read API: `null` tenantId means all tenants (dashboard).
   *
   * The aggregation itself lives in the pure src/analytics.js summarizer, so this
   * method stays a trivial, dialect-identical SELECT on both backends.
   *
   * @param {string|null} tenantId
   * @param {{ since?: string|null, until?: string|null }} [opts]
   *        since — inclusive ISO-8601 lower bound (`time >= since`)
   *        until — exclusive ISO-8601 upper bound (`time < until`)
   * @returns {Promise<Array<object>>} parsed event envelopes
   */
  async getPolicyBlockedEvents(tenantId, opts) {
    throw new Error("StorageBackend.getPolicyBlockedEvents() not implemented");
  }

  // ----- performance profiling (Phase 15-A) -----

  /**
   * Fetch the lifecycle events (task.created/completed/failed,
   * tool.called/result) used to compute latency profiling, tenant-scoped and
   * optionally time-windowed. Aggregation is done by the pure
   * src/performance.js summarizer, so this returns raw envelopes.
   * @param {string|null} tenantId
   * @param {{ since?: string|null, until?: string|null }} [opts]
   *        since — inclusive ISO-8601 lower bound (`time >= since`)
   *        until — exclusive ISO-8601 upper bound (`time < until`)
   * @returns {Promise<Array<object>>} parsed event envelopes
   */
  async getPerformanceEvents(tenantId, opts) {
    throw new Error("StorageBackend.getPerformanceEvents() not implemented");
  }

  // ----- workflow causation graph (Phase 15-C) -----

  /**
   * Fetch all events of one trace (tenant-scoped) for the cross-session causation
   * graph. Shaping is done by the pure src/workflowGraph.js builder.
   * @param {string} traceId
   * @param {string|null} tenantId
   * @returns {Promise<Array<object>>} parsed event envelopes (time ASC)
   */
  async getWorkflowEvents(traceId, tenantId) {
    throw new Error("StorageBackend.getWorkflowEvents() not implemented");
  }

  // ----- saved queries (Phase 15-B) -----

  /**
   * Persist a saved custom-analytics query. Throws an Error with
   * `code === "SAVED_QUERY_CONFLICT"` when (tenant_id, name) already exists.
   * @param {{ id: string, tenantId: string, name: string, spec: object,
   *           createdAt: string, updatedAt: string }} record
   * @returns {Promise<object>} the stored row (spec parsed)
   */
  async createSavedQuery(record) {
    throw new Error("StorageBackend.createSavedQuery() not implemented");
  }

  /** Fetch one tenant-scoped saved query by id, or null. */
  async getSavedQuery(id, tenantId) {
    throw new Error("StorageBackend.getSavedQuery() not implemented");
  }

  /** List a tenant's saved queries (newest first). */
  async listSavedQueries(tenantId) {
    throw new Error("StorageBackend.listSavedQueries() not implemented");
  }

  /** Delete one tenant-scoped saved query by id; resolves true if a row was removed. */
  async deleteSavedQuery(id, tenantId) {
    throw new Error("StorageBackend.deleteSavedQuery() not implemented");
  }

  /**
   * Fetch tenant-scoped, time-windowed raw event envelopes for a custom query.
   * All filtering/grouping/aggregation is done by src/customQuery.js in pure JS.
   * @param {string|null} tenantId
   * @param {{ since?: string|null, until?: string|null }} [opts]
   * @returns {Promise<Array<object>>}
   */
  async getEventsForQuery(tenantId, opts) {
    throw new Error("StorageBackend.getEventsForQuery() not implemented");
  }

  // ----- API-key access log (Phase 14 PR-E) -----

  /**
   * Append one API-key access record.  Called fire-and-forget from the access-log
   * middleware (only when ACCESS_LOG_ENABLED) after a response finishes, so it must
   * never throw into the request path — callers swallow rejections.
   *
   * @param {{ id: string, apiKeyId: string, tenantId: string|null,
   *           method: string, path: string, status: number, ts: string }} entry
   * @returns {Promise<void>}
   */
  async recordApiKeyAccess(entry) {
    throw new Error("StorageBackend.recordApiKeyAccess() not implemented");
  }

  /**
   * Read the access log for one API key, most-recent-first, optionally restricted
   * to a time window.  Resolves `{ total, entries }` where `total` is the count of
   * all matching rows (ignoring `limit`) and `entries` is at most `limit` rows.
   *
   * @param {string} apiKeyId
   * @param {{ since?: string|null, until?: string|null, limit?: number }} [opts]
   *        since — inclusive ISO-8601 lower bound (`ts >= since`)
   *        until — exclusive ISO-8601 upper bound (`ts < until`)
   *        limit — max rows returned (caller clamps; default 100)
   * @returns {Promise<{ total: number, entries: Array<object> }>}
   */
  async getApiKeyAccessLog(apiKeyId, opts) {
    throw new Error("StorageBackend.getApiKeyAccessLog() not implemented");
  }
}

module.exports = { StorageBackend };
