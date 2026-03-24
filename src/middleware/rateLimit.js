"use strict";

/**
 * src/middleware/rateLimit.js — Per-API-key fixed-window rate limiter
 *
 * Limits the number of requests a single API key can make to the ingest
 * endpoint within a fixed 60-second window.  The window resets at a fixed
 * point in time (not relative to each request), which is simpler and cheaper
 * than a sliding/rolling window while providing equivalent protection.
 *
 * Environment variables
 * ---------------------
 * RATE_LIMIT_RPM  — max requests per key per minute (default: 300)
 *                   Set to 0 to disable rate limiting entirely.
 *
 * Headers returned on every response
 * ------------------------------------
 * X-RateLimit-Limit      — configured RPM ceiling
 * X-RateLimit-Remaining  — requests left in the current window
 * X-RateLimit-Reset      — Unix timestamp (seconds) when the window resets
 *
 * Usage
 * -----
 *   const { ingestRateLimit } = require("./middleware/rateLimit");
 *   app.post("/events", requireApiKey("write"), ingestRateLimit, handler);
 *
 * Note: this middleware must be placed AFTER requireApiKey so that
 * req.api_key_id is already populated.
 */

const WINDOW_MS = 60_000; // 1 minute
const MAX_RPM   = parseInt(process.env.RATE_LIMIT_RPM ?? "300", 10);

// Map: api_key_id → { count: number, resetAt: number (ms timestamp) }
const windows = new Map();

// Periodically sweep expired windows to avoid unbounded memory growth.
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of windows) {
    if (now >= entry.resetAt) windows.delete(id);
  }
}, 5 * 60_000);

// Don't prevent the process from exiting cleanly.
sweepInterval.unref();

/**
 * Rate-limit middleware for the ingest endpoint.
 * Requires req.api_key_id to be set by prior auth middleware.
 */
function ingestRateLimit(req, res, next) {
  // If rate limiting is disabled via config, skip immediately.
  if (!MAX_RPM || MAX_RPM <= 0) return next();

  // If there's no authenticated key (shouldn't happen after requireApiKey),
  // skip — auth middleware will handle the rejection.
  const keyId = req.api_key_id;
  if (!keyId) return next();

  const now = Date.now();
  let entry = windows.get(keyId);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    windows.set(keyId, entry);
  }

  entry.count++;

  const remaining = Math.max(0, MAX_RPM - entry.count);
  const resetSec  = Math.ceil(entry.resetAt / 1000);

  res.setHeader("X-RateLimit-Limit",     MAX_RPM);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset",     resetSec);

  if (entry.count > MAX_RPM) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).json({
      error:      "Rate limit exceeded",
      limit:      MAX_RPM,
      retryAfter
    });
  }

  next();
}

module.exports = { ingestRateLimit };
