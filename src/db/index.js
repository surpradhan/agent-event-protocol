"use strict";

/**
 * src/db/index.js — storage backend selector + async public API
 *
 * This module is a thin selector in front of a pluggable StorageBackend
 * (see ./backends/interface.js).  It selects the SQLite backend
 * (./backends/sqlite.js) by default, or the Postgres backend
 * (./backends/postgres.js) when STORAGE_BACKEND=postgres — both implement the
 * same interface, so no caller changes when switching engines.
 *
 * The public API is **async** — every data-access function returns a Promise.
 * better-sqlite3 is internally synchronous, so the SQLite backend resolves
 * immediately, but the async contract means swapping in an async driver
 * (Postgres) later requires no change to the ~22 call sites in the server.
 *
 * Lifecycle
 * ---------
 *   await init()     — select + open the backend and run migrations.  Must be
 *                      awaited before the server accepts traffic.  Idempotent.
 *   await closeDb()  — close the backend connection (graceful shutdown).
 *
 * Public API
 * ----------
 * init(), closeDb(), ping(), schemaReady()
 * insertEvent, getSessionEvents, getAllSessions, getSession, getSessionTree,
 * getWorkflow, listWorkflows, getSessionCount, getMetrics, incrementCounter,
 * getPaginatedSessions, getPaginatedEvents,
 * createApiKey, getApiKeyByHash, getApiKeyById, listApiKeys, revokeApiKey,
 * createProject, getProject, listProjects, getProjectEventCount,
 * countEventsBefore, pruneEventsBefore, getPolicyBlockedEvents,
 * recordApiKeyAccess, getApiKeyAccessLog
 *
 * Environment variables
 * ---------------------
 * STORAGE_BACKEND — which backend to use ("sqlite" (default) | "postgres")
 * DATABASE_PATH   — path to the SQLite file (read by the SQLite backend)
 * DATABASE_URL    — Postgres connection string (read by the Postgres backend;
 *                   falls back to standard PG* libpq env vars when unset)
 */

const { SqliteBackend } = require("./backends/sqlite");
const { PostgresBackend } = require("./backends/postgres");

// ---------------------------------------------------------------------------
// Backend selection + lifecycle
// ---------------------------------------------------------------------------

let backend = null;

/**
 * Construct the configured StorageBackend.  Switches on STORAGE_BACKEND:
 * "sqlite" (default) returns the SQLite backend, "postgres" returns the
 * Postgres backend — both implement the same interface.
 *
 * @returns {import('./backends/interface').StorageBackend}
 */
function createBackend() {
  const kind = (process.env.STORAGE_BACKEND || "sqlite").toLowerCase();
  switch (kind) {
    case "sqlite":
      return new SqliteBackend();
    case "postgres":
      return new PostgresBackend();
    default:
      throw new Error(`Unknown STORAGE_BACKEND: '${kind}' (supported: sqlite, postgres)`);
  }
}

/**
 * Initialise the storage backend (open connection + run migrations).
 * Must be awaited before any data-access function is called.  Idempotent —
 * calling it more than once is a no-op after the first successful init.
 *
 * @returns {Promise<void>}
 */
async function init() {
  if (backend) return;
  const b = createBackend();
  await b.init();
  backend = b;
}

/**
 * Return the initialised backend, throwing a clear error if init() was skipped.
 * @returns {import('./backends/interface').StorageBackend}
 */
function getBackend() {
  if (!backend) {
    throw new Error("Storage backend not initialised — call await init() before use");
  }
  return backend;
}

/**
 * Close the backend connection cleanly.  Called during graceful shutdown.
 * @returns {Promise<void>}
 */
