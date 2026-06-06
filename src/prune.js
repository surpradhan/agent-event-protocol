#!/usr/bin/env node
"use strict";

/**
 * src/prune.js — retention / pruning job entry point (Phase 13 PR-D)
 *
 * Deletes events older than each project's `retention_days` policy (and
 * reconciles the derived `sessions` summaries).  This is an operator-invokable,
 * run-once job — there is no always-on scheduler.  Wire it to cron / a k8s
 * CronJob in production (documented in PR-E).
 *
 * Usage
 * -----
 *   npm run prune              # delete expired events for all projects
 *   npm run prune -- --dry-run # report what WOULD be deleted, change nothing
 *   node src/prune.js --json   # machine-readable summary on stdout
 *
 * It uses the same storage backend the server uses (STORAGE_BACKEND / the usual
 * DATABASE_PATH / DATABASE_URL env vars), so it prunes the live database.
 *
 * Exit codes: 0 on success, 1 on failure.
 */

const db = require("./db");
const { pruneAll } = require("./retention");

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h")
  };
}

function printHelp() {
  console.log(`
aep prune — delete events older than each project's retention_days policy

Usage:
  npm run prune                 Delete expired events for all projects
  npm run prune -- --dry-run    Report what WOULD be deleted (no changes)
  node src/prune.js --json      Print a machine-readable JSON summary

Projects with retention_days NULL / 0 / negative are kept forever (never pruned).
Retention is scoped by each project's tenant_id (see src/retention.js).
`);
}

function printHuman(summary) {
  const verb = summary.dryRun ? "Would prune" : "Pruned";
  console.log(
    `${summary.dryRun ? "[dry-run] " : ""}Scanned ${summary.projects_scanned} project(s); ` +
    `${verb.toLowerCase()} ${summary.events_deleted} event(s) ` +
    `and ${summary.sessions_deleted} empty session(s) ` +
    `across ${summary.projects_pruned} project(s).`
  );
  for (const d of summary.details) {
    if (d.events_deleted === 0 && d.sessions_deleted === 0) continue;
    console.log(
      `  - project ${d.project_id} (tenant ${d.tenant_id}, ${d.retention_days}d, ` +
      `cutoff ${d.cutoff}): ${verb.toLowerCase()} ${d.events_deleted} event(s), ` +
      `${d.sessions_deleted} session(s)`
    );
  }
}

async function main() {
  const { dryRun, json, help } = parseArgs(process.argv);

  if (help) {
    printHelp();
    return;
  }

  await db.init();
  try {
    const summary = await pruneAll({ dryRun });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printHuman(summary);
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
