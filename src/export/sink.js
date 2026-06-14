"use strict";

/**
 * src/export/sink.js — pluggable export sink interface + local-filesystem sink
 * (Phase 17 PR-A)
 *
 * An ExportSink writes a single named object (`key`) by consuming a Readable
 * byte stream.  This single-method contract is deliberately minimal so cloud
 * sinks (S3 in PR-B, GCS/Azure as follow-ups) drop in behind it without the
 * export orchestrator changing: each just streams `stream` to its destination.
 *
 * The local-filesystem sink (`LocalFileSink`) needs no cloud dependency, so it
 * is the default and keeps the whole export path testable offline.
 */

const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

/**
 * Abstract export destination.  Concrete sinks override `write`.
 */
class ExportSink {
  /**
   * Write one object identified by `key`, consuming `stream` (a Readable of
   * the already-encoded, already-compressed bytes).
   *
   * @param {string} key            object key / relative path (sink-namespaced)
   * @param {import('stream').Readable} stream  byte stream to persist
   * @returns {Promise<{ location: string }>}  where the object landed
   */
  async write(key, stream) {  // eslint-disable-line no-unused-vars
    throw new Error("ExportSink.write() not implemented");
  }
}

/**
 * Local-filesystem sink: writes each object as a file under a base directory.
 * Object keys may contain `/` (they become nested directories), but a key that
 * would escape the base directory is rejected (path-traversal guard).
 */
class LocalFileSink extends ExportSink {
  /**
   * @param {{ dir: string }} opts  base directory for written objects
   */
  constructor({ dir } = {}) {
    super();
    if (!dir || typeof dir !== "string") {
      throw new Error("LocalFileSink requires a { dir } string");
    }
    this.dir = dir;
    this._resolvedDir = path.resolve(dir);
  }

  /**
   * Resolve `key` to an absolute path inside the base directory, rejecting any
   * key that escapes it (e.g. "../etc/passwd").
   * @param {string} key
   * @returns {string} absolute destination path
   */
  _resolveKey(key) {
    const dest = path.resolve(this._resolvedDir, key);
    if (dest !== this._resolvedDir && !dest.startsWith(this._resolvedDir + path.sep)) {
      throw new Error(`LocalFileSink: key '${key}' escapes the sink directory`);
    }
    return dest;
  }

  async write(key, stream) {
    const dest = this._resolveKey(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await pipeline(stream, fs.createWriteStream(dest));
    return { location: dest };
  }
}

const SUPPORTED_SINKS = ["local", "s3"];

/**
 * Construct an ExportSink from a resolved config (shared by the export CLI and,
 * later, the retention export-before-prune path).  S3 is OFF unless explicitly
 * selected — `kind` defaults to "local".  The S3 sink module (and its AWS SDK
 * dependency) is required lazily so the local path never loads it.
 *
 * @param {{ kind?: string, dir?: string, bucket?: string, region?: string,
 *           endpoint?: string }} [config]
 * @returns {ExportSink}
 */
function createSink(config = {}) {
  const kind = String(config.kind || "local").toLowerCase();
  switch (kind) {
    case "local":
      return new LocalFileSink({ dir: config.dir || "./exports" });
    case "s3": {
      const { S3Sink } = require("./s3sink");
      return new S3Sink({
        bucket: config.bucket,
        region: config.region,
        endpoint: config.endpoint
      });
    }
    default:
      throw new Error(`Unknown export sink: '${kind}' (supported: ${SUPPORTED_SINKS.join(", ")})`);
  }
}

module.exports = { ExportSink, LocalFileSink, SUPPORTED_SINKS, createSink };
