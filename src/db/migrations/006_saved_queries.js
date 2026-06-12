"use strict";

/**
 * Migration 006 — saved custom-analytics queries (Phase 15-B, Advanced Dashboard)
 *
 * Adds:
 *   saved_queries — a per-tenant library of named, reusable custom-analytics query
 *                   specs (the structured JSON model from src/customQuery.js). This
 *                   is the persistence half of PRD §Phase 15 "user-defined queries
 *                   over event streams".
 *
 * Design notes:
 *   • `spec` stores the query spec as JSON text (validated by validateQuerySpec
 *     before it is ever written — see the POST /analytics/saved-queries route).
 *     It is data only; it is never executed as SQL.
 *   • Tenant-scoped: every read/delete is filtered by tenant_id, so one tenant can
 *     never see or run another tenant's saved queries.
 *   • (tenant_id, name) is UNIQUE so a name is a stable handle within a tenant;
 *     created_at / updated_at are ISO-8601 TEXT like every other timestamp column.
 *   • Indexed by tenant_id for the list endpoint.
 *
 * PostgreSQL: mirrored in src/db/backends/postgres.js SCHEMA_DDL (Postgres does not
 * run these better-sqlite3 migration files).
 */

module.exports = {
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_queries (
        id          TEXT NOT NULL PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        name        TEXT NOT NULL,
        spec        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE (tenant_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_saved_queries_tenant
        ON saved_queries (tenant_id, created_at DESC);
    `);
  },

  down(db) {
    db.exec(`DROP TABLE IF EXISTS saved_queries;`);
  }
};
