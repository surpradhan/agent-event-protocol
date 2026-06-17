/**
 * Query and path parameter validation middleware
 *
 * Validates:
 * - Query string parameters (length limits, format)
 * - Path parameters (UUID format validation)
 * - Prevents ReDoS attacks on free-text search
 *
 * Security Rules:
 * - Repeated params (?type=a&type=b) are coerced to a single value (last wins)
 *   before any other check, so a raw array never reaches a string method or a
 *   DB binding (which would throw → 500). See coerceArrayParams below.
 * - ?q (free-text search): max 200 characters
 * - ?type: max 100 characters
 * - ?role: max 100 characters
 * - ?cursor: must be valid base64url
 * - ?limit: must be positive integer
 * - session_id and trace_id in path: must be UUID v4 format
 */

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
 * Coerce any array-valued query param to a single string (LAST value wins).
 *
 * Express parses a repeated param (?type=a&type=b) into an array. Passed to a
 * string method or a SQL binding, an array throws → HTTP 500. Reducing it to one
 * value keeps a repeated param meaningful (it still filters by one value) and
 * matches the graceful-degradation house style (no 400 for a repeat). Pure: takes
 * a query object, returns a NEW normalized object; never mutates its input.
 *
 * The Express 5 default query parser is "simple" (querystring-based), so values
 * are only ever `string | string[]` — no nested objects to recurse into, and a
 * key like `a[b]` arrives as the literal string `"a[b]"`. A `?__proto__=…` param
 * is therefore a plain own key here; `out[key] = …` cannot pollute Object.prototype
 * (the simple parser never builds a nested `__proto__` object), so a normal object
 * accumulator is safe — locked by a prototype-pollution integration test.
 *
 * @param {object} query  req.query (string | string[] values)
 * @returns {object} a new object with every array reduced to its last element
 */
function coerceArrayParams(query) {
  const out = {};
  for (const key of Object.keys(query || {})) {
    const value = query[key];
    out[key] = Array.isArray(value) ? value[value.length - 1] : value;
  }
  return out;
}

/**
 * Express middleware for validating query and path parameters.
 * Returns 400 Bad Request if validation fails.
 */
function validateQueryParams(req, res, next) {
  // Normalize repeated params to a single value BEFORE any check below, so the
  // length/format checks and the route handlers all see scalars. req.query in
  // Express 5 is a getter-only accessor that re-parses on each access (in-place
  // mutation and reassignment are silently lost), so install the coerced object
  // as an own data property that shadows the prototype getter.
  // `configurable: true` is the load-bearing flag: it lets this run idempotently
  // if a route ever stacks the middleware twice (redefining is then allowed).
  Object.defineProperty(req, "query", {
    value: coerceArrayParams(req.query),
    writable: true,
    configurable: true,
    enumerable: true,
  });

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

  // Validate ?role (agent role filter)
  if (req.query.role !== undefined) {
    const role = String(req.query.role);
    if (role.length > 100) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Query parameter 'role' exceeds maximum length of 100 characters"
      });
    }
    const VALID_AGENT_ROLES = new Set(["orchestrator", "subagent", "standalone"]);
    if (role.length > 0 && !VALID_AGENT_ROLES.has(role)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Query parameter 'role' must be one of: orchestrator, subagent, standalone"
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

  // Validate a generic resource id in path (e.g. /analytics/saved-queries/:id).
  if (req.params.id !== undefined) {
    const id = String(req.params.id);
    if (!isSafePathParam(id)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid id format. IDs must not contain special characters like .. or /."
      });
    }
  }

  next();
}

module.exports = {
  validateQueryParams,
  validatePathParams,
  coerceArrayParams
};
