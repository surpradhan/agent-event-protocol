"use strict";

/**
 * Unit tests for the Phase 17 PR-A export module (no server / network).
 *   - formats: encoder + compressor factories and pure extension lookups
 *   - sink: LocalFileSink round-trips bytes and refuses path traversal
 *   - writeRecords: records → JSONL → (gzip) → sink, with byte counting
 *   - buildObjectKey / slugifyTenant: stable, safe keys
 *   - runExport: tenant resolution, dry-run, empty-tenant skip (fake db)
 *   - parseArgs: the src/export.js CLI parser
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  SUPPORTED_FORMATS,
  SUPPORTED_COMPRESSIONS,
  formatExtension,
  compressionExtension,
  createEncoder,
  createCompressor
} = require("../../src/export/formats");
const { ExportSink, LocalFileSink } = require("../../src/export/sink");
const {
  slugifyTenant,
  buildObjectKey,
  writeRecords,
  resolveTenantIds,
  runExport
} = require("../../src/export/index");
const { parseArgs } = require("../../src/export");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aep-export-test-"));
}

const SAMPLE_EVENTS = [
  { id: "evt_1", type: "task.created", time: "2026-01-01T00:00:00.000Z", payload: { a: 1 } },
  { id: "evt_2", type: "tool.called", time: "2026-01-02T00:00:00.000Z", payload: { b: "two" } },
  { id: "evt_3", type: "task.completed", time: "2026-01-03T00:00:00.000Z", payload: {} }
];

describe("formats: extensions", () => {
  test("supported lists are exposed", () => {
    assert.deepEqual(SUPPORTED_FORMATS, ["jsonl"]);
    assert.deepEqual(SUPPORTED_COMPRESSIONS, ["none", "gzip"]);
  });

  test("formatExtension returns the suffix and throws on unknown", () => {
    assert.equal(formatExtension("jsonl"), "jsonl");
    assert.throws(() => formatExtension("parquet"), /Unsupported export format/);
  });

  test("compressionExtension returns the suffix and throws on unknown", () => {
    assert.equal(compressionExtension("none"), "");
    assert.equal(compressionExtension("gzip"), ".gz");
    assert.throws(() => compressionExtension("brotli"), /Unsupported compression/);
  });
});

describe("formats: factories", () => {
  test("createEncoder(jsonl) emits one JSON line per record", async () => {
    const { stream, extension } = createEncoder("jsonl");
    assert.equal(extension, "jsonl");
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    const done = new Promise((res) => stream.on("end", res));
    stream.write({ x: 1 });
    stream.write({ y: 2 });
    stream.end();
    await done;
    const text = Buffer.concat(chunks).toString("utf8");
    assert.equal(text, '{"x":1}\n{"y":2}\n');
  });

  test("createCompressor(none) returns null stream", () => {
    const { stream, extension } = createCompressor("none");
    assert.equal(stream, null);
    assert.equal(extension, "");
  });

  test("createCompressor(gzip) returns a working gzip stream", () => {
    const { stream, extension } = createCompressor("gzip");
    assert.equal(extension, ".gz");
    assert.ok(typeof stream.pipe === "function");
  });
});

describe("LocalFileSink", () => {
  test("constructor requires a dir", () => {
    assert.throws(() => new LocalFileSink({}), /requires a \{ dir \}/);
    assert.throws(() => new LocalFileSink(), /requires a \{ dir \}/);
  });

  test("base ExportSink.write throws (abstract)", async () => {
    await assert.rejects(() => new ExportSink().write("k", null), /not implemented/);
  });

  test("writes a nested key and reports its location", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const { Readable } = require("node:stream");
    const { location } = await sink.write("a/b/c.txt", Readable.from(["hello"]));
    assert.equal(location, path.join(dir, "a/b/c.txt"));
    assert.equal(fs.readFileSync(location, "utf8"), "hello");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a key that escapes the base directory", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const { Readable } = require("node:stream");
    await assert.rejects(
      () => sink.write("../escape.txt", Readable.from(["x"])),
      /escapes the sink directory/
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeRecords (streaming core)", () => {
  test("writes uncompressed JSONL and counts bytes", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const { bytes, location } = await writeRecords({
      records: SAMPLE_EVENTS,
      format: "jsonl",
      compression: "none",
      sink,
      key: "events.jsonl"
    });
    const raw = fs.readFileSync(location);
    assert.equal(bytes, raw.length);
    const lines = raw.toString("utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[0]), SAMPLE_EVENTS[0]);
    assert.deepEqual(JSON.parse(lines[2]), SAMPLE_EVENTS[2]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("gzip output round-trips and byte count is the compressed size", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const { bytes, location } = await writeRecords({
      records: SAMPLE_EVENTS,
      format: "jsonl",
      compression: "gzip",
      sink,
      key: "events.jsonl.gz"
    });
    const raw = fs.readFileSync(location);
    assert.equal(bytes, raw.length);
    const text = zlib.gunzipSync(raw).toString("utf8");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[1]), SAMPLE_EVENTS[1]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("requires sink and key", async () => {
    await assert.rejects(() => writeRecords({ records: [], key: "k" }), /requires a sink/);
    const dir = tmpDir();
    await assert.rejects(
      () => writeRecords({ records: [], sink: new LocalFileSink({ dir }) }),
      /requires a key/
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("slugifyTenant / buildObjectKey", () => {
  test("slugify makes filesystem-safe tokens", () => {
    assert.equal(slugifyTenant("dev"), "dev");
    assert.equal(slugifyTenant("acme/prod team"), "acme_prod_team");
    assert.equal(slugifyTenant(""), "unknown");
    assert.equal(slugifyTenant(null), "unknown");
    assert.equal(slugifyTenant("///"), "unknown");
  });

  test("buildObjectKey is stable for a fixed clock and includes ext", () => {
    const now = Date.parse("2026-06-14T10:15:30.123Z");
    const key = buildObjectKey({ tenantId: "dev", now, format: "jsonl", compression: "gzip" });
    assert.equal(key, "dev/aep-events-dev-20260614T101530Z.jsonl.gz");
  });

  test("buildObjectKey honors prefix and 'none' compression", () => {
    const now = Date.parse("2026-06-14T10:15:30.000Z");
    const key = buildObjectKey({
      tenantId: "dev",
      now,
      format: "jsonl",
      compression: "none",
      prefix: "/archive/"
    });
    assert.equal(key, "archive/dev/aep-events-dev-20260614T101530Z.jsonl");
  });

  test("buildObjectKey rejects an unknown format", () => {
    assert.throws(() => buildObjectKey({ tenantId: "dev", format: "csv" }), /Unsupported export format/);
  });
});

// ---- runExport with an injected fake db -----------------------------------

function fakeDb({ projects = [], eventsByTenant = {} } = {}) {
  return {
    async listProjects() {
      return projects;
    },
    async getEventsForQuery(tenantId, _opts) {
      return eventsByTenant[tenantId] || [];
    }
  };
}

describe("runExport", () => {
  test("dry-run reports per-tenant counts and keys without writing", async () => {
    const db = fakeDb({
      projects: [{ tenant_id: "t1" }, { tenant_id: "t2" }],
      eventsByTenant: { t1: SAMPLE_EVENTS, t2: [] }
    });
    const now = Date.parse("2026-06-14T10:15:30.000Z");
    const summary = await runExport({ db, dryRun: true, now });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.tenants_scanned, 2);
    assert.equal(summary.tenants_exported, 1);
    assert.equal(summary.events_exported, 3);
    assert.equal(summary.objects_written, 0);
    const t1 = summary.details.find((d) => d.tenant_id === "t1");
    assert.equal(t1.events, 3);
    assert.equal(t1.key, "t1/aep-events-t1-20260614T101530Z.jsonl.gz");
    assert.equal(t1.location, null);
    const t2 = summary.details.find((d) => d.tenant_id === "t2");
    assert.equal(t2.skipped, true);
    assert.equal(t2.events, 0);
  });

  test("real run writes one gzipped object per non-empty tenant", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const db = fakeDb({
      projects: [{ tenant_id: "t1" }, { tenant_id: "empty" }],
      eventsByTenant: { t1: SAMPLE_EVENTS }
    });
    const summary = await runExport({ db, sink, now: Date.parse("2026-06-14T10:15:30.000Z") });
    assert.equal(summary.objects_written, 1);
    assert.equal(summary.events_exported, 3);
    const t1 = summary.details.find((d) => d.tenant_id === "t1");
    const text = zlib.gunzipSync(fs.readFileSync(t1.location)).toString("utf8");
    assert.equal(text.trim().split("\n").length, 3);
    assert.equal(t1.bytes, fs.readFileSync(t1.location).length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("scopes to a single tenant when tenantId is given", async () => {
    const db = fakeDb({
      projects: [{ tenant_id: "t1" }, { tenant_id: "t2" }],
      eventsByTenant: { t1: SAMPLE_EVENTS, t2: SAMPLE_EVENTS }
    });
    const summary = await runExport({ db, tenantId: "t2", dryRun: true });
    assert.equal(summary.tenants_scanned, 1);
    assert.deepEqual(summary.details.map((d) => d.tenant_id), ["t2"]);
  });

  test("validates format/compression even in dry-run", async () => {
    const db = fakeDb({ projects: [{ tenant_id: "t1" }] });
    await assert.rejects(() => runExport({ db, dryRun: true, format: "csv" }), /Unsupported export format/);
    await assert.rejects(
      () => runExport({ db, dryRun: true, compression: "brotli" }),
      /Unsupported compression/
    );
  });

  test("requires a sink for a real (non-dry-run) export", async () => {
    const db = fakeDb({ projects: [{ tenant_id: "t1" }] });
    await assert.rejects(() => runExport({ db, dryRun: false }), /requires a sink/);
  });

  test("resolveTenantIds dedupes project tenants", async () => {
    const db = fakeDb({ projects: [{ tenant_id: "a" }, { tenant_id: "a" }, { tenant_id: "b" }] });
    const ids = await resolveTenantIds(db, null);
    assert.deepEqual(ids.sort(), ["a", "b"]);
    assert.deepEqual(await resolveTenantIds(db, "x"), ["x"]);
  });
});

describe("export CLI parseArgs", () => {
  const base = ["node", "src/export.js"];

  test("defaults", () => {
    const o = parseArgs(base);
    assert.equal(o.tenantId, null);
    assert.equal(o.out, "./exports");
    assert.equal(o.format, "jsonl");
    assert.equal(o.compression, "gzip");
    assert.equal(o.dryRun, false);
    assert.equal(o.json, false);
  });

  test("space-separated flags", () => {
    const o = parseArgs([...base, "--tenant", "dev", "--out", "/data", "--since", "2026-01-01T00:00:00Z"]);
    assert.equal(o.tenantId, "dev");
    assert.equal(o.out, "/data");
    assert.equal(o.since, "2026-01-01T00:00:00Z");
  });

  test("--flag=value form", () => {
    const o = parseArgs([...base, "--tenant=acme", "--compression=none", "--prefix=cold"]);
    assert.equal(o.tenantId, "acme");
    assert.equal(o.compression, "none");
    assert.equal(o.prefix, "cold");
  });

  test("boolean flags", () => {
    const o = parseArgs([...base, "--dry-run", "--json"]);
    assert.equal(o.dryRun, true);
    assert.equal(o.json, true);
    assert.equal(parseArgs([...base, "-h"]).help, true);
    assert.equal(parseArgs([...base, "--help"]).help, true);
  });
});
