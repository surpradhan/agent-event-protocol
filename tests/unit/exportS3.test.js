"use strict";

/**
 * Unit tests for the Phase 17 PR-B S3 export sink (no network, no AWS SDK call).
 *   - S3Sink streams the body to an injected uploader and reports an s3:// location
 *   - S3Sink honors a custom (S3-compatible) endpoint in the reported location
 *   - createSink factory: local | s3 | unknown
 *   - writeRecords drives the full pipeline into a fake S3 uploader (gzip round-trip)
 *   - CLI resolveSinkConfig / destinationLabel: flag + env fallbacks, no creds
 */

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const { S3Sink } = require("../../src/export/s3sink");
const { createSink, LocalFileSink } = require("../../src/export/sink");
const { writeRecords } = require("../../src/export/index");
const { resolveSinkConfig, destinationLabel } = require("../../src/export");

/**
 * A fake uploader factory matching the @aws-sdk/lib-storage Upload shape: it
 * records the params and drains the Body stream into a Buffer.
 */
function fakeUploaderFactory() {
  const calls = [];
  const createUpload = (params) => ({
    async done() {
      const chunks = [];
      for await (const chunk of params.Body) chunks.push(chunk);
      calls.push({
        Bucket: params.Bucket,
        Key: params.Key,
        body: Buffer.concat(chunks)
      });
      return { ETag: "fake-etag" };
    }
  });
  return { calls, createUpload };
}

describe("S3Sink", () => {
  test("requires a bucket", () => {
    assert.throws(() => new S3Sink({}), /requires a \{ bucket \}/);
    assert.throws(() => new S3Sink(), /requires a \{ bucket \}/);
  });

  test("streams the body to the injected uploader and reports s3:// location", async () => {
    const { calls, createUpload } = fakeUploaderFactory();
    const sink = new S3Sink({ bucket: "my-bucket", createUpload });
    const { Readable } = require("node:stream");
    const { location } = await sink.write("dev/events.jsonl.gz", Readable.from([Buffer.from("hello world")]));
    assert.equal(location, "s3://my-bucket/dev/events.jsonl.gz");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].Bucket, "my-bucket");
    assert.equal(calls[0].Key, "dev/events.jsonl.gz");
    assert.equal(calls[0].body.toString("utf8"), "hello world");
  });

  test("custom endpoint is reflected in the reported location", async () => {
    const { createUpload } = fakeUploaderFactory();
    const sink = new S3Sink({ bucket: "b", endpoint: "https://minio.local:9000/", createUpload });
    const { Readable } = require("node:stream");
    const { location } = await sink.write("k.txt", Readable.from([Buffer.from("x")]));
    assert.equal(location, "https://minio.local:9000/b/k.txt");
  });

  test("does not accept or retain credentials", () => {
    // Credentials must come from the AWS chain, never the constructor.
    const sink = new S3Sink({ bucket: "b", region: "us-east-1" });
    assert.equal(sink.region, "us-east-1");
    assert.ok(!("accessKeyId" in sink));
    assert.ok(!("secretAccessKey" in sink));
    assert.ok(!("credentials" in sink));
  });
});

describe("createSink factory", () => {
  test("local by default", () => {
    assert.ok(createSink() instanceof LocalFileSink);
    assert.ok(createSink({ kind: "local", dir: "/tmp/x" }) instanceof LocalFileSink);
  });

  test("s3 when selected", () => {
    const sink = createSink({ kind: "s3", bucket: "b", region: "eu-west-1" });
    assert.ok(sink instanceof S3Sink);
    assert.equal(sink.bucket, "b");
    assert.equal(sink.region, "eu-west-1");
  });

  test("s3 without a bucket throws", () => {
    assert.throws(() => createSink({ kind: "s3" }), /requires a \{ bucket \}/);
  });

  test("unknown sink kind throws", () => {
    assert.throws(() => createSink({ kind: "gcs" }), /Unknown export sink/);
  });
});

describe("writeRecords → S3 (fake uploader)", () => {
  test("gzipped JSONL reaches the uploader and round-trips", async () => {
    const { calls, createUpload } = fakeUploaderFactory();
    const sink = new S3Sink({ bucket: "archive", createUpload });
    const events = [
      { id: "e1", type: "task.created" },
      { id: "e2", type: "task.completed" }
    ];
    const { bytes, location } = await writeRecords({
      records: events,
      format: "jsonl",
      compression: "gzip",
      sink,
      key: "t/e.jsonl.gz"
    });
    assert.equal(location, "s3://archive/t/e.jsonl.gz");
    assert.equal(calls.length, 1);
    assert.equal(bytes, calls[0].body.length);
    const text = zlib.gunzipSync(calls[0].body).toString("utf8");
    assert.deepEqual(
      text.trim().split("\n").map((l) => JSON.parse(l)),
      events
    );
  });
});

describe("CLI resolveSinkConfig / destinationLabel", () => {
  const ENV_KEYS = ["EXPORT_SINK", "EXPORT_S3_BUCKET", "EXPORT_S3_REGION", "EXPORT_S3_ENDPOINT", "AWS_REGION"];
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const baseOpts = {
    out: "./exports",
    sink: null,
    bucket: null,
    region: null,
    endpoint: null
  };

  test("defaults to local sink", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const cfg = resolveSinkConfig({ ...baseOpts });
    assert.equal(cfg.kind, "local");
    assert.ok(cfg.dir.endsWith("exports"));
    assert.equal(destinationLabel(cfg), cfg.dir);
  });

  test("flags select s3 and win over env", () => {
    process.env.EXPORT_SINK = "local";
    process.env.EXPORT_S3_BUCKET = "env-bucket";
    const cfg = resolveSinkConfig({ ...baseOpts, sink: "s3", bucket: "flag-bucket", region: "ap-south-1" });
    assert.equal(cfg.kind, "s3");
    assert.equal(cfg.bucket, "flag-bucket");
    assert.equal(cfg.region, "ap-south-1");
    assert.equal(destinationLabel(cfg), "s3://flag-bucket");
  });

  test("env fallbacks fill in when flags absent", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.EXPORT_SINK = "s3";
    process.env.EXPORT_S3_BUCKET = "env-bucket";
    process.env.AWS_REGION = "us-west-2";
    const cfg = resolveSinkConfig({ ...baseOpts });
    assert.equal(cfg.kind, "s3");
    assert.equal(cfg.bucket, "env-bucket");
    assert.equal(cfg.region, "us-west-2");
  });

  test("endpoint is reflected in the destination label", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const cfg = resolveSinkConfig({ ...baseOpts, sink: "s3", bucket: "b", endpoint: "https://minio.local:9000" });
    assert.equal(destinationLabel(cfg), "https://minio.local:9000/b");
  });
});
