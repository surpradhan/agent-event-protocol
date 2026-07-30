#!/usr/bin/env node
"use strict";

/**
 * src/export.js — S3 / cold-storage export job entry point (Phase 17 PR-A, PR-B)
 *
 * Streams each tenant's event log to a sink as JSON Lines (gzip by default).
 * Like the prune job (src/prune.js), this is an operator-invokable, run-once
 * job — there is no always-on scheduler.  Wire it to cron / a k8s CronJob in
 * production (documented in PR-D).
 *
 * Sinks (PR-B): the local filesystem (default) or Amazon S3 (`--sink s3`, off by
 * default).  S3 credentials are resolved from the standard AWS credential chain
 * and are never accepted as flags or logged.
 *
 * Usage
 * -----
 *   npm run export                         # export all tenants to ./exports
 *   npm run export -- --tenant dev         # only tenant "dev"
 *   npm run export -- --out /data/exports  # local sink directory
 *   npm run export -- --sink s3 --bucket my-aep-archive --region us-east-1
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
const { describeError, withTarget, databaseTarget } = require("./errors");
const { runExport, DEFAULT_FORMAT, DEFAULT_COMPRESSION } = require("./export/index");
const { createSink, SUPPORTED_SINKS } = require("./export/sink");
const { SUPPORTED_FORMATS, SUPPORTED_COMPRESSIONS, isSelfCompressed } = require("./export/formats");

const DEFAULT_OUT_DIR = "./exports";

/**
 * Parse argv into export options.  Supports `--flag value` and `--flag=value`.
 * Sink selection (`sink`/`bucket`/`region`/`endpoint`) defaults to null here so
 * that env-var fallbacks are applied later in main() — parseArgs stays a pure,
 * env-free function for unit testing.
 *
 * Throws if a value-taking flag is bare — at the end of argv, or immediately
 * followed by another `--flag` — rather than silently defaulting or letting it
 * swallow the next flag's own token as its value (issue #181).
 *
 * @param {string[]} argv  full process.argv
 * @returns {{ tenantId: string|null, since: string|null, until: string|null,
 *             out: string, prefix: string, format: string, compression: string,
 *             sink: string|null, bucket: string|null, region: string|null,
 *             endpoint: string|null, allTenants: boolean, dryRun: boolean,
 *             json: boolean, help: boolean }}
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
    sink: null,
    bucket: null,
    region: null,
    endpoint: null,
    allTenants: args.includes("--all-tenants"),
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h")
  };

  // A bare flag — at the end of argv, or immediately followed by another
  // `--flag` — has no value to give. Erroring here (issue #181) beats silently
  // keeping the default (the old `if (value) …` guards) or, worse, consuming
  // the *next* flag's own token as this flag's value.
  const valueOf = (i, flagName) => {
    const a = args[i];
    const eq = a.indexOf("=");
    if (eq !== -1) return { value: a.slice(eq + 1), consumedNext: false };
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${flagName} requires a value`);
    }
    return { value: next, consumedNext: true };
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith("--") ? a.split("=")[0] : a;
    switch (name) {
      case "--tenant": {
        const { value, consumedNext } = valueOf(i, name);
        opts.tenantId = value ?? null;
        if (consumedNext) i++;
        break;
      }
      case "--since": {
        const { value, consumedNext } = valueOf(i, name);
        opts.since = value ?? null;
        if (consumedNext) i++;
        break;
      }
      case "--until": {
        const { value, consumedNext } = valueOf(i, name);
        opts.until = value ?? null;
        if (consumedNext) i++;
        break;
      }
      case "--out": {
        const { value, consumedNext } = valueOf(i, name);
        if (value) opts.out = value;
        if (consumedNext) i++;
        break;
      }
      case "--prefix": {
        const { value, consumedNext } = valueOf(i, name);
        opts.prefix = value ?? "";
        if (consumedNext) i++;
        break;
      }
      case "--format": {
        const { value, consumedNext } = valueOf(i, name);
        if (value) opts.format = value;
        if (consumedNext) i++;
        break;
      }
      case "--compression": {
        const { value, consumedNext } = valueOf(i, name);
        if (value) opts.compression = value;
        if (consumedNext) i++;
        break;
      }
      case "--sink": {
        const { value, consumedNext } = valueOf(i, name);
        if (value) opts.sink = value;
        if (consumedNext) i++;
        break;
      }
      case "--bucket": {
        const { value, consumedNext } = valueOf(i, name);
        if (value) opts.bucket = value;
        if (consumedNext) i++;
        break;
      }
      case "--region": {
        const { value, consumedNext } = valueOf(i, name);
        if (value) opts.region = value;
        if (consumedNext) i++;
        break;
      }
      case "--endpoint": {
        const { value, consumedNext } = valueOf(i, name);
        if (value) opts.endpoint = value;
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
  npm run export -- --sink <s>            ${SUPPORTED_SINKS.join(" | ")} (default local; env EXPORT_SINK)
  npm run export -- --out <dir>           Local sink directory (default ${DEFAULT_OUT_DIR})
  npm run export -- --bucket <name>       S3 bucket (sink=s3; env EXPORT_S3_BUCKET)
  npm run export -- --region <r>          S3 region (env EXPORT_S3_REGION / AWS_REGION)
  npm run export -- --endpoint <url>      S3-compatible endpoint (env EXPORT_S3_ENDPOINT)
  npm run export -- --all-tenants         Also export tenants with events but no
                                          project (env EXPORT_ALL_TENANTS=1)
  npm run export -- --prefix <key>        Key prefix within the sink
  npm run export -- --since <iso>         Only events with time >= since
  npm run export -- --until <iso>         Only events with time <  until
  npm run export -- --format <fmt>        ${SUPPORTED_FORMATS.join(" | ")} (default ${DEFAULT_FORMAT})
  npm run export -- --compression <c>     ${SUPPORTED_COMPRESSIONS.join(" | ")} (default ${DEFAULT_COMPRESSION})
  npm run export -- --dry-run             Report what WOULD be written (no writes)
  node src/export.js --json               Print a machine-readable JSON summary

One object is written per tenant; tenants with no events in the window are skipped.
Export is scoped by each tenant_id (see src/export/index.js).

By default a full run enumerates tenants from the project registry. Tenants that
have events but no project row (issue #122) are reported and skipped with a
warning; --all-tenants (or EXPORT_ALL_TENANTS=1) unions them into the export set.

Compression (gzip/brotli) wraps the text formats (jsonl, csv). Parquet is columnar
and self-compressed (internal GZIP), so --compression does not apply to it.

S3 is off unless --sink s3 (or EXPORT_SINK=s3). AWS credentials are read from the
standard credential chain (env / shared config / SSO / instance role) — never
passed as flags and never logged.
`);
}

/**
 * Resolve the sink configuration from parsed flags + env-var fallbacks.
 * @param {ReturnType<typeof parseArgs>} opts
 * @returns {{ kind: string, dir: string, bucket: string|null, region: string|null,
 *             endpoint: string|null }}
 */
