"use strict";

/**
 * src/export/s3sink.js — Amazon S3 export sink (Phase 17 PR-B)
 *
 * Streams an export object to S3 behind the same `ExportSink` contract as the
 * local sink, using the AWS SDK v3 multipart uploader (`@aws-sdk/lib-storage`'s
 * `Upload`), so an arbitrarily large object streams up without buffering in
 * memory.
 *
 * This is the first cloud egress path for AEP, so it follows the same posture as
 * the webhook delivery engine:
 *   • OFF by default — the CLI only constructs an S3 sink when `--sink s3`
 *     (or `EXPORT_SINK=s3`) is explicitly selected.
 *   • Credentials are NEVER accepted as parameters and never logged — the S3
 *     client resolves them from the standard AWS credential chain (env vars,
 *     shared config, SSO, container/instance roles).
 *   • The heavy AWS SDK is `require`d lazily (only when an S3 sink is actually
 *     used), so importing the export core stays cheap for the local path.
 *
 * Testability: the uploader is injectable (`createUpload`), so unit tests drive
 * the full encode→compress→sink pipeline against a fake uploader with no network
 * and no AWS SDK.
 *
 * GCS / Azure Blob sinks (also named in the PRD) are deliberately out of scope
 * for this slice; they slot in as sibling sinks behind the same interface.
 */

const { URL } = require("url");

const { ExportSink } = require("./sink");
const { targetOf, withTarget } = require("../errors");

/**
 * S3 export sink.
 *
 * @param {{
 *   bucket: string,
 *   region?: string,
 *   endpoint?: string,            // S3-compatible endpoint (forces path-style)
 *   client?: object,              // injected S3Client (tests); else lazily built
 *   createUpload?: (params: object) => { done: () => Promise<any> } // injected (tests)
 * }} opts
 */
class S3Sink extends ExportSink {
  constructor({ bucket, region, endpoint, client, createUpload } = {}) {
    super();
    if (!bucket || typeof bucket !== "string") {
      throw new Error("S3Sink requires a { bucket } string");
    }
    this.bucket = bucket;
    this.region = region || null;
    this.endpoint = endpoint || null;
    this._client = client || null;
    this._createUpload = createUpload || null;
  }

  /**
   * Lazily construct the S3 client + uploader factory the first time they are
   * needed.  Credentials are intentionally NOT set here — the S3Client resolves
   * them from the default AWS credential chain.
   */
  _ensureDeps() {
    if (!this._client) {
      const { S3Client } = require("@aws-sdk/client-s3");
      const cfg = {};
      if (this.region) cfg.region = this.region;
      if (this.endpoint) {
        cfg.endpoint = this.endpoint;
        cfg.forcePathStyle = true; // S3-compatible stores (MinIO, etc.)
      }
      this._client = new S3Client(cfg);
    }
    if (!this._createUpload) {
      const { Upload } = require("@aws-sdk/lib-storage");
      this._createUpload = (params) => new Upload({ client: this._client, params });
    }
  }

  /**
   * Human-readable location for the written object.
   * @param {string} key
   * @returns {string}
   */
  _location(key) {
    if (this.endpoint) {
      return `${this.endpoint.replace(/\/+$/, "")}/${this.bucket}/${key}`;
    }
    return `s3://${this.bucket}/${key}`;
  }

  /**
   * Credential-free name for what an upload dials, for error messages (issue
   * #186): the custom endpoint's origin when one is set, else the bucket —
   * with the region when known, since a dial failure's message drops the
   * region-derived AWS hostname (see errors.js TERSE_ERROR_CODES).
   * @returns {string}
   */
  _target() {
    if (this.endpoint) {
      try {
        return targetOf(new URL(this.endpoint));
      } catch (_) { /* not URL-shaped; fall through to the bucket form */ }
    }
    return this.region ? `s3://${this.bucket} (${this.region})` : `s3://${this.bucket}`;
  }

  async write(key, stream) {
    this._ensureDeps();
    const upload = this._createUpload({ Bucket: this.bucket, Key: key, Body: stream });
    try {
      await upload.done();
    } catch (err) {
      // An unreachable endpoint gets the "could not reach <target>" line —
      // which also collapses happy-eyeballs' per-address dial attempts. A
      // service reply (AccessDenied, NoSuchBucket, …) means S3 WAS reached:
      // withTarget passes it through with its own, more accurate message.
      throw withTarget(err, this._target());
    }
    return { location: this._location(key) };
  }
}

module.exports = { S3Sink };
