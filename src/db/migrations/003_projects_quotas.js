"use strict";

/**
 * Migration 003 — Projects, Tiers & Quotas (Phase 13 PR-C, Hosted SaaS)
 *
 * Adds:
 *   projects   — the unit that owns ingested data and carries a subscription
 *                tier.  Each project has an event_quota (NULL = unlimited) and
 *                a retention_days policy (NULL = unlimited).  Quota is enforced
 *                on ingest; retention is read by the PR-D pruning job.
 *
 *   api_keys.project_id — additive column binding each key to a project.  Existing
 *                keys (created before this migration) are backfilled to the
 *                seeded 'default' project so all prior data and keys keep working.
 *
 * Design notes:
 *   • A seed 'default' project (id = 'default') is created so the pre-existing
 *     single-tenant deployment behaves exactly as before: every legacy key maps
 *     to it, and its tier is 'enterprise' (unlimited quota) so no existing
 *     deployment suddenly starts rejecting events after upgrading.
 *   • tier is stored as TEXT ('free' | 'team' | 'enterprise').  The quota and
 *     retention values are *materialised* onto the project row at creation time
 *     (copied from the tier defaults in src/tiers.js) rather than looked up by
 *     tier name on every read — this keeps a project's limits stable even if the
 *     tier defaults are later retuned, and lets an operator override a single
 *     project without inventing a new tier.
 *   • event_quota / retention_days are nullable INTEGERs; NULL = unlimited.
 *   • idx_api_keys_project supports "list keys for a project" and the per-project
 *     usage accounting on the ingest hot path.
 *
 * PostgreSQL parity: mirrored in src/db/backends/postgres.js SCHEMA_DDL.
 */

module.exports = {
  up(db) {
    db.exec(`
      -- ------------------------------------------------------------------ --
      -- projects                                                             --
      -- ------------------------------------------------------------------ --
      CREATE TABLE IF NOT EXISTS projects (
        id             TEXT    NOT NULL PRIMARY KEY,   -- UUID (or 'default')
        name           TEXT    NOT NULL DEFAULT '',
        tenant_id      TEXT    NOT NULL,
        tier           TEXT    NOT NULL DEFAULT 'free',
        event_quota    INTEGER,                        -- NULL = unlimited
        retention_days INTEGER,                        -- NULL = unlimited
        created_at     TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projects_tenant
        ON projects (tenant_id);

      -- Seed the 'default' project so legacy keys/data keep working unchanged.
      -- Enterprise tier => unlimited quota + retention (no behaviour change).
      INSERT OR IGNORE INTO projects
        (id, name, tenant_id, tier, event_quota, retention_days, created_at)
      VALUES
        ('default', 'Default Project', 'default', 'enterprise', NULL, NULL,
         '1970-01-01T00:00:00.000Z');

      -- ------------------------------------------------------------------ --
      -- Bind API keys to a project                                           --
      -- ------------------------------------------------------------------ --
      -- SQLite ALTER TABLE only supports ADD COLUMN; backfill via DEFAULT so all
      -- pre-migration keys map to the seeded 'default' project.
      ALTER TABLE api_keys
        ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';

      CREATE INDEX IF NOT EXISTS idx_api_keys_project
        ON api_keys (project_id);

      -- Per-project event accounting reads events grouped by project. events
      -- rows do not carry project_id (events predate projects and are keyed by
      -- tenant); usage is computed by joining api_keys → tenant, see backend.
    `);
  },

  down(db) {
    // SQLite cannot drop columns; recreating api_keys is the only safe path.
    // Provided for documentation/tooling; not wired into the runner.
    db.exec(`
      DROP TABLE IF EXISTS projects;
      -- Removing api_keys.project_id requires table recreation — omitted here.
    `);
  }
};
