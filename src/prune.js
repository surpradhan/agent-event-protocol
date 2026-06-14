#!/usr/bin/env node
"use strict";

/**
 * src/prune.js — retention / pruning job entry point (Phase 13 PR-D, Phase 17 PR-D)
 *
 * Deletes events older than each project's `retention_days` policy (and
 * reconciles the derived `sessions` summaries).  This is an operator-invokable,
 * run-once job — there is no always-on scheduler.  Wire it to cron / a k8s
 * CronJob in production (see OPERATIONS.md §3 and §7).
 *
 * Export before delete (Phase 17 PR-D)
 * ------------------------------------
 * With `--export-before-prune` (or `PRUNE_EXPORT_BEFORE_DELETE=1`), each
 * project's soon-to-be-deleted events (those older than its cutoff) are exported
 * to cold storage *first*, using the export module + the standard EXPORT_* env
 * configuration (sink, format, compression).  If the export of a project fails,
 * that project's events are NOT deleted — see src/retention.js for the safety
 * gate.  `--dry-run` never exports and never deletes.
 *
 * Usage
 * -----
 *   npm run prune                          # delete expired events for all projects
 *   npm run prune -- --dry-run             # report what WOULD be deleted, change nothing
 *   npm run prune -- --export-before-prune # export expired events to cold storage, then delete
 *   node src/prune.js --json               # machine-readable summary on stdout
 *
 * It uses the same storage backend the server uses (STORAGE_BACKEND / the usual
 * DATABASE_PATH / DATABASE_URL env vars), so it prunes the live database.
 *
 * Export config (when --export-before-prune): EXPORT_SINK (local|s3),
 * EXPORT_OUT (local dir), EXPORT_S3_BUCKET / EXPORT_S3_REGION / EXPORT_S3_ENDPOINT,
 * EXPORT_FORMAT (jsonl|csv|parquet), EXPORT_COMPRESSION (none|gzip|brotli),
 * EXPORT_PREFIX.  AWS credentials come from the standard chain (never logged).
 *
 * Exit codes: 0 on success, 1 on failure.
 */

const db = require("./db");
const { pruneAll } = require("./retention");
const { runExport } = require("./export/index");
const { createSink } = require("./export/sink");
const { formatExtension, compressionExtension } = require("./export/formats");
const { resolveSinkConfig, destinationLabel } = require("./export");

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
    exportBeforePrune: args.includes("--export-before-prune"),
    help: args.includes("--help") || args.includes("-h")
  };
}

function printHelp() {
  console.log(`
aep prune — delete events older than each project's retention_days policy

Usage:
  npm run prune                          Delete expired events for all projects
  npm run prune -- --dry-run             Report what WOULD be deleted (no changes)
  npm run prune -- --export-before-prune Export expired events to cold storage, then delete
  node src/prune.js --json               Print a machine-readable JSON summary

Projects with retention_days NULL / 0 / negative are kept forever (never pruned).
Retention is scoped by each project's tenant_id (see src/retention.js).

--export-before-prune (or PRUNE_EXPORT_BEFORE_DELETE=1) archives each project's
expired events (those older than its cutoff) to cold storage BEFORE deleting them.
If a project's export fails, its events are NOT deleted (safety gate). Configure
the destination with the EXPORT_* env vars (EXPORT_SINK / EXPORT_OUT /
EXPORT_S3_BUCKET / EXPORT_FORMAT / EXPORT_COMPRESSION ...); see OPERATIONS.md §7.
`);
}

function printHuman(summary, destLabel) {
  const verb = summary.dryRun ? "Would prune" : "Pruned";
  const exportNote = summary.exportBeforePrune ? ` (export-before-prune → ${destLabel})` : "";
  console.log(
    `${summary.dryRun ? "[dry-run] " : ""}Scanned ${summary.projects_scanned} project(s); ` +
    `${verb.toLowerCase()} ${summary.events_deleted} event(s) ` +
    `and ${summary.sessions_deleted} empty session(s) ` +
    `across ${summary.projects_pruned} project(s)${exportNote}.`
  );
  if (summary.export_failures > 0) {
    console.log(`  ⚠️  ${summary.export_failures} project(s) skipped — cold-storage export failed (not deleted).`);
  }
  for (const d of summary.details) {
    if (d.export_error) {
      console.log(
        `  - project ${d.project_id} (tenant ${d.tenant_id}, ${d.retention_days}d, ` +
        `cutoff ${d.cutoff}): EXPORT FAILED (${d.export_error}) — not pruned`
      );
      continue;
    }
    if (d.events_deleted === 0 && d.sessions_deleted === 0) continue;
    const exported = summary.exportBeforePrune && !summary.dryRun
      ? `exported ${d.events_exported ?? 0} event(s) → ${d.objects_written ?? 0} object(s), then `
      : "";
    console.log(
      `  - project ${d.project_id} (tenant ${d.tenant_id}, ${d.retention_days}d, ` +
      `cutoff ${d.cutoff}): ${exported}${verb.toLowerCase()} ${d.events_deleted} event(s), ` +
      `${d.sessions_deleted} session(s)`
    );
  }
}

/**
 * Build the export-before-prune wiring from the EXPORT_* env config. Validates
 * the format/compression and constructs the sink up front so a misconfiguration
 * (unknown format, `s3` without a bucket, …) fails fast — before anything is
 * deleted. Returns the injected `exportTenant` and a destination label for output.
 * @returns {{ exportTenant: (tenantId: string, cutoff: string) => Promise<object>,
 *             destLabel: string }}
 */
function buildExportWiring() {
  const format = process.env.EXPORT_FORMAT || "jsonl";
  const compression = process.env.EXPORT_COMPRESSION || "gzip";
  const prefix = process.env.EXPORT_PREFIX || "";
  formatExtension(format);            // validate (throws on unknown)
  compressionExtension(compression);  // validate (throws on unknown)

  const sinkConfig = resolveSinkConfig({
    out: process.env.EXPORT_OUT || "./exports",
    sink: null, bucket: null, region: null, endpoint: null
  });
  const sink = createSink(sinkConfig); // throws e.g. if sink=s3 without a bucket

  // Export exactly the prune predicate (events with time < cutoff) for one
  // tenant; resolves runExport's summary, rejects on any sink/encode failure.
  const exportTenant = (tenantId, cutoff) =>
    runExport({ tenantId, since: null, until: cutoff, format, compression, prefix, sink });

  return { exportTenant, destLabel: destinationLabel(sinkConfig) };
}

async function main() {
  const { dryRun, json, exportBeforePrune: exportFlag, help } = parseArgs(process.argv);

  if (help) {
    printHelp();
    return;
  }

  const exportBeforePrune = exportFlag || process.env.PRUNE_EXPORT_BEFORE_DELETE === "1";

  // Only a real (non-dry-run) export-before-prune run needs the export wiring.
  let exportTenant = null;
  let destLabel = "";
  if (exportBeforePrune && !dryRun) {
    ({ exportTenant, destLabel } = buildExportWiring());
  }

  await db.init();
  try {
    const summary = await pruneAll({ dryRun, exportBeforePrune, exportTenant });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printHuman(summary, destLabel);
    }
    // Surface a non-zero exit when a cold-storage export blocked a prune, so
    // cron / CronJob alerting can catch it.
    if (summary.export_failures > 0) {
      process.exitCode = 1;
    }
  } finally {
    await db.closeDb();
  }
}

// Only run when invoked directly (not when required by tests).
if (require.main === module) {
  main().catch((err) => {
    console.error(`\x1b[31mError:\x1b[0m ${err.message || String(err)}`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
