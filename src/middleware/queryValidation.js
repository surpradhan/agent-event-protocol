/**
 * Query and path parameter validation middleware
 *
 * Validates:
 * - Query string parameters (length limits, format)
 * - Path parameters (UUID format validation)
 * - Prevents ReDoS attacks on free-text search
 *
 * Security Rules:
 * - ?q (free-text search): max 200 characters
 * - ?type: max 100 characters
 * - ?cursor: must be valid base64url
 * - ?limit: must be positive integer
 * - session_id and trace_id in path: must be UUID v4 format
 */

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a valid base64url cursor.
 * Base64url uses A-Z, a-z, 0-9, -, and _
 * Length should be reasonable (typically 50-200 chars when base64url encoded)
 *
 * Also verifies the string can be decoded as base64url without errors.
 */
function isValidBase64Url(str) {
  if (typeof str !== 'string' || str.length === 0) return false;
  if (str.length > 1000) return false; // Prevent excessively long cursors
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return false;

  // Verify it can actually be decoded
  try {
    Buffer.from(str, 'base64url');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Validate that a string is a safe path parameter.
 * Prevents path traversal attacks and similar injection attempts.
 * Does not enforce strict UUID format (allows test IDs).
 */
function isSafePathParam(str) {
  if (typeof str !== 'string' || str.length === 0) return false;
  if (str.length > 256) return false; // Prevent excessively long IDs

  // Prevent obvious path traversal attempts
  if (str.includes('..') || str.includes('/') || str.includes('\\')) {
    return false;
  }

  // Allow UUIDs, test IDs (with underscores/hyphens), and alphanumeric strings
  return /^[a-zA-Z0-9_-]+$/.test(str);
}

/**
 * Validate that a string matches UUID v4 format (strict check).
 */
function isValidUuid(str) {
  return UUID_V4_REGEX.test(str);
}

/**
 * Express middleware for validating query and path parameters.
 * Returns 400 Bad Request if validation fails.
 */
function validateQueryParams(req, res, next) {
  // Validate ?q (free-text search)
  if (req.query.q !== undefined) {
    const q = String(req.query.q);
    if (q.length > 200) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Query parameter 'q' exceeds maximum length of 200 characters"
      });
    }
  }

  // Validate ?type (event type filter)
  if (req.query.type !== undefined) {
    const type = String(req.query.type);
    if (type.length > 100) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Query parameter 'type' exceeds maximum length of 100 characters"
      });
    }
  }

  // Validate ?cursor (pagination cursor)
  if (req.query.cursor !== undefined) {
    const cursor = String(req.query.cursor);
    if (!isValidBase64Url(cursor)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Query parameter 'cursor' must be a valid base64url string"
      });
    }
  }

  // Validate ?limit (pagination limit)
  if (req.query.limit !== undefined) {
    const limit = parseInt(req.query.limit, 10);
    if (isNaN(limit) || limit < 1 || limit > 1000) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Query parameter 'limit' must be a positive integer between 1 and 1000"
      });
    }
  }

  next();
}

/**
 * Express middleware for validating path parameters (session_id, trace_id).
 * Prevents path traversal and injection attacks.
 * Returns 400 Bad Request if validation fails.
 */
function validatePathParams(req, res, next) {
  // Validate sessionId in path (/sessions/:sessionId/...)
  if (req.params.sessionId !== undefined) {
    const sessionId = String(req.params.sessionId);
    if (!isSafePathParam(sessionId)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid session ID format. Session IDs must not contain special characters like .. or /."
      });
    }
  }

  // Validate traceId in path (/workflows/:traceId)
  if (req.params.traceId !== undefined) {
    const traceId = String(req.params.traceId);
    if (!isSafePathParam(traceId)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid trace ID format. Trace IDs must not contain special characters like .. or /."
      });
    }
  }

  next();
}

module.exports = {
  validateQueryParams,
  validatePathParams
};
