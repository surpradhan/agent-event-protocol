#!/usr/bin/env node
"use strict";

/**
 * src/export.js — S3 / cold-storage export job entry point (Phase 17 PR-A)
 *
 * Streams each tenant's event log to a sink as JSON Lines (gzip by default).
 * Like the prune job (src/prune.js), this is an operator-invokable, run-once
 * job — there is no always-on scheduler.  Wire it to cron / a k8s CronJob in
 * production (documented in PR-D).
 *
 * Usage
 * -----
 *   npm run export                         # export all tenants to ./exports
 *   npm run export -- --tenant dev         # only tenant "dev"
 *   npm run export -- --out /data/exports  # local sink directory
 *   npm run export -- --since 2026-01-01T00:00:00Z --until 2026-06-01T00:00:00Z
 *   npm run export -- --compression none   # gzip (default) | none
 *   npm run export -- --dry-run            # report what WOULD be written
 *   node src/export.js --json              # machine-readable summary on stdout
 *
 * It uses the same storage backend the server uses (STORAGE_BACKEND / the usual
 * DATABASE_PATH / DATABASE_URL env vars), so it exports from the live database.
 *
 * Exit codes: 0 on success, 1 on failure.
 */

const path = require("path");

const db = require("./db");
const { runExport, DEFAULT_FORMAT, DEFAULT_COMPRESSION } = require("./export/index");
const { LocalFileSink } = require("./export/sink");
const { SUPPORTED_FORMATS, SUPPORTED_COMPRESSIONS } = require("./export/formats");

const DEFAULT_OUT_DIR = "./exports";

/**
 * Parse argv into export options.  Supports `--flag value` and `--flag=value`.
 * @param {string[]} argv  full process.argv
 * @returns {{ tenantId: string|null, since: string|null, until: string|null,
 *             out: string, prefix: string, format: string, compression: string,
 *             dryRun: boolean, json: boolean, help: boolean }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    tenantId: null,
    since: null,
    until: null,
    out: DEFAULT_OUT_DIR,
    prefix: "",
    format: DEFAULT_FORMAT,
    compression: DEFAULT_COMPRESSION,
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h")
  };

  const valueOf = (i) => {
    const a = args[i];
    const eq = a.indexOf("=");
    if (eq !== -1) return { value: a.slice(eq + 1), consumedNext: false };
    return { value: args[i + 1], consumedNext: true };
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith("--") ? a.split("=")[0] : a;
    switch (name) {
      case "--tenant": {
        const { value, consumedNext } = valueOf(i);
        opts.tenantId = value ?? null;
        if (consumedNext) i++;
        break;
      }
      case "--since": {
        const { value, consumedNext } = valueOf(i);
        opts.since = value ?? null;
        if (consumedNext) i++;
        break;
      }
      case "--until": {
        const { value, consumedNext } = valueOf(i);
        opts.until = value ?? null;
        if (consumedNext) i++;
        break;
      }
      case "--out": {
        const { value, consumedNext } = valueOf(i);
        if (value) opts.out = value;
        if (consumedNext) i++;
        break;
      }
      case "--prefix": {
        const { value, consumedNext } = valueOf(i);
        opts.prefix = value ?? "";
        if (consumedNext) i++;
        break;
      }
      case "--format": {
        const { value, consumedNext } = valueOf(i);
        if (value) opts.format = value;
        if (consumedNext) i++;
        break;
      }
      case "--compression": {
        const { value, consumedNext } = valueOf(i);
        if (value) opts.compression = value;
        if (consumedNext) i++;
        break;
      }
      default:
        break;
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
aep export — stream each tenant's event log to a sink (JSON Lines, gzip default)

Usage:
  npm run export                          Export all tenants to ${DEFAULT_OUT_DIR}
  npm run export -- --tenant <id>         Export only one tenant
  npm run export -- --out <dir>           Local sink directory (default ${DEFAULT_OUT_DIR})
  npm run export -- --prefix <key>        Key prefix within the sink
  npm run export -- --since <iso>         Only events with time >= since
  npm run export -- --until <iso>         Only events with time <  until
  npm run export -- --format <fmt>        ${SUPPORTED_FORMATS.join(" | ")} (default ${DEFAULT_FORMAT})
  npm run export -- --compression <c>     ${SUPPORTED_COMPRESSIONS.join(" | ")} (default ${DEFAULT_COMPRESSION})
  npm run export -- --dry-run             Report what WOULD be written (no writes)
  node src/export.js --json               Print a machine-readable JSON summary

One object is written per tenant; tenants with no events in the window are skipped.
Export is scoped by each tenant_id (see src/export/index.js).
`);
}

function printHuman(summary, outDir) {
  const verb = summary.dryRun ? "Would export" : "Exported";
  console.log(
    `${summary.dryRun ? "[dry-run] " : ""}Scanned ${summary.tenants_scanned} tenant(s); ` +
    `${verb.toLowerCase()} ${summary.events_exported} event(s) ` +
    `across ${summary.tenants_exported} tenant(s)` +
    `${summary.dryRun ? "" : ` into ${summary.objects_written} object(s)`} ` +
    `(${summary.format}, ${summary.compression}${summary.dryRun ? "" : `, ${outDir}`}).`
  );
  for (const d of summary.details) {
    if (d.skipped) continue;
    if (summary.dryRun) {
      console.log(`  - tenant ${d.tenant_id}: would write ${d.events} event(s) → ${d.key}`);
    } else {
      console.log(
        `  - tenant ${d.tenant_id}: ${d.events} event(s), ${d.bytes} byte(s) → ${d.location}`
      );
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    return;
  }

  const sink = opts.dryRun ? null : new LocalFileSink({ dir: path.resolve(opts.out) });

  await db.init();
  try {
    const summary = await runExport({
      tenantId: opts.tenantId,
      since: opts.since,
      until: opts.until,
      format: opts.format,
      compression: opts.compression,
      prefix: opts.prefix,
      sink,
      dryRun: opts.dryRun
    });

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printHuman(summary, path.resolve(opts.out));
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
