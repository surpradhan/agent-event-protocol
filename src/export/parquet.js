"use strict";

/**
 * src/export/parquet.js — Apache Parquet event encoder (Phase 17 PR-C)
 *
 * Writes a tenant's events as a single Parquet file via @dsnp/parquetjs.  Unlike
 * the JSONL / CSV encoders, Parquet is a binary *columnar* format: it buffers
 * row groups and writes a footer, so it cannot be a per-record stream Transform.
 * It is instead written here, behind the same `writeRecords` entry point, with
 * the heavy parquet library `require`d LAZILY (only when parquet is requested) —
 * mirroring how the S3 sink isolates the AWS SDK.
 *
 * Schema: the event envelope's top-level fields as UTF8 columns (`id` required,
 * the rest optional); object-valued fields (payload / labels / extensions /
 * signature) are stored as JSON strings.  Every column uses Parquet's internal
 * GZIP codec, so a Parquet export is SELF-COMPRESSED and the external
 * `--compression` layer does not apply (see formats.isSelfCompressed).
 */

const { Transform } = require("stream");

const SCALAR_COLUMNS = [
  "specversion", "id", "time", "source", "type", "session_id", "trace_id",
  "parent_session_id", "agent_role", "subject", "causation_id", "idempotency_key",
  "schema", "tenant"
];
const OBJECT_COLUMNS = ["labels", "extensions", "signature", "payload"];

/**
 * Build the Parquet schema (lazily requires @dsnp/parquetjs).
 * @returns {object} ParquetSchema
 */
function buildSchema() {
  const parquet = require("@dsnp/parquetjs");
  const fields = {};
  for (const col of SCALAR_COLUMNS) {
    // `id` is always present; the rest are optional envelope fields.
    fields[col] = { type: "UTF8", compression: "GZIP", optional: col !== "id" };
  }
  for (const col of OBJECT_COLUMNS) {
    fields[col] = { type: "UTF8", compression: "GZIP", optional: true };
  }
  return new parquet.ParquetSchema(fields);
}

/**
 * Map an event envelope to a Parquet row matching buildSchema().  Scalars are
 * stringified; object columns become JSON strings; missing optional fields are
 * omitted.
 * @param {object} event
 * @returns {object}
 */
function eventToRow(event) {
  // `id` is the one required (non-optional) column in the schema — fail loudly
  // rather than writing a literal "undefined"/"null" cell.
  if (event.id === undefined || event.id === null) {
    throw new Error("parquet export: event is missing required 'id'");
  }
  const row = {};
  for (const col of SCALAR_COLUMNS) {
    if (event[col] !== undefined && event[col] !== null) row[col] = String(event[col]);
  }
  for (const col of OBJECT_COLUMNS) {
    if (event[col] !== undefined && event[col] !== null) row[col] = JSON.stringify(event[col]);
  }
  return row;
}

/**
 * Write `records` as a Parquet object to `sink` under `key`.  Counts the written
 * bytes via a pass-through Transform while the sink drains it, exactly like the
 * streaming-text path in index.js.  `compression` is intentionally ignored —
 * Parquet compresses internally.
 *
 * @param {{ records: Iterable<object>, sink: import('./sink').ExportSink, key: string }} opts
 * @returns {Promise<{ bytes: number, location: string }>}
 */
async function writeParquet({ records, sink, key }) {
  const parquet = require("@dsnp/parquetjs");
  const schema = buildSchema();

  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    }
  });

  // The parquet writer produces bytes into `counter` (its writable side) while
  // the sink drains `counter` (its readable side); run both concurrently so
  // either side erroring tears down the shared stream and rejects the other.
  const produce = (async () => {
    const writer = await parquet.ParquetWriter.openStream(schema, counter);
    for (const event of records) {
      await writer.appendRow(eventToRow(event));
    }
    await writer.close(); // writes the footer and ends `counter`
  })();

  const [, sinkResult] = await Promise.all([produce, sink.write(key, counter)]);
  return { bytes, location: sinkResult.location };
}

module.exports = { buildSchema, eventToRow, writeParquet };
