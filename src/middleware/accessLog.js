"use strict";

/**
 * src/middleware/accessLog.js — API-key usage audit trail (Phase 14 PR-E)
 *
 * Records one row per *authenticated* HTTP request: which API key was used, the
 * method + path, the response status, and a timestamp. This is the "full API key
 * usage audit trail" of PRD §Phase 14.
 *
 * Opt-in
 * ------
 * Recording is gated on the ACCESS_LOG_ENABLED env var and is OFF by default, so
 * the default deployment pays no extra per-request DB write (important on the
 * ingest hot path). Compliance deployments set ACCESS_LOG_ENABLED=true. The env
 * is read per-request so it can be toggled without code changes (and so tests can
 * flip it around a running server).
 *
 * Safety
 * ------
 *   • The record is written on `res.on("finish")` (after the response is sent),
 *     fire-and-forget with errors swallowed — logging must never add latency to,
 *     or fail, the request it observes.
 *   • Only requests that resolved to an API key (`req.api_key_id`, set by the auth
 *     middleware) are logged. Admin-token requests (no api_key_id), keyless dev
 *     reads, and static/health hits are skipped.
 *   • `path` is `req.path` (the URL pathname) only — never the query string — so
 *     secrets passed as query params (e.g. /stream?token=…) are not persisted.
 */

const crypto = require("crypto");
const db = require("../db");
const logger = require("../logger");

/** True when ACCESS_LOG_ENABLED is a truthy value (1/true/yes/on, any case). */
function isAccessLogEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.ACCESS_LOG_ENABLED || "");
}

/**
 * Express middleware. Attaches a response-finish hook that appends an access-log
 * record for key-authenticated requests when logging is enabled.
 */
function accessLog(req, res, next) {
  if (!isAccessLogEnabled()) return next();

  res.on("finish", () => {
    const apiKeyId = req.api_key_id;
    if (!apiKeyId) return; // only log requests that resolved to an API key

    Promise.resolve(
      db.recordApiKeyAccess({
        id: `acl_${crypto.randomUUID().replace(/-/g, "")}`,
        apiKeyId,
        tenantId: req.tenant_id ?? null,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ts: new Date().toISOString()
      })
    ).catch((err) => logger.debug({ err }, "access-log: record failed"));
  });

  next();
}

module.exports = { accessLog, isAccessLogEnabled };
