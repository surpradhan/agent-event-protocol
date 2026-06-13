"use strict";

/**
 * Migration 009 — per-webhook signing secret (Phase 16-C, Webhooks & Alerts)
 *
 * Adds:
 *   webhooks.signing_secret — a per-webhook HMAC secret used to sign the outbound
 *                             delivery payload (the `X-AEP-Signature` header), so
 *                             a receiver can verify the delivery is genuinely from
 *                             AEP and untampered. Delivers PRD §Phase 16 "signing:
 *                             webhook payloads are HMAC-signed for verification".
 *
 * Design notes:
 *   • The secret MUST be recoverable by the server (it computes the HMAC on every
 *     delivery), so — unlike API keys, which are stored hashed because the server
 *     only ever verifies them — it is stored as-is. It is returned to the caller
 *     exactly ONCE, in the POST /webhooks 201 response, and is NEVER included in
 *     any subsequent GET/list response (formatWebhookRow does not select it; the
 *     delivery engine reads it via a dedicated getWebhookSigningSecret method).
 *   • Nullable: webhooks created before this migration have no secret and are
 *     delivered UNSIGNED (no X-AEP-Signature header) — backward compatible.
 *
 * PostgreSQL: mirrored in src/db/backends/postgres.js SCHEMA_DDL (an idempotent
 * ALTER … ADD COLUMN IF NOT EXISTS for existing DBs + the column on the fresh
 * CREATE). Postgres does not run these better-sqlite3 migration files.
 */

module.exports = {
  up(db) {
    // SQLite: ADD COLUMN is safe + fast (no table rewrite). Existing rows get NULL.
    db.exec(`ALTER TABLE webhooks ADD COLUMN signing_secret TEXT;`);
  },

  down(db) {
    // SQLite (older) cannot DROP COLUMN; recreate the table without the column.
    db.exec(`
      CREATE TABLE webhooks_no_secret (
        id           TEXT    NOT NULL PRIMARY KEY,
        tenant_id    TEXT    NOT NULL,
        target_url   TEXT    NOT NULL,
        event_types  TEXT    NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );
      INSERT INTO webhooks_no_secret (id, tenant_id, target_url, event_types, enabled, created_at, updated_at)
        SELECT id, tenant_id, target_url, event_types, enabled, created_at, updated_at FROM webhooks;
      DROP TABLE webhooks;
      ALTER TABLE webhooks_no_secret RENAME TO webhooks;
      CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON webhooks (tenant_id, created_at DESC);
    `);
  }
};
