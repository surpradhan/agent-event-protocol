"use strict";

/**
 * src/export/formats.js — record encoders + compressors for export
 * (Phase 17 PR-A, PR-C)
 *
 * `createEncoder(format)` returns an object-mode Transform that turns event
 * envelopes into encoded bytes; `createCompressor(compression)` returns a byte
 * Transform (or null for no compression).  `formatExtension` /
 * `compressionExtension` are the matching pure lookups, used to build object
 * keys without constructing a throwaway stream (and to validate up front, so
 * even `--dry-run` rejects an unknown format/compression).
 *
 * Formats (PR-A + PR-C):
 *   • jsonl   — JSON Lines / NDJSON (one envelope per line)            [streaming]
 *   • csv     — RFC-4180 with a fixed envelope column set; nested
 *               objects (payload/labels/extensions/signature) as JSON  [streaming]
 *   • parquet — Apache Parquet columnar (src/export/parquet.js, lazily
 *               loaded); SELF-COMPRESSED (internal per-column GZIP), so
 *               the external `--compression` layer does NOT apply to it.
 *
 * Compression (PR-A + PR-C): none | gzip | brotli.  These wrap the *text*
 * formats (jsonl, csv); a self-compressed format (parquet) ignores them.
 */

const zlib = require("zlib");
const { Transform } = require("stream");

const FORMAT_EXTENSIONS = { jsonl: "jsonl", csv: "csv", parquet: "parquet" };
const COMPRESSION_EXTENSIONS = { none: "", gzip: ".gz", brotli: ".br" };

// Formats that carry their own internal compression; the external compression
// layer (and its filename extension) does not apply to them.
const SELF_COMPRESSED_FORMATS = new Set(["parquet"]);

const SUPPORTED_FORMATS = Object.keys(FORMAT_EXTENSIONS);
const SUPPORTED_COMPRESSIONS = Object.keys(COMPRESSION_EXTENSIONS);

// CSV column order: the event envelope's top-level fields.  Object-valued
// fields are serialised as JSON strings in their cell (see csvEncoder).
const CSV_COLUMNS = [
  "specversion", "id", "time", "source", "type", "session_id", "trace_id",
  "parent_session_id", "agent_role", "subject", "causation_id", "idempotency_key",
  "schema", "tenant", "labels", "extensions", "signature", "payload"
];
const CSV_OBJECT_COLUMNS = new Set(["labels", "extensions", "signature", "payload"]);

/**
 * Whether a format manages its own compression internally (so the external
 * compressor + its extension are skipped).
 * @param {string} format
 * @returns {boolean}
 */
function isSelfCompressed(format) {
  return SELF_COMPRESSED_FORMATS.has(format);
}

/**
 * Filename extension for a format (no leading dot), throwing on an unknown one.
 * @param {string} format
 * @returns {string}
 */
function formatExtension(format) {
  if (!Object.prototype.hasOwnProperty.call(FORMAT_EXTENSIONS, format)) {
    throw new Error(
      `Unsupported export format: '${format}' (supported: ${SUPPORTED_FORMATS.join(", ")})`
    );
  }
  return FORMAT_EXTENSIONS[format];
}

/**
 * Filename extension for a compression (leading dot or ""), throwing on unknown.
 * @param {string} compression
 * @returns {string}
 */
function compressionExtension(compression) {
  if (!Object.prototype.hasOwnProperty.call(COMPRESSION_EXTENSIONS, compression)) {
    throw new Error(
      `Unsupported compression: '${compression}' (supported: ${SUPPORTED_COMPRESSIONS.join(", ")})`
    );
  }
  return COMPRESSION_EXTENSIONS[compression];
}

/**
 * Object-mode Transform that serialises each event envelope to one line of JSON
 * terminated by "\n" (JSON Lines / NDJSON).
 * @returns {import('stream').Transform}
 */
function jsonlEncoder() {
  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(record, _enc, cb) {
      try {
        cb(null, Buffer.from(JSON.stringify(record) + "\n"));
      } catch (err) {
        cb(err);
      }
    }
  });
}

/**
 * RFC-4180 encode one cell: stringify, and quote (doubling internal quotes) when
 * the value contains a comma, quote, CR or LF.
 * @param {string} value
 * @returns {string}
 */
function csvCell(value) {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Render an envelope field to its CSV cell value: object-valued columns become
 * JSON strings; missing values become "".
 * @param {object} record
 * @param {string} col
 * @returns {string}
 */
function csvValue(record, col) {
  const v = record[col];
  if (v === undefined || v === null) return "";
  if (CSV_OBJECT_COLUMNS.has(col)) return JSON.stringify(v);
  return String(v);
}

/**
 * Object-mode Transform that serialises envelopes to RFC-4180 CSV with a leading
 * header row (written once, before the first record).
 * @returns {import('stream').Transform}
 */
function csvEncoder() {
  let headerWritten = false;
  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(record, _enc, cb) {
      try {
        let out = "";
        if (!headerWritten) {
          out += CSV_COLUMNS.map(csvCell).join(",") + "\r\n";
          headerWritten = true;
        }
        out += CSV_COLUMNS.map((col) => csvCell(csvValue(record, col))).join(",") + "\r\n";
        cb(null, Buffer.from(out));
      } catch (err) {
        cb(err);
      }
    }
  });
}

/**
 * Return the encoder Transform + filename extension for a *streaming text*
 * format (jsonl, csv).  Parquet is not a per-record Transform — it is written by
 * src/export/parquet.js — so requesting it here throws.
 * @param {string} format  one of SUPPORTED_FORMATS
 * @returns {{ stream: import('stream').Transform, extension: string }}
 */
function createEncoder(format) {
  const extension = formatExtension(format);
  switch (format) {
    case "jsonl":
      return { stream: jsonlEncoder(), extension };
    case "csv":
      return { stream: csvEncoder(), extension };
    default:
      // parquet (or any self-compressed/columnar format) has no streaming encoder.
      throw new Error(`Format '${format}' has no streaming encoder (handled separately)`);
  }
}

/**
 * Return the compressor Transform (or null for "none") + filename extension.
 * @param {string} compression  one of SUPPORTED_COMPRESSIONS
 * @returns {{ stream: import('stream').Transform|null, extension: string }}
 */
function createCompressor(compression) {
  const extension = compressionExtension(compression);
  switch (compression) {
    case "none":
      return { stream: null, extension };
    case "gzip":
      return { stream: zlib.createGzip(), extension };
    case "brotli":
      return { stream: zlib.createBrotliCompress(), extension };
    /* istanbul ignore next — compressionExtension already rejected unknown ones */
    default:
      throw new Error(`Unsupported compression: '${compression}'`);
  }
}

module.exports = {
  SUPPORTED_FORMATS,
  SUPPORTED_COMPRESSIONS,
  SELF_COMPRESSED_FORMATS,
  CSV_COLUMNS,
  isSelfCompressed,
  formatExtension,
  compressionExtension,
  createEncoder,
  createCompressor
};
