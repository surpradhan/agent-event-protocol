"use strict";

/**
 * src/logger.js — Structured JSON logger (pino)
 *
 * Environment variables
 * ---------------------
 * LOG_LEVEL   — pino level string (trace|debug|info|warn|error|fatal). Default: "info"
 * LOG_PRETTY  — set to "true" to enable human-readable output (dev only;
 *               requires pino-pretty to be installed separately).
 *
 * Usage
 * -----
 *   const logger = require("./logger");
 *   logger.info({ session_id, trace_id }, "event ingested");
 *   logger.error({ err }, "database write failed");
 *
 * Child loggers with fixed context
 * ---------------------------------
 *   const reqLog = logger.child({ trace_id, session_id });
 *   reqLog.info("processing event");
 */

const pino = require("pino");

const level = process.env.LOG_LEVEL || "info";

// When LOG_PRETTY=true, attempt to use pino-pretty for human-readable output.
// pino-pretty must be installed separately: npm install pino-pretty
// If it is not installed, we fall back to plain JSON gracefully rather than
// crashing at startup — the try/catch must wrap the pino() call itself because
// that is where the transport worker is resolved.
let logger;
try {
  const opts = {
    level,
    base: { service: "aep-ingest" }
  };
  if (process.env.LOG_PRETTY === "true") {
    opts.transport = { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } };
  }
  logger = pino(opts);
} catch (_) {
  // pino-pretty unavailable — fall back to plain JSON logger
  logger = pino({ level, base: { service: "aep-ingest" } });
}

module.exports = logger;
