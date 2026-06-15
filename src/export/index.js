"use strict";

/**
 * src/export/index.js — event export orchestration (Phase 17 PR-A)
 *
 * Streams a tenant's event log to a pluggable sink as JSON Lines (gzip by
 * default).  The *event* envelope is the archival unit: sessions are derived,
 * denormalised summaries that can be rebuilt from events, and the retention /
 * prune job (Phase 13-D, wired to export in PR-D) operates on events too — so
 * exporting events is exactly what "export to cold storage before delete" needs.
 *
 * Design
 * ------
 *   • `writeRecords()` is the pure streaming core: records → encoder → optional
 *     compressor → byte counter → sink.  It takes an injected sink and an
 *     iterable of records, so it is fully unit-testable against a LocalFileSink
 *     and a temp dir with no database.
 *   • `runExport()` wires the storage backend in: it resolves the tenant set,
 *     fetches each tenant's time-windowed events, and exports one object per
 *     tenant.  `--dry-run` reports what *would* be written without touching the
 *     sink.
 *
 * Like the prune job, this is a run-once operator entry point — there is no
 * always-on scheduler (cron / k8s CronJob wiring is documented in PR-D).
 *
 * Scope caveats
 * -------------
 *   • `events` rows carry `tenant_id`, not `project_id`, so export is scoped by a
 *     project's `tenant_id` (carried from quota metering / retention).
 *   • A full export enumerates tenants from the project registry. A key's tenant
 *     can differ from its bound project's tenant, so a tenant may have events but
 *     no project row (issue #122): such "orphan" tenants are reported in the
 *     summary's `orphan_tenants` and skipped by default (a warning is logged);
 *     pass `--all-tenants` / `EXPORT_ALL_TENANTS=1` to union them in.
 *   • Events with a NULL `tenant_id` (untagged) are still not reachable by a full
 *     run (even with `--all-tenants`): `getEventsForQuery(null)` means "all
 *     tenants", so there is no single-tenant slice for them. This matches the
 *     read API / prune scoping; per-project event tagging would remove it (a
 *     candidate for a later PR).
 *   • `runExport` materialises each tenant's window fully in memory (the DB read
 *     returns an array; the encode→compress→sink half then streams it). This is
 *     fine for the current scale and mirrors the analytics/customQuery readers;
 *     a cursor-streamed read is a candidate enhancement for very large windows.
 */

const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const defaultDb = require("../db");
const logger = require("../logger");
const {
  createEncoder,
  createCompressor,
  formatExtension,
  compressionExtension,
  isSelfCompressed
} = require("./formats");

const DEFAULT_FORMAT = "jsonl";
const DEFAULT_COMPRESSION = "gzip";

/**
 * Make a tenant id safe for use in a filename / object key.
 * @param {string} tenantId
 * @returns {string}
 */
function slugifyTenant(tenantId) {
  const s = String(tenantId === null || tenantId === undefined ? "unknown" : tenantId)
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "unknown";
}

/**
 * Build a stable, filesystem- and S3-safe object key for one tenant export.
 * Example: `dev/aep-events-dev-20260614T101530Z.jsonl.gz`.
 *
 * @param {{ tenantId: string, now?: number|Date, format?: string,
 *           compression?: string, prefix?: string }} opts
 * @returns {string}
 */
function buildObjectKey({
  tenantId,
  now = Date.now(),
  format = DEFAULT_FORMAT,
  compression = DEFAULT_COMPRESSION,
  prefix = ""
} = {}) {
  const slug = slugifyTenant(tenantId);
  const ts = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `aep-events-${slug}-${ts}.${formatExtension(format)}${compressionExtension(compression)}`;
  const cleanPrefix = String(prefix || "").replace(/^\/+|\/+$/g, "");
  return cleanPrefix ? `${cleanPrefix}/${slug}/${name}` : `${slug}/${name}`;
}

