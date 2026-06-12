"use strict";

/**
 * Migration 005 — Data-residency region label (Phase 14 PR-G)
 *
 * Adds `projects.region` — the data-residency region a project declares its
 * events should reside in (EU / US / APAC / global). Nullable; NULL means
 * "unspecified" (no residency requirement), so existing projects are unchanged.
 *
 * This is a declaration + mismatch-detection control, NOT storage routing — see
 * src/regions.js. The deployment's actual storage region is the
 * `DATA_RESIDENCY_REGION` env var.
 *
 * PostgreSQL: mirrored in src/db/backends/postgres.js SCHEMA_DDL (column added to
 * the projects CREATE for fresh DBs, plus an idempotent ALTER for existing ones).
 */

module.exports = {
  up(db) {
    db.exec(`ALTER TABLE projects ADD COLUMN region TEXT;`);
  },

  down(db) {
    // SQLite < 3.35 cannot drop a column; recreate without it if ever needed.
    // Left as documentation — the runner does not invoke down().
    db.exec(`/* down: projects.region drop not implemented (SQLite limitation) */`);
  }
};
