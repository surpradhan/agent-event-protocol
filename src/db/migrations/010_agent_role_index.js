"use strict";

/**
 * Migration 010 — composite index on (session_id, agent_role)
 *
 * The server-side ?role= filter added in #144 uses getSessionEvents (export
 * path) which builds dynamic SQL over session_id + agent_role. Without this
 * index SQLite does a full session scan and post-filters by agent_role, which
 * is a performance concern for large sessions.
 *
 * PostgreSQL: mirrored in src/db/backends/postgres.js SCHEMA_DDL.
 * Postgres does not run these better-sqlite3 migration files.
 */

module.exports = {
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session_role ON events (session_id, agent_role);
    `);
  },

  down(db) {
    db.exec(`DROP INDEX IF EXISTS idx_events_session_role;`);
  }
};
