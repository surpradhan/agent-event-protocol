/**
 * Agent Event Protocol - Main Entry Point
 *
 * Public SDK API for the Agent Event Protocol (AEP).
 * Use this module to validate events, query sessions, and manage workflow data.
 *
 * @example
 * const aep = require('agent-event-protocol');
 * const { isValid, errors } = aep.validateEvent(eventEnvelope);
 * const sessions = aep.getAllSessions();
 */

// Validation API
const { validateEvent, CORE_EVENT_TYPES } = require("./src/validator");

// Database Query API
const db = require("./src/db");

// ============================================================================
// Public API - Validation
// ============================================================================
// validateEvent and CORE_EVENT_TYPES are imported from src/validator above

// ============================================================================
// Public API - Session Queries
// ============================================================================

/**
 * Get all sessions, most recently updated first.
 * Optionally filter by tenant.
 *
 * @param {string|null} tenantId — (optional) tenant to scope results
 * @returns {Array<{session_id, trace_id, source, event_count, started_at, updated_at}>}
 */
function getAllSessions(tenantId = null) {
  return db.getAllSessions(tenantId);
}

/**
 * Get a single session by ID.
 *
 * @param {string} sessionId
 * @param {string|null} tenantId — (optional) tenant to scope results
 * @returns {object|null}
 */
function getSession(sessionId, tenantId = null) {
  return db.getSession(sessionId, tenantId);
}

/**
 * Get total number of sessions.
 *
 * @param {string|null} tenantId — (optional) tenant to scope results
 * @returns {number}
 */
function getSessionCount(tenantId = null) {
  return db.getSessionCount(tenantId);
}

/**
 * Get all events for a session, with optional filtering.
 *
 * @param {string} sessionId
 * @param {{ type?: string, q?: string, tenantId?: string|null }} opts
 * @returns {object[]}
 */
function getSessionEvents(sessionId, opts = {}) {
  return db.getSessionEvents(sessionId, opts);
}

/**
 * Get a session and all its descendants as a recursive tree.
 *
 * @param {string} sessionId
 * @param {string|null} tenantId
 * @returns {{ session: object, children: object[] } | null}
 */
function getSessionTree(sessionId, tenantId = null) {
  return db.getSessionTree(sessionId, tenantId);
}

/**
 * Get all sessions in a workflow (by trace_id) as a tree structure.
 *
 * @param {string} traceId
 * @param {string|null} tenantId
 * @returns {{ trace_id: string, session_count: number, tree: object[] } | null}
 */
function getWorkflow(traceId, tenantId = null) {
  return db.getWorkflow(traceId, tenantId);
}

/**
 * Get paginated list of sessions with cursor-based navigation.
 *
 * @param {string|null} tenantId
 * @param {{ limit?: number|string, cursor?: string }} opts
 * @returns {{ sessions: object[], next_cursor: string|null }}
 */
function getPaginatedSessions(tenantId = null, opts = {}) {
  return db.getPaginatedSessions(tenantId, opts);
}

/**
 * Get paginated list of events for a session with cursor-based navigation.
 *
 * @param {string} sessionId
 * @param {{ type?: string, q?: string, tenantId?: string|null, limit?: number|string, cursor?: string }} opts
 * @returns {{ events: object[], next_cursor: string|null }}
 */
function getPaginatedEvents(sessionId, opts = {}) {
  return db.getPaginatedEvents(sessionId, opts);
}

// ============================================================================
// Public API - Metrics
// ============================================================================

/**
 * Get server metrics including event counts, workflow statistics, and tree depth.
 *
 * @param {string|null} tenantId — (optional) tenant to scope results
 * @returns {{ received, accepted, rejected, duplicates, byType, session_count, workflow_count, subagent_session_count, max_tree_depth }}
 */
function getMetrics(tenantId = null) {
  return db.getMetrics(tenantId);
}

// ============================================================================
// Public API - API Key Management
// ============================================================================

/**
 * Get an API key by its hash (internal use).
 *
 * @param {string} keyHash — SHA-256 hash of the API key
 * @returns {object|null}
 */
function getApiKeyByHash(keyHash) {
  return db.getApiKeyByHash(keyHash);
}

/**
 * List all API keys (without sensitive data).
 *
 * @returns {object[]}
 */
function listApiKeys() {
  return db.listApiKeys();
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Validation
  validateEvent,
  CORE_EVENT_TYPES,

  // Session queries
  getAllSessions,
  getSession,
  getSessionCount,
  getSessionEvents,
  getSessionTree,
  getWorkflow,
  getPaginatedSessions,
  getPaginatedEvents,

  // Metrics
  getMetrics,

  // API Key management
  getApiKeyByHash,
  listApiKeys,

  // Advanced: direct db access for power users
  db,

  // Version (from package.json)
  version: require("./package.json").version
};