/**
 * Stream `records` through the format encoder + optional compressor into `sink`
 * under `key`.  Returns the compressed byte size and the sink location.
 *
 * Pure with respect to storage: `records` is any iterable / async-iterable of
 * event envelopes and `sink` is any ExportSink, so this is unit-testable with a
 * LocalFileSink and an in-memory array.
 *
 * Parquet is a binary columnar format and is written by src/export/parquet.js
 * (lazily loaded); it manages its own compression, so `compression` is ignored
 * for it.
 *
 * @param {{ records: Iterable<object>|AsyncIterable<object>, format?: string,
 *           compression?: string, sink: import('./sink').ExportSink, key: string }} opts
 * @returns {Promise<{ bytes: number, location: string }>}
 */
async function writeRecords({ records, format = DEFAULT_FORMAT, compression = DEFAULT_COMPRESSION, sink, key }) {
  if (!sink) throw new Error("writeRecords requires a sink");
  if (!key) throw new Error("writeRecords requires a key");

  if (isSelfCompressed(format)) {
    // Columnar self-compressed formats (parquet) are not per-record stream
    // Transforms — delegate to their dedicated writer (lazy-loads the heavy lib).
    const { writeParquet } = require("./parquet");
    return writeParquet({ records, sink, key });
  }

  const { stream: encoder } = createEncoder(format);
  const { stream: compressor } = createCompressor(compression);

  const source = Readable.from(records, { objectMode: true });

  // Count bytes inside a pass-through Transform (not via a 'data' listener):
  // counting happens in _transform as bytes flow downstream, so it cannot race
  // the sink's consumer or drain the stream out from under it.
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    }
  });

  const stages = compressor ? [source, encoder, compressor, counter] : [source, encoder, counter];

  // Drive the encode/compress pipeline into `counter` while the sink drains
  // `counter` into its destination, concurrently. Either side erroring tears
  // down the shared stream and rejects the other.
  const [, sinkResult] = await Promise.all([pipeline(stages), sink.write(key, counter)]);

  return { bytes, location: sinkResult.location };
}

/**
 * Plan the tenant set for a full export pass in a single DB pass, and report the
 * "orphan" tenants — those that have events but no project row (issue #122).
 *
 * When `tenantId` is given, exports just that tenant (no orphan computation).
 * Otherwise derives the distinct project tenants from the project registry
 * (mirrors how the prune job scopes work by project tenant); when `allTenants`
 * is set it additionally unions in the distinct `events.tenant_id` values, so
 * tenants whose key points at a different project's tenant are still covered.
 *
 * @param {object} db
 * @param {string|null} tenantId
 * @param {{ allTenants?: boolean }} [opts]
 * @returns {Promise<{ tenantIds: string[], orphanTenants: string[] }>}
 *          `orphanTenants` is the set of event tenants with no project row
 *          (empty when `tenantId` is given).
 */
async function planTenants(db, tenantId, { allTenants = false } = {}) {
  if (tenantId) return { tenantIds: [tenantId], orphanTenants: [] };

  const projects = await db.listProjects();
  const projectTenants = new Set();
  for (const p of projects) {
    if (p.tenant_id) projectTenants.add(p.tenant_id);
  }

  const eventTenants = await db.listEventTenantIds();
  const orphanTenants = eventTenants.filter((t) => !projectTenants.has(t));

  const tenantIds = allTenants
    ? [...new Set([...projectTenants, ...eventTenants])]
    : [...projectTenants];

  return { tenantIds, orphanTenants };
}

