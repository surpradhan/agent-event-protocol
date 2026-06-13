"use strict";

/**
 * Migration 007 — webhook registrations (Phase 16-A, Webhooks & Alerts)
 *
 * Adds:
 *   webhooks — a per-tenant registry of outbound webhook endpoints. This is the
 *              registration half of PRD §Phase 16 "webhook registration: POST
 *              /webhooks with event filters and target URL". Delivery (16-B) and
 *              signing (16-C) build on this table.
 *
 * Design notes:
 *   • Tenant-scoped: every read/update/delete is filtered by tenant_id, so one
 *     tenant can never see or manage another tenant's webhooks.
 *   • `target_url` is validated by the SSRF guard (src/ssrf.js) BEFORE it is ever
 *     written — a loopback/private/link-local target is rejected at registration
 *     (and re-checked at delivery time, since DNS can rebind).
 *   • `event_types` stores the subscribed event-type filter as JSON text: the
 *     literal ["*"] for all events, or a subset of the 12 core event types. It is
 *     data only; it is never executed.
 *   • `enabled` is 0/1 (SQLite has no boolean). A disabled webhook is retained but
 *     receives no deliveries.
 *   • created_at / updated_at are ISO-8601 TEXT like every other timestamp column.
 *   • Indexed by (tenant_id, created_at DESC) for the list endpoint.
 *
 * PostgreSQL: mirrored in src/db/backends/postgres.js SCHEMA_DDL (Postgres does
 * not run these better-sqlite3 migration files).
 */

module.exports = {
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id           TEXT    NOT NULL PRIMARY KEY,
        tenant_id    TEXT    NOT NULL,
        target_url   TEXT    NOT NULL,
        event_types  TEXT    NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhooks_tenant
        ON webhooks (tenant_id, created_at DESC);
    `);
  },

  down(db) {
    db.exec(`DROP TABLE IF EXISTS webhooks;`);
  }
};
