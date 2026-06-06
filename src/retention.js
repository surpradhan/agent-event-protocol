"use strict";

/**
 * src/retention.js — data-retention / pruning logic (Phase 13 PR-D)
 *
 * Each project carries a `retention_days` policy (set from its tier at creation,
 * see src/tiers.js / migration 003).  This module turns that policy into action:
 * for every project with a *positive, finite* retention window, it deletes
 * events older than `now - retention_days` and reconciles the derived `sessions`
 * summary rows.
 *
 * Scope caveat (carried forward from PR-C quota metering)
 * ------------------------------------------------------
 * `events` rows carry `tenant_id`, not `project_id` (events predate projects).
 * Pruning is therefore scoped by the project's `tenant_id`, exactly like quota
 * metering.  This is exact when one project owns a tenant (the expected model);
 * if a tenant ever has multiple projects with *different* retention windows, the
 * shortest applicable window would over-prune the others' data.  Per-project
 * event tagging would remove this caveat — a candidate for a later PR.
 *
 * Safety
 * ------
 *   • A project with `retention_days` NULL, 0, or negative means "keep forever"
 *     and is never pruned (this covers the seeded `default` enterprise project).
 *   • `--dry-run` reports what *would* be deleted without touching any rows.
 *
 * This module is deliberately a plain library: `pruneAll()` does one pass and
 * returns.  There is no always-on scheduler — an operator (or a cron entry,
 * documented in PR-E) invokes `src/prune.js`, which calls into here.
 */

const db = require("./db");
const logger = require("./logger");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Return true if a project's retention policy means it should be pruned.
 * NULL / undefined / <= 0 all mean "keep forever".
 * @param {number|null|undefined} retentionDays
 * @returns {boolean}
 */
function isPrunable(retentionDays) {
  return typeof retentionDays === "number" && Number.isFinite(retentionDays) && retentionDays > 0;
}

/**
 * Compute the retention cutoff as an ISO-8601 string: events strictly older than
 * this are eligible for deletion.  Pure (no I/O) so it is unit-testable.
 *
 * @param {number} retentionDays  positive number of days to keep
 * @param {Date|number} [now]     reference "now" (defaults to Date.now())
 * @returns {string} ISO-8601 cutoff timestamp
 */
function computeCutoff(retentionDays, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  return new Date(nowMs - retentionDays * MS_PER_DAY).toISOString();
}

/**
 * Run one retention pass over every project.
 *
 * Requires the storage backend to be initialised (`await db.init()`).  For each
 * project with a positive retention window, prunes events for the project's
 * tenant older than its cutoff and reconciles session summaries.
 *
 * @param {{ now?: Date|number, dryRun?: boolean }} [opts]
 * @returns {Promise<{
 *   dryRun: boolean,
 *   projects_scanned: number,
 *   projects_pruned: number,
 *   events_deleted: number,
 *   sessions_deleted: number,
 *   details: Array<{
 *     project_id: string, tenant_id: string, retention_days: number,
 *     cutoff: string, events_deleted: number, sessions_deleted: number
 *   }>
 * }>}
 */
async function pruneAll({ now = Date.now(), dryRun = false } = {}) {
  const projects = await db.listProjects();

  const summary = {
    dryRun,
    projects_scanned: projects.length,
    projects_pruned: 0,
    events_deleted: 0,
    sessions_deleted: 0,
    details: []
  };

  for (const project of projects) {
    const retentionDays = project.retention_days;

    if (!isPrunable(retentionDays)) {
      // NULL / 0 / negative → keep forever; skip silently.
      continue;
    }

    const cutoff = computeCutoff(retentionDays, now);
    const tenantId = project.tenant_id;

    let events_deleted = 0;
    let sessions_deleted = 0;

    if (dryRun) {
      events_deleted = await db.countEventsBefore(tenantId, cutoff);
    } else {
      const res = await db.pruneEventsBefore(tenantId, cutoff);
      events_deleted = res.events_deleted;
      sessions_deleted = res.sessions_deleted;
    }

    summary.events_deleted += events_deleted;
    summary.sessions_deleted += sessions_deleted;
    if (events_deleted > 0) summary.projects_pruned += 1;

    summary.details.push({
      project_id: project.id,
      tenant_id: tenantId,
      retention_days: retentionDays,
      cutoff,
      events_deleted,
      sessions_deleted
    });

    logger.info(
      {
        project_id: project.id,
        tenant_id: tenantId,
        retention_days: retentionDays,
        cutoff,
        events_deleted,
        sessions_deleted,
        dry_run: dryRun
      },
      dryRun ? "retention: would prune events" : "retention: pruned events"
    );
  }

  return summary;
}

module.exports = { isPrunable, computeCutoff, pruneAll };
