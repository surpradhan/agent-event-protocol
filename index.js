/**
 * Agent Event Protocol - Main Entry Point
 *
 * Public SDK API for the Agent Event Protocol (AEP).
 * Use this module to validate events, query sessions, and manage workflow data.
 *
 * ## validateEvent
 *
 * Validates an event envelope against the AEP v0.2 specification.
 *
 * Returns { valid: boolean, errors: string[] } where:
 * - `valid: true` means the event is ready to ingest
 * - `errors` is an array of validation messages
 * - Messages starting with "[warn]" are non-blocking warnings (e.g., schema resolution failures)
 * - Other messages are blocking errors that prevent ingestion
 *
 * @example
 * const aep = require('agent-event-protocol');
 * const { valid, errors } = aep.validateEvent(eventEnvelope);
 * if (!valid) {
 *   const blockingErrors = errors.filter(e => !e.startsWith("[warn]"));
 *   console.error("Validation failed:", blockingErrors);
 * }
 * const sessions = aep.getAllSessions();
 */

// Validation API
const { validateEvent, CORE_EVENT_TYPES } = require("./src/validator");

// Database Query API
const db = require("./src/db");

// Logger for error reporting
const logger = require("./src/logger");

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that a session ID or string parameter is in safe format.
 * Prevents path traversal and injection attacks.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isSafeId(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > 256) return false;
  if (value.includes("..") || value.includes("/") || value.includes("\\")) return false;
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

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
  try {
    if (tenantId !== null && !isSafeId(tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getAllSessions(tenantId) || [];
  } catch (err) {
    logger.error({ err, tenantId }, "failed to get all sessions");
    return [];
  }
}

/**
 * Get a single session by ID.
 *
 * @param {string} sessionId
 * @param {string|null} tenantId — (optional) tenant to scope results
 * @returns {object|null}
 */
function getSession(sessionId, tenantId = null) {
  try {
    if (!sessionId || !isSafeId(sessionId)) {
      throw new Error("Invalid sessionId format");
    }
    if (tenantId !== null && !isSafeId(tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getSession(sessionId, tenantId);
  } catch (err) {
    logger.error({ err, sessionId, tenantId }, "failed to get session");
    return null;
  }
}

/**
 * Get total number of sessions.
 *
 * @param {string|null} tenantId — (optional) tenant to scope results
 * @returns {number}
 */
function getSessionCount(tenantId = null) {
  try {
    if (tenantId !== null && !isSafeId(tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getSessionCount(tenantId) || 0;
  } catch (err) {
    logger.error({ err, tenantId }, "failed to get session count");
    return 0;
  }
}

/**
 * Get all events for a session, with optional filtering.
 *
 * @param {string} sessionId
 * @param {{ type?: string, q?: string, tenantId?: string|null }} opts
 * @returns {object[]}
 */
function getSessionEvents(sessionId, opts = {}) {
  try {
    if (!sessionId || !isSafeId(sessionId)) {
      throw new Error("Invalid sessionId format");
    }
    if (opts.tenantId !== undefined && opts.tenantId !== null && !isSafeId(opts.tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getSessionEvents(sessionId, opts) || [];
  } catch (err) {
    logger.error({ err, sessionId, tenantId: opts.tenantId }, "failed to get session events");
    return [];
  }
}

/**
 * Get a session and all its descendants as a recursive tree.
 *
 * @param {string} sessionId
 * @param {string|null} tenantId
 * @returns {{ session: object, children: object[] } | null}
 */
function getSessionTree(sessionId, tenantId = null) {
  try {
    if (!sessionId || !isSafeId(sessionId)) {
      throw new Error("Invalid sessionId format");
    }
    if (tenantId !== null && !isSafeId(tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getSessionTree(sessionId, tenantId);
  } catch (err) {
    logger.error({ err, sessionId, tenantId }, "failed to get session tree");
    return null;
  }
}

/**
 * Get all sessions in a workflow (by trace_id) as a tree structure.
 *
 * @param {string} traceId
 * @param {string|null} tenantId
 * @returns {{ trace_id: string, session_count: number, tree: object[] } | null}
 */
function getWorkflow(traceId, tenantId = null) {
  try {
    if (!traceId || !isSafeId(traceId)) {
      throw new Error("Invalid traceId format");
    }
    if (tenantId !== null && !isSafeId(tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getWorkflow(traceId, tenantId);
  } catch (err) {
    logger.error({ err, traceId, tenantId }, "failed to get workflow");
    return null;
  }
}

/**
 * Get paginated list of sessions with cursor-based navigation.
 *
 * @param {string|null} tenantId
 * @param {{ limit?: number|string, cursor?: string }} opts
 * @returns {{ sessions: object[], next_cursor: string|null }}
 */
function getPaginatedSessions(tenantId = null, opts = {}) {
  try {
    if (tenantId !== null && !isSafeId(tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getPaginatedSessions(tenantId, opts) || { sessions: [], next_cursor: null };
  } catch (err) {
    logger.error({ err, tenantId }, "failed to get paginated sessions");
    return { sessions: [], next_cursor: null };
  }
}

/**
 * Get paginated list of events for a session with cursor-based navigation.
 *
 * @param {string} sessionId
 * @param {{ type?: string, q?: string, tenantId?: string|null, limit?: number|string, cursor?: string }} opts
 * @returns {{ events: object[], next_cursor: string|null }}
 */
function getPaginatedEvents(sessionId, opts = {}) {
  try {
    if (!sessionId || !isSafeId(sessionId)) {
      throw new Error("Invalid sessionId format");
    }
    if (opts.tenantId !== undefined && opts.tenantId !== null && !isSafeId(opts.tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getPaginatedEvents(sessionId, opts) || { events: [], next_cursor: null };
  } catch (err) {
    logger.error({ err, sessionId, tenantId: opts.tenantId }, "failed to get paginated events");
    return { events: [], next_cursor: null };
  }
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
  try {
    if (tenantId !== null && !isSafeId(tenantId)) {
      throw new Error("Invalid tenantId format");
    }
    return db.getMetrics(tenantId) || {};
  } catch (err) {
    logger.error({ err, tenantId }, "failed to get metrics");
    return {};
  }
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
  try {
    if (!keyHash || typeof keyHash !== "string") {
      throw new Error("Invalid keyHash");
    }
    return db.getApiKeyByHash(keyHash);
  } catch (err) {
    logger.error({ err }, "failed to get API key by hash");
    return null;
  }
}

/**
 * List all API keys (without sensitive data).
 *
 * @returns {object[]}
 */
function listApiKeys() {
  try {
    return db.listApiKeys() || [];
  } catch (err) {
    logger.error({ err }, "failed to list API keys");
    return [];
  }
}

// ============================================================================
// Exports
// ============================================================================

// Version (with fallback)
let version = "1.0.0";
try {
  version = require("./package.json").version;
} catch (_) {
  // Fallback if package.json cannot be read
  logger.warn("Unable to read version from package.json, using fallback");
}

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

  // Version (from package.json with fallback)
  version
};
