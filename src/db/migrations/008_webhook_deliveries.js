"use strict";

/**
 * Migration 008 — webhook delivery attempts (Phase 16-B, Webhooks & Alerts)
 *
 * Adds:
 *   webhook_deliveries — one row per (event → webhook) delivery, recording the
 *                        outcome of the bounded-retry delivery attempt. This is
 *                        the audit trail behind PRD §Phase 16 "event delivery:
 *                        POST matching events to the webhook URL with retries".
 *
 * Design notes:
 *   • Tenant-scoped: every read is filtered by tenant_id (mirrors webhooks).
 *   • `status` is pending | success | failed. A row is inserted `pending` the
 *     moment a matching event is dispatched, then updated to its terminal state
 *     once the (bounded, exponential-backoff) retry loop finishes.
 *   • `attempts` counts how many HTTP attempts were made; `last_status_code` is
 *     the final HTTP status (NULL on a network error / SSRF rejection / timeout),
 *     and `last_error` is a short diagnostic string (NULL on success).
 *   • No FK to webhooks/events: a delivery record is an immutable historical fact
 *     that must survive the webhook being deleted (mirrors the access-log table).
 *   • Indexed by (webhook_id, created_at DESC) for the per-webhook deliveries
 *     endpoint (16-D) and (tenant_id, created_at DESC) for tenant-scoped reads.
 *   • created_at / updated_at are ISO-8601 TEXT like every other timestamp column.
 *
 * PostgreSQL: mirrored in src/db/backends/postgres.js SCHEMA_DDL (Postgres does
 * not run these better-sqlite3 migration files).
 */

module.exports = {
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id               TEXT    NOT NULL PRIMARY KEY,
        webhook_id       TEXT    NOT NULL,
        tenant_id        TEXT    NOT NULL,
        event_id         TEXT    NOT NULL,
        event_type       TEXT    NOT NULL,
        status           TEXT    NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_status_code INTEGER,
        last_error       TEXT,
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
        ON webhook_deliveries (webhook_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant
        ON webhook_deliveries (tenant_id, created_at DESC);
    `);
  },

  down(db) {
    db.exec(`DROP TABLE IF EXISTS webhook_deliveries;`);
  }
};
