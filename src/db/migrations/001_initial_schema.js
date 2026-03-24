"use strict";

/**
 * Migration 001 — Initial Schema
 *
 * Creates:
 *   events          — all AEP envelope fields + raw_payload JSON column
 *   sessions        — session metadata (derived/maintained on insert)
 *   server_metrics  — persisted counters that cannot be re-derived from events
 *                     (received, rejected, duplicates)
 *   schema_migrations — created by the runner before this runs; listed here
 *                       as documentation only
 *
 * Design notes:
 *   • events.id is the PRIMARY KEY — SQLite enforces uniqueness automatically.
 *     INSERT OR IGNORE gives us atomic duplicate detection without a prior SELECT.
 *   • raw_payload stores the complete event JSON so the server can reconstruct
 *     the full envelope without mapping every optional column back.
 *   • sessions is maintained by an upsert on every accepted event; this avoids
 *     expensive GROUP BY aggregations at query time.
 *   • All timestamp columns are TEXT (ISO-8601).  SQLite's lexicographic ordering
 *     on ISO-8601 strings is correct, so ORDER BY time works as expected.
 *   • Indexes are chosen to support the API's access patterns:
 *       - GET /sessions/:id/events  → idx_events_session_id
 *       - GET /sessions (sort)      → idx_sessions_updated_at
 *       - type filter               → idx_events_session_type
 *       - trace-level queries (future phase) → idx_events_trace_id
 *
 * PostgreSQL migration path:
 *   • Replace TEXT PRIMARY KEY with UUID PRIMARY KEY DEFAULT gen_random_uuid()
 *     (events.id is already a UUID string so the data shape doesn't change).
 *   • Replace TEXT timestamps with TIMESTAMPTZ.
 *   • Replace raw_payload TEXT with JSONB for server-side JSON operators.
 *   • The INSERT OR IGNORE pattern becomes INSERT … ON CONFLICT (id) DO NOTHING.
 *   • sessions upsert becomes INSERT … ON CONFLICT (session_id) DO UPDATE SET …
 *     (already written in standard SQL below; works on both engines).
 */

module.exports = {
  up(db) {
    db.exec(`
      -- ------------------------------------------------------------------ --
      -- events                                                               --
      -- ------------------------------------------------------------------ --
      CREATE TABLE IF NOT EXISTS events (
        -- identity / dedup key
        id               TEXT    NOT NULL PRIMARY KEY,

        -- core envelope fields (indexed columns for filtering/sorting)
        specversion      TEXT    NOT NULL DEFAULT '0.2.0',
        time             TEXT    NOT NULL,
        source           TEXT    NOT NULL,
        type             TEXT    NOT NULL,
        session_id       TEXT    NOT NULL,
        trace_id         TEXT    NOT NULL,

        -- optional envelope fields stored as dedicated columns
        parent_session_id  TEXT,
        agent_role         TEXT,
        subject            TEXT,
        causation_id       TEXT,
        idempotency_key    TEXT,

        -- full event JSON — single source of truth for reconstruction
        raw_payload      TEXT    NOT NULL,

        -- server-side metadata
        ingested_at      TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_id
        ON events (session_id);

      -- composite index: satisfies GET /sessions/:id/events?type= without
      -- a post-filter scan
      CREATE INDEX IF NOT EXISTS idx_events_session_type
        ON events (session_id, type);

      CREATE INDEX IF NOT EXISTS idx_events_time
        ON events (time);

      CREATE INDEX IF NOT EXISTS idx_events_trace_id
        ON events (trace_id);

      -- ------------------------------------------------------------------ --
      -- sessions                                                             --
      -- ------------------------------------------------------------------ --
      CREATE TABLE IF NOT EXISTS sessions (
        session_id         TEXT    NOT NULL PRIMARY KEY,
        trace_id           TEXT    NOT NULL,
        source             TEXT    NOT NULL,

        -- retained for Phase 3 (session tree API)
        parent_session_id  TEXT,
        agent_role         TEXT,

        event_count        INTEGER NOT NULL DEFAULT 0,
        started_at         TEXT    NOT NULL,
        updated_at         TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
        ON sessions (updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_sessions_trace_id
        ON sessions (trace_id);

      -- ------------------------------------------------------------------ --
      -- server_metrics                                                       --
      -- ------------------------------------------------------------------ --
      -- Stores counters that can NOT be re-derived from the events table:
      --   received  = total POST /events attempts (includes rejected + dupes)
      --   rejected  = events that failed schema validation
      --   duplicates = events with a known id (not re-stored)
      --
      -- accepted and byType are always computed from the events table so they
      -- stay consistent even after any manual DB surgery.
      CREATE TABLE IF NOT EXISTS server_metrics (
        key    TEXT    NOT NULL PRIMARY KEY,
        value  INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO server_metrics (key, value) VALUES
        ('received',   0),
        ('rejected',   0),
        ('duplicates', 0);
    `);
  },

  // down() is provided for completeness; not wired into the runner yet but
  // useful for future tooling / test teardown.
  down(db) {
    db.exec(`
      DROP TABLE IF EXISTS server_metrics;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS events;
    `);
  }
};