/**
 * Resolve the set of tenant ids to export.  Thin wrapper over `planTenants`
 * that returns just the tenant list (kept for API/test stability).
 *
 * @param {object} db
 * @param {string|null} tenantId
 * @param {{ allTenants?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
async function resolveTenantIds(db, tenantId, opts = {}) {
  return (await planTenants(db, tenantId, opts)).tenantIds;
}

/**
 * Run one export pass over the resolved tenant set.
 *
 * Requires the storage backend to be initialised (`await db.init()`).  For each
 * tenant with at least one event in the window, fetches the time-windowed
 * events and writes a single object to the sink.  Tenants with no events in the
 * window are skipped (no empty object is created).
 *
 * Orphan tenants (issue #122): a key's tenant can differ from its bound
 * project's tenant, so a tenant may have events but no project row.  A full run
 * (`tenantId` unset) reports such tenants in `orphan_tenants`.  By default they
 * are *not* exported (only a warning is logged); pass `allTenants` to union them
 * into the export set.  A single-tenant run (`tenantId` set) is unaffected.
 *
 * @param {{
 *   db?: object, tenantId?: string|null, since?: string|null, until?: string|null,
 *   format?: string, compression?: string, sink?: import('./sink').ExportSink,
 *   prefix?: string, now?: number|Date, dryRun?: boolean, allTenants?: boolean
 * }} [opts]
 * @returns {Promise<{
 *   dryRun: boolean, allTenants: boolean, format: string, compression: string,
 *   tenants_scanned: number, tenants_exported: number,
 *   events_exported: number, objects_written: number, orphan_tenants: string[],
 *   details: Array<{ tenant_id: string, events: number, key: string|null,
 *                    location: string|null, bytes: number|null, skipped?: boolean }>
 * }>}
 */
async function runExport({
  db = defaultDb,
  tenantId = null,
  since = null,
  until = null,
  format = DEFAULT_FORMAT,
  compression = DEFAULT_COMPRESSION,
  sink = null,
  prefix = "",
  now = Date.now(),
  dryRun = false,
  allTenants = false
} = {}) {
  // Validate format/compression up front so dry-run fails the same way a real
  // run would (and so key building below cannot throw mid-pass).
  formatExtension(format);
  compressionExtension(compression);
  if (!dryRun && !sink) {
    throw new Error("runExport requires a sink unless dryRun is set");
  }

  // Self-compressed formats (parquet) carry their own internal compression, so
  // the external compression layer + its filename extension do not apply.
  const effectiveCompression = isSelfCompressed(format) ? "none" : compression;

  const { tenantIds, orphanTenants } = await planTenants(db, tenantId, { allTenants });

  // Surface tenants that have events but no project row. With --all-tenants they
  // are included (info); otherwise they are skipped, so warn loudly so the
  // silent miss (issue #122) is visible.
  if (orphanTenants.length > 0) {
    if (allTenants) {
      logger.info(
        { orphan_tenants: orphanTenants },
        "export: including tenants that have events but no project (--all-tenants)"
      );
    } else {
      logger.warn(
        { orphan_tenants: orphanTenants },
        "export: tenants have events but no project and were NOT exported — pass " +
          "--all-tenants (or EXPORT_ALL_TENANTS=1) to include them, or --tenant <id> for one"
      );
    }
  }

  const summary = {
    dryRun,
    allTenants,
    format,
    compression: effectiveCompression,
    tenants_scanned: tenantIds.length,
    tenants_exported: 0,
    events_exported: 0,
    objects_written: 0,
    orphan_tenants: orphanTenants,
    details: []
  };

  for (const tid of tenantIds) {
    const events = await db.getEventsForQuery(tid, { since, until });
    const key = buildObjectKey({ tenantId: tid, now, format, compression: effectiveCompression, prefix });

    if (events.length === 0) {
      summary.details.push({ tenant_id: tid, events: 0, key: null, location: null, bytes: null, skipped: true });
      continue;
    }

    summary.events_exported += events.length;
    summary.tenants_exported += 1;

    if (dryRun) {
      summary.details.push({ tenant_id: tid, events: events.length, key, location: null, bytes: null });
      logger.info(
        { tenant_id: tid, events: events.length, key, format, compression: effectiveCompression, since, until, dry_run: true },
        "export: would write events"
      );
      continue;
    }

    const { bytes, location } = await writeRecords({ records: events, format, compression: effectiveCompression, sink, key });
    summary.objects_written += 1;
    summary.details.push({ tenant_id: tid, events: events.length, key, location, bytes });
    logger.info(
      { tenant_id: tid, events: events.length, key, location, bytes, format, compression: effectiveCompression, since, until },
      "export: wrote events"
    );
  }

  return summary;
}

module.exports = {
  DEFAULT_FORMAT,
  DEFAULT_COMPRESSION,
  slugifyTenant,
  buildObjectKey,
  writeRecords,
  planTenants,
  resolveTenantIds,
  runExport
};
