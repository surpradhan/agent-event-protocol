"use strict";

/**
 * Migration 002 — Auth & Multi-Tenancy Schema
 *
 * Adds:
 *   api_keys   — API keys with tenant binding and permission scopes.
 *                The raw key is never stored; only a SHA-256 hash for lookup
 *                and a short prefix for display (e.g. aep_3f9a…).
 *
 *   tenant_id columns on events and sessions — all rows created before this
 *                migration are assigned to the 'default' tenant so that
 *                existing data remains reachable via a key scoped to that
 *                tenant.
 *
 * Design notes:
 *   • api_keys.key_hash is the SHA-256 hex digest of the raw bearer token.
 *     Lookup is O(1) via the UNIQUE index.
 *   • api_keys.scopes is a JSON array: ["read"], ["write"], or ["read","write"].
 *   • api_keys.hmac_secret is the plaintext shared secret used for HMAC-SHA256
 *     signature verification on ingest. NULL means "no signing required for
 *     this key". Plaintext is acceptable here because the DB is server-local;
 *     swap to an encrypted column or external secrets manager for production.
 *   • tenant_id DEFAULT 'default' backfills all pre-migration rows.
 *   • Composite indexes support the access patterns added in Phase 4:
 *       (tenant_id, session_id) for tenant-scoped event queries
 *       (tenant_id, updated_at) for tenant-scoped session listing
 */

module.exports = {
  up(db) {
    db.exec(`
      -- ------------------------------------------------------------------ --
      -- api_keys                                                             --
      -- ------------------------------------------------------------------ --
      CREATE TABLE IF NOT EXISTS api_keys (
        id          TEXT    NOT NULL PRIMARY KEY,   -- UUID
        key_hash    TEXT    NOT NULL UNIQUE,        -- SHA-256(raw_key) hex
        key_prefix  TEXT    NOT NULL,               -- first 12 chars for display
        tenant_id   TEXT    NOT NULL,
        label       TEXT    NOT NULL DEFAULT '',
        scopes      TEXT    NOT NULL DEFAULT '["read","write"]',
        hmac_secret TEXT,                           -- NULL = signing not required
        created_at  TEXT    NOT NULL,
        revoked_at  TEXT                            -- NULL = active
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
        ON api_keys (tenant_id);

      -- ------------------------------------------------------------------ --
      -- Extend events with tenant_id                                         --
      -- ------------------------------------------------------------------ --
      -- SQLite ALTER TABLE only supports ADD COLUMN; backfill via DEFAULT.
      -- All existing events are assigned to the 'default' tenant.
      ALTER TABLE events   ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

      CREATE INDEX IF NOT EXISTS idx_events_tenant_id
        ON events (tenant_id);

      -- Composite: fast path for GET /sessions/:id/events filtered by tenant
      CREATE INDEX IF NOT EXISTS idx_events_tenant_session
        ON events (tenant_id, session_id);

      CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id
        ON sessions (tenant_id);

      -- Composite: fast path for GET /sessions filtered by tenant
      CREATE INDEX IF NOT EXISTS idx_sessions_tenant_updated
        ON sessions (tenant_id, updated_at DESC);
    `);
  },

  down(db) {
    // SQLite cannot drop columns; recreating tables is the only safe path.
    // Provided for documentation and future tooling; not wired into runner.
    db.exec(`
      DROP TABLE IF EXISTS api_keys;
      -- Restoring events/sessions without tenant_id requires table recreation
      -- and data migration — omitted here; handle manually if needed.
    `);
  }
};
