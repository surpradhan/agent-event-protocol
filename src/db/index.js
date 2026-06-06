"use strict";

/**
 * src/db/index.js — storage backend selector + async public API
 *
 * This module is a thin selector in front of a pluggable StorageBackend
 * (see ./backends/interface.js).  Today it always selects the SQLite backend
 * (./backends/sqlite.js); a future phase adds a Postgres backend behind the
 * same interface without touching any caller.
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
 * getWorkflow, getSessionCount, getMetrics, incrementCounter,
 * getPaginatedSessions, getPaginatedEvents,
 * createApiKey, getApiKeyByHash, getApiKeyById, listApiKeys, revokeApiKey
 *
 * Environment variables
 * ---------------------
 * STORAGE_BACKEND — which backend to use (default: "sqlite"; only "sqlite" today)
 * DATABASE_PATH   — path to the SQLite file (read by the SQLite backend)
 */

const { SqliteBackend } = require("./backends/sqlite");

// ---------------------------------------------------------------------------
// Backend selection + lifecycle
// ---------------------------------------------------------------------------

let backend = null;

/**
 * Construct the configured StorageBackend.  Today this always returns the
 * SQLite backend; a future phase switches on STORAGE_BACKEND to return a
 * Postgres backend implementing the same interface.
 *
 * @returns {import('./backends/interface').StorageBackend}
 */
function createBackend() {
  const kind = (process.env.STORAGE_BACKEND || "sqlite").toLowerCase();
  switch (kind) {
    case "sqlite":
      return new SqliteBackend();
    default:
      throw new Error(`Unknown STORAGE_BACKEND: '${kind}' (supported: sqlite)`);
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

async function getMetrics(tenantId) {
  return getBackend().getMetrics(tenantId);
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
  revokeApiKey
};