function resolveSinkConfig(opts) {
  return {
    kind: String(opts.sink || process.env.EXPORT_SINK || "local").toLowerCase(),
    dir: path.resolve(opts.out),
    bucket: opts.bucket || process.env.EXPORT_S3_BUCKET || null,
    region: opts.region || process.env.EXPORT_S3_REGION || process.env.AWS_REGION || null,
    endpoint: opts.endpoint || process.env.EXPORT_S3_ENDPOINT || null
  };
}

/**
 * Short human label for the resolved destination (no credentials).
 * @param {ReturnType<typeof resolveSinkConfig>} cfg
 * @returns {string}
 */
function destinationLabel(cfg) {
  if (cfg.kind === "s3") {
    const base = cfg.endpoint ? `${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}` : `s3://${cfg.bucket}`;
    return base;
  }
  return cfg.dir;
}

function printHuman(summary, destLabel) {
  const verb = summary.dryRun ? "Would export" : "Exported";
  console.log(
    `${summary.dryRun ? "[dry-run] " : ""}Scanned ${summary.tenants_scanned} tenant(s); ` +
    `${verb.toLowerCase()} ${summary.events_exported} event(s) ` +
    `across ${summary.tenants_exported} tenant(s)` +
    `${summary.dryRun ? "" : ` into ${summary.objects_written} object(s)`} ` +
    `(${summary.format}, ${summary.compression}${summary.dryRun ? "" : `, ${destLabel}`}).`
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
  // Orphan tenants: events but no project row (issue #122). Surfaced on stderr so
  // it stands out and does not pollute --json / piped stdout.
  const orphans = summary.orphan_tenants || [];
  if (orphans.length > 0 && !summary.allTenants) {
    console.error(
      `⚠️  ${orphans.length} tenant(s) have events but no project and were NOT exported: ` +
      `${orphans.join(", ")}. Pass --all-tenants (or EXPORT_ALL_TENANTS=1) to include them, ` +
      `or --tenant <id> to export one.`
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    return;
  }

  // If the user explicitly asked for a compression that a self-compressed format
  // (parquet) ignores, say so on stderr rather than silently dropping it.
  const explicitCompression = process.argv.some(
    (a) => a === "--compression" || a.startsWith("--compression=")
  );
  if (explicitCompression && isSelfCompressed(opts.format) && opts.compression !== "none") {
    console.error(
      `Note: --format ${opts.format} is self-compressed; --compression ${opts.compression} is ignored.`
    );
  }

  const sinkConfig = resolveSinkConfig(opts);
  const sink = opts.dryRun ? null : createSink(sinkConfig);

  // Include tenants that have events but no project (issue #122) when the flag
  // or EXPORT_ALL_TENANTS=1 is set; otherwise they are reported and skipped.
  const allTenants = opts.allTenants || process.env.EXPORT_ALL_TENANTS === "1";

  try {
    await db.init();
  } catch (err) {
    // Name the database we failed to dial (issue #186), matching src/cli.js's
    // unreachable-server errors; a reached-server failure passes through.
    throw withTarget(err, databaseTarget());
  }
  try {
    const summary = await runExport({
      tenantId: opts.tenantId,
      since: opts.since,
      until: opts.until,
      format: opts.format,
      compression: opts.compression,
      prefix: opts.prefix,
      sink,
      dryRun: opts.dryRun,
      allTenants
    });

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printHuman(summary, destinationLabel(sinkConfig));
    }
  } finally {
    await db.closeDb();
  }
}

// Only run when invoked directly (not when required by tests).
if (require.main === module) {
  main().catch((err) => {
    console.error(`\x1b[31mError:\x1b[0m ${describeError(err)}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, resolveSinkConfig, destinationLabel };
