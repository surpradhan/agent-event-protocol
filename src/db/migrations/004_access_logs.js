"use strict";

/**
 * Migration 004 — API-key access logs (Phase 14 PR-E, Compliance & Audit Suite)
 *
 * Adds:
 *   api_key_access_log — one row per authenticated HTTP request, recording WHICH
 *                        API key was used, for WHAT (method + path), WHEN, and the
 *                        response status.  This is the "full API key usage audit
 *                        trail" of PRD §Phase 14.
 *
 * Design notes:
 *   • Recording is **opt-in** via the ACCESS_LOG_ENABLED env var (see
 *     src/middleware/accessLog.js).  The table is always created so the admin
 *     read endpoint and the Postgres parity suite have a stable schema; it simply
 *     stays empty until logging is enabled.  This keeps the ingest hot path free
 *     of an extra write per request in the default configuration.
 *   • `path` stores req.path (the URL pathname only) — never the query string —
 *     so secrets passed as query params (e.g. /stream?token=…) are not persisted.
 *   • `api_key_id` is the key's UUID (api_keys.id).  We do NOT add a FK constraint:
 *     an access record is an immutable historical fact that must survive the key
 *     being deleted/rotated, and the log is queried by key id directly.
 *   • Indexed by (api_key_id, ts DESC) for the per-key read endpoint, and by ts
 *     for time-window queries / future retention pruning.
 *   • ts is TEXT (ISO-8601) — consistent with every other timestamp column;
 *     lexicographic ordering on ISO-8601 is chronological.
 *
 * PostgreSQL: mirrored in src/db/backends/postgres.js SCHEMA_DDL (Postgres does
 * not run these better-sqlite3 migration files).
 */

module.exports = {
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_key_access_log (
        id          TEXT    NOT NULL PRIMARY KEY,
        api_key_id  TEXT    NOT NULL,
        tenant_id   TEXT,
        method      TEXT    NOT NULL,
        path        TEXT    NOT NULL,
        status      INTEGER NOT NULL,
        ts          TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_access_log_key_ts
        ON api_key_access_log (api_key_id, ts DESC);

      CREATE INDEX IF NOT EXISTS idx_access_log_ts
        ON api_key_access_log (ts);
    `);
  },

  down(db) {
    db.exec(`DROP TABLE IF EXISTS api_key_access_log;`);
  }
};
