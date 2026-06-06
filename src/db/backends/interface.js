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
}

module.exports = { StorageBackend };
