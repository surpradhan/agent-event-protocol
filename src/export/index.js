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
 * Scope caveat (carried from quota metering / retention): `events` rows carry
 * `tenant_id`, not `project_id`, so export is scoped by a project's `tenant_id`.
 */

const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const defaultDb = require("../db");
const logger = require("../logger");
const {
  createEncoder,
  createCompressor,
  formatExtension,
  compressionExtension
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
 * @param {{ records: Iterable<object>|AsyncIterable<object>, format?: string,
 *           compression?: string, sink: import('./sink').ExportSink, key: string }} opts
 * @returns {Promise<{ bytes: number, location: string }>}
 */
async function writeRecords({ records, format = DEFAULT_FORMAT, compression = DEFAULT_COMPRESSION, sink, key }) {
  if (!sink) throw new Error("writeRecords requires a sink");
  if (!key) throw new Error("writeRecords requires a key");

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
 * Resolve the set of tenant ids to export.  When `tenantId` is given, exports
 * just that tenant; otherwise derives the distinct tenants from the project
 * registry (mirrors how the prune job scopes work by project tenant).
 *
 * @param {object} db
 * @param {string|null} tenantId
 * @returns {Promise<string[]>}
 */
async function resolveTenantIds(db, tenantId) {
  if (tenantId) return [tenantId];
  const projects = await db.listProjects();
  const seen = new Set();
  for (const p of projects) {
    if (p.tenant_id) seen.add(p.tenant_id);
  }
  return [...seen];
}

/**
 * Run one export pass over the resolved tenant set.
 *
 * Requires the storage backend to be initialised (`await db.init()`).  For each
 * tenant with at least one event in the window, fetches the time-windowed
 * events and writes a single object to the sink.  Tenants with no events in the
 * window are skipped (no empty object is created).
 *
 * @param {{
 *   db?: object, tenantId?: string|null, since?: string|null, until?: string|null,
 *   format?: string, compression?: string, sink?: import('./sink').ExportSink,
 *   prefix?: string, now?: number|Date, dryRun?: boolean
 * }} [opts]
 * @returns {Promise<{
 *   dryRun: boolean, format: string, compression: string,
 *   tenants_scanned: number, tenants_exported: number,
 *   events_exported: number, objects_written: number,
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
  dryRun = false
} = {}) {
  // Validate format/compression up front so dry-run fails the same way a real
  // run would (and so key building below cannot throw mid-pass).
  formatExtension(format);
  compressionExtension(compression);
  if (!dryRun && !sink) {
    throw new Error("runExport requires a sink unless dryRun is set");
  }

  const tenantIds = await resolveTenantIds(db, tenantId);

  const summary = {
    dryRun,
    format,
    compression,
    tenants_scanned: tenantIds.length,
    tenants_exported: 0,
    events_exported: 0,
    objects_written: 0,
    details: []
  };

  for (const tid of tenantIds) {
    const events = await db.getEventsForQuery(tid, { since, until });
    const key = buildObjectKey({ tenantId: tid, now, format, compression, prefix });

    if (events.length === 0) {
      summary.details.push({ tenant_id: tid, events: 0, key: null, location: null, bytes: null, skipped: true });
      continue;
    }

    summary.events_exported += events.length;
    summary.tenants_exported += 1;

    if (dryRun) {
      summary.details.push({ tenant_id: tid, events: events.length, key, location: null, bytes: null });
      logger.info(
        { tenant_id: tid, events: events.length, key, format, compression, since, until, dry_run: true },
        "export: would write events"
      );
      continue;
    }

    const { bytes, location } = await writeRecords({ records: events, format, compression, sink, key });
    summary.objects_written += 1;
    summary.details.push({ tenant_id: tid, events: events.length, key, location, bytes });
    logger.info(
      { tenant_id: tid, events: events.length, key, location, bytes, format, compression, since, until },
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
  resolveTenantIds,
  runExport
};
