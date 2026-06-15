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
 * Orphan tenants (issue #122): a key's tenant can differ from its bound
 * project's tenant, so a tenant may have events but no project row at all. With
 * no project there is no retention policy, so such a tenant is never pruned —
 * `pruneAll` reports them in `orphan_tenants` and logs a warning so the silent
 * skip is visible. The fix is operational: create a project for that tenant.
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
 * Export-before-prune (cold storage)
 * ----------------------------------
 * When `exportBeforePrune` is set, the soon-to-be-deleted events (those with
 * `time < cutoff`) are exported to cold storage *first*, via the injected
 * `exportTenant(tenantId, cutoff)` function (wired to the export module by
 * src/prune.js).  This is a **safety gate**: if the export rejects, that
 * project's events are NOT deleted — the failure is recorded and the pass moves
 * on, so a cold-storage outage can never cause unbacked data loss.  `--dry-run`
 * never exports and never deletes.
 *
 * `exportTenant` should export exactly the prune predicate (events `time <
 * cutoff`) — i.e. with `until = cutoff` — so the archived object matches what is
 * deleted.  (A backdated event landing between export and delete is the only
 * gap; events normally carry `time` near now, well after a past cutoff.)
 *
 * @param {{ now?: Date|number, dryRun?: boolean, exportBeforePrune?: boolean,
 *           exportTenant?: (tenantId: string, cutoff: string) => Promise<object>,
 *           db?: object }} [opts]  `db` is injectable for testing (defaults to the real backend)
 * @returns {Promise<{
 *   dryRun: boolean,
 *   exportBeforePrune: boolean,
 *   projects_scanned: number,
 *   projects_pruned: number,
 *   events_deleted: number,
 *   sessions_deleted: number,
 *   export_failures: number,
 *   orphan_tenants: string[],
 *   details: Array<{
 *     project_id: string, tenant_id: string, retention_days: number,
 *     cutoff: string, events_deleted: number, sessions_deleted: number,
 *     exported?: boolean, objects_written?: number, events_exported?: number,
 *     export_error?: string
 *   }>
 * }>}
 */
async function pruneAll({
  now = Date.now(),
  dryRun = false,
  exportBeforePrune = false,
  exportTenant = null,
  db: database = db
} = {}) {
  if (exportBeforePrune && !dryRun && typeof exportTenant !== "function") {
    throw new Error("pruneAll: exportBeforePrune requires an exportTenant(tenantId, cutoff) function");
  }

  const projects = await database.listProjects();

  // Orphan tenants (issue #122): a key's tenant can differ from its bound
  // project's tenant, so a tenant may have events but no project row — and with
  // no project there is no retention_days policy to apply, so such a tenant can
  // never be pruned. We cannot act on it here (no policy), but we surface it so
  // the silent skip (data that quietly accumulates forever) is visible.
  const projectTenants = new Set();
  for (const p of projects) {
    if (p.tenant_id) projectTenants.add(p.tenant_id);
  }
  const eventTenants = await database.listEventTenantIds();
  const orphanTenants = eventTenants.filter((t) => !projectTenants.has(t));
  if (orphanTenants.length > 0) {
    logger.warn(
      { orphan_tenants: orphanTenants },
      "retention: tenants have events but no project — never pruned (no retention policy). " +
        "Create a project per tenant to apply retention to their data"
    );
  }

  const summary = {
    dryRun,
    exportBeforePrune,
    projects_scanned: projects.length,
    projects_pruned: 0,
    events_deleted: 0,
    sessions_deleted: 0,
    export_failures: 0,
    orphan_tenants: orphanTenants,
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

    const detail = {
      project_id: project.id,
      tenant_id: tenantId,
      retention_days: retentionDays,
      cutoff,
      events_deleted: 0,
      sessions_deleted: 0
    };

    if (dryRun) {
      // Report what would be deleted; export nothing, delete nothing.
      detail.events_deleted = await database.countEventsBefore(tenantId, cutoff);
      if (exportBeforePrune) detail.exported = false; // would-export, but dry-run writes nothing
    } else {
      // Safety gate: export the soon-to-be-deleted events to cold storage first.
      // If the export fails, skip deletion for this project so no data is lost.
      if (exportBeforePrune) {
        try {
          const exp = await exportTenant(tenantId, cutoff);
          detail.exported = true;
          detail.objects_written = exp ? exp.objects_written : undefined;
          detail.events_exported = exp ? exp.events_exported : undefined;
        } catch (err) {
          detail.exported = false;
          detail.export_error = err && err.message ? err.message : String(err);
          summary.export_failures += 1;
          summary.details.push(detail);
          logger.error(
            { project_id: project.id, tenant_id: tenantId, cutoff, error: detail.export_error },
            "retention: cold-storage export failed — skipping prune for this project"
          );
          continue; // do NOT delete unbacked data
        }
      }

      const res = await database.pruneEventsBefore(tenantId, cutoff);
      detail.events_deleted = res.events_deleted;
      detail.sessions_deleted = res.sessions_deleted;
    }

    summary.events_deleted += detail.events_deleted;
    summary.sessions_deleted += detail.sessions_deleted;
    if (detail.events_deleted > 0) summary.projects_pruned += 1;

    summary.details.push(detail);

    logger.info(
      {
        project_id: project.id,
        tenant_id: tenantId,
        retention_days: retentionDays,
        cutoff,
        events_deleted: detail.events_deleted,
        sessions_deleted: detail.sessions_deleted,
        exported: detail.exported,
        dry_run: dryRun
      },
      dryRun ? "retention: would prune events" : "retention: pruned events"
    );
  }

  return summary;
}

module.exports = { isPrunable, computeCutoff, pruneAll };