async function closeDb() {
  if (!backend) return;
  await backend.close();
  backend = null;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Liveness check — resolves true, rejects if the connection is unusable. */
async function ping() {
  return getBackend().ping();
}

/** Readiness check — resolves true once the core schema exists. */
async function schemaReady() {
  return getBackend().schemaReady();
}

// ---------------------------------------------------------------------------
// Public API — thin async delegations to the selected backend
// ---------------------------------------------------------------------------

async function insertEvent(event, tenantId) {
  return getBackend().insertEvent(event, tenantId);
}

async function getSessionEvents(sessionId, opts) {
  return getBackend().getSessionEvents(sessionId, opts);
}

async function getAllSessions(tenantId) {
  return getBackend().getAllSessions(tenantId);
}

async function getSession(sessionId, tenantId) {
  return getBackend().getSession(sessionId, tenantId);
}

async function getSessionTree(sessionId, tenantId) {
  return getBackend().getSessionTree(sessionId, tenantId);
}

async function getWorkflow(traceId, tenantId) {
  return getBackend().getWorkflow(traceId, tenantId);
}

async function getSessionCount(tenantId) {
  return getBackend().getSessionCount(tenantId);
}

async function getMetrics(tenantId, opts) {
  return getBackend().getMetrics(tenantId, opts);
}

async function incrementCounter(key) {
  return getBackend().incrementCounter(key);
}

async function getPaginatedSessions(tenantId, opts) {
  return getBackend().getPaginatedSessions(tenantId, opts);
}

async function getPaginatedEvents(sessionId, opts) {
  return getBackend().getPaginatedEvents(sessionId, opts);
}

async function createApiKey(record) {
  return getBackend().createApiKey(record);
}

async function getApiKeyByHash(keyHash) {
  return getBackend().getApiKeyByHash(keyHash);
}

async function getApiKeyById(id) {
  return getBackend().getApiKeyById(id);
}

async function listApiKeys() {
  return getBackend().listApiKeys();
}

async function revokeApiKey(id) {
  return getBackend().revokeApiKey(id);
}

async function createProject(record) {
  return getBackend().createProject(record);
}

async function getProject(id) {
  return getBackend().getProject(id);
}

async function listProjects() {
  return getBackend().listProjects();
}

async function getProjectEventCount(tenantId) {
  return getBackend().getProjectEventCount(tenantId);
}

async function listEventTenantIds() {
  return getBackend().listEventTenantIds();
}

async function countEventsBefore(tenantId, cutoff) {
  return getBackend().countEventsBefore(tenantId, cutoff);
}

async function pruneEventsBefore(tenantId, cutoff) {
  return getBackend().pruneEventsBefore(tenantId, cutoff);
}

async function getPolicyBlockedEvents(tenantId, opts) {
  return getBackend().getPolicyBlockedEvents(tenantId, opts);
}

async function getPerformanceEvents(tenantId, opts) {
  return getBackend().getPerformanceEvents(tenantId, opts);
}

async function getWorkflowEvents(traceId, tenantId) {
  return getBackend().getWorkflowEvents(traceId, tenantId);
}

async function listWorkflows(tenantId, opts) {
  return getBackend().listWorkflows(tenantId, opts);
}

async function createSavedQuery(record) {
  return getBackend().createSavedQuery(record);
}

async function getSavedQuery(id, tenantId) {
  return getBackend().getSavedQuery(id, tenantId);
}

async function listSavedQueries(tenantId) {
  return getBackend().listSavedQueries(tenantId);
}

async function deleteSavedQuery(id, tenantId) {
  return getBackend().deleteSavedQuery(id, tenantId);
}

async function getEventsForQuery(tenantId, opts) {
  return getBackend().getEventsForQuery(tenantId, opts);
}

async function createWebhook(record) {
  return getBackend().createWebhook(record);
}

async function getWebhook(id, tenantId) {
  return getBackend().getWebhook(id, tenantId);
}

async function getWebhookSigningSecret(id, tenantId) {
  return getBackend().getWebhookSigningSecret(id, tenantId);
}

async function listWebhooks(tenantId) {
  return getBackend().listWebhooks(tenantId);
}

async function updateWebhook(id, tenantId, fields, updatedAt) {
  return getBackend().updateWebhook(id, tenantId, fields, updatedAt);
}

async function deleteWebhook(id, tenantId) {
  return getBackend().deleteWebhook(id, tenantId);
}

async function createWebhookDelivery(record) {
  return getBackend().createWebhookDelivery(record);
}

async function updateWebhookDelivery(id, tenantId, fields) {
  return getBackend().updateWebhookDelivery(id, tenantId, fields);
}

async function listWebhookDeliveries(webhookId, tenantId, opts) {
  return getBackend().listWebhookDeliveries(webhookId, tenantId, opts);
}

async function recordApiKeyAccess(entry) {
  return getBackend().recordApiKeyAccess(entry);
}

async function getApiKeyAccessLog(apiKeyId, opts) {
  return getBackend().getApiKeyAccessLog(apiKeyId, opts);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Lifecycle
  init,
  closeDb,
  // Health
  ping,
  schemaReady,
  // Events
  insertEvent,
  getSessionEvents,
  // Sessions
  getAllSessions,
  getSession,
  getSessionTree,
  getWorkflow,
  getSessionCount,
  // Metrics
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
  // Projects / tiers / quotas (Phase 13 PR-C)
  createProject,
  getProject,
  listProjects,
  getProjectEventCount,
  listEventTenantIds,
  // Retention / pruning (Phase 13 PR-D)
  countEventsBefore,
  pruneEventsBefore,
  // Analytics (Phase 14 PR-D)
  getPolicyBlockedEvents,
  // Performance profiling (Phase 15-A)
  getPerformanceEvents,
  // Workflow causation graph (Phase 15-C)
  getWorkflowEvents,
  // Workflow list (Finding #17 fix)
  listWorkflows,
  // Saved custom-analytics queries (Phase 15-B)
  createSavedQuery,
  getSavedQuery,
  listSavedQueries,
  deleteSavedQuery,
  getEventsForQuery,
  // API-key access log (Phase 14 PR-E)
  recordApiKeyAccess,
  getApiKeyAccessLog,
  // Webhooks (Phase 16-A)
  createWebhook,
  getWebhook,
  getWebhookSigningSecret,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  // Webhook deliveries (Phase 16-B)
  createWebhookDelivery,
  updateWebhookDelivery,
  listWebhookDeliveries
};
