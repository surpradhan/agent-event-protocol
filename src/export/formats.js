"use strict";

/**
 * src/export/formats.js — record encoders + compressors for export (Phase 17 PR-A)
 *
 * `createEncoder(format)` returns an object-mode Transform that turns event
 * envelopes into encoded bytes; `createCompressor(compression)` returns a byte
 * Transform (or null for no compression).  `formatExtension` /
 * `compressionExtension` are the matching pure lookups, used to build object
 * keys without constructing a throwaway stream (and to validate up front, so
 * even `--dry-run` rejects an unknown format/compression).
 *
 * PR-A ships JSON Lines + gzip (and an explicit "none" compressor).  Parquet,
 * CSV and brotli are added in PR-C behind these same factories, so the export
 * orchestrator and CLI never need to special-case a format.
 */

const zlib = require("zlib");
const { Transform } = require("stream");

const FORMAT_EXTENSIONS = { jsonl: "jsonl" };
const COMPRESSION_EXTENSIONS = { none: "", gzip: ".gz" };

const SUPPORTED_FORMATS = Object.keys(FORMAT_EXTENSIONS);
const SUPPORTED_COMPRESSIONS = Object.keys(COMPRESSION_EXTENSIONS);

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
 * Return the encoder Transform + filename extension for a format.
 * @param {string} format  one of SUPPORTED_FORMATS
 * @returns {{ stream: import('stream').Transform, extension: string }}
 */
function createEncoder(format) {
  const extension = formatExtension(format);
  switch (format) {
    case "jsonl":
      return { stream: jsonlEncoder(), extension };
    /* istanbul ignore next — formatExtension already rejected unknown formats */
    default:
      throw new Error(`Unsupported export format: '${format}'`);
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
    /* istanbul ignore next — compressionExtension already rejected unknown ones */
    default:
      throw new Error(`Unsupported compression: '${compression}'`);
  }
}

module.exports = {
  SUPPORTED_FORMATS,
  SUPPORTED_COMPRESSIONS,
  formatExtension,
  compressionExtension,
  createEncoder,
  createCompressor
};
