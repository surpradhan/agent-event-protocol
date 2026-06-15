"use strict";

/**
 * Unit tests for the Phase 17 PR-C format + compression options.
 *   - csv encoder: header row, RFC-4180 quoting, nested-object-as-JSON cells
 *   - brotli compressor: round-trips through writeRecords
 *   - parquet: writeRecords writes a real Parquet file that reads back correctly,
 *     ignores the external compression layer, and keys as `.parquet`
 *   - isSelfCompressed / buildObjectKey for csv + parquet
 *   - runExport: parquet neutralises external compression (summary + key)
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
  isSelfCompressed,
  createEncoder,
  createCompressor,
  CSV_COLUMNS
} = require("../../src/export/formats");
const { LocalFileSink } = require("../../src/export/sink");
const { writeRecords, buildObjectKey, runExport } = require("../../src/export/index");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aep-fmt-test-"));
}

const EVENTS = [
  {
    specversion: "0.2.0", id: "evt_1", type: "task.created",
    time: "2026-01-01T00:00:00.000Z", source: "agent://a", session_id: "ses_1",
    trace_id: "trc_1", payload: { greeting: 'he said "hi", and left\nthen returned' },
    labels: { env: "prod" }
  },
  {
    specversion: "0.2.0", id: "evt_2", type: "tool.called",
    time: "2026-01-02T00:00:00.000Z", source: "agent://a,b", session_id: "ses_1",
    trace_id: "trc_1", payload: {}
  }
];

describe("formats: new format/compression registration", () => {
  test("formats now include csv + parquet", () => {
    assert.deepEqual(SUPPORTED_FORMATS, ["jsonl", "csv", "parquet"]);
  });
  test("compressions now include brotli", () => {
    assert.deepEqual(SUPPORTED_COMPRESSIONS, ["none", "gzip", "brotli"]);
  });
  test("only parquet is self-compressed", () => {
    assert.equal(isSelfCompressed("parquet"), true);
    assert.equal(isSelfCompressed("jsonl"), false);
    assert.equal(isSelfCompressed("csv"), false);
  });
});

describe("CSV encoder", () => {
  test("emits a header row then RFC-4180 rows with JSON object cells", async () => {
    const { stream, extension } = createEncoder("csv");
    assert.equal(extension, "csv");
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    const done = new Promise((r) => stream.on("end", r));
    for (const e of EVENTS) stream.write(e);
    stream.end();
    await done;

    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split("\r\n").filter(Boolean);
    // header + 2 rows
    assert.equal(lines.length, 3);
    assert.equal(lines[0], CSV_COLUMNS.join(","));

    // evt_1: payload has a comma/quote/newline → must be quoted with doubled quotes
    const payloadCol = CSV_COLUMNS.indexOf("payload");
    assert.ok(lines[1].includes('"{""greeting"":'), "payload cell is quoted JSON");
    // evt_2 source "agent://a,b" contains a comma → quoted
    assert.ok(lines[2].includes('"agent://a,b"'), "comma-bearing source is quoted");

    // A round-trip parse of the first data row's payload column is non-trivial due
    // to embedded newline; assert the header column count matches a simple row.
    assert.equal(lines[0].split(",").length, CSV_COLUMNS.length);
    assert.ok(payloadCol >= 0);
  });

  test("missing fields render as empty cells", async () => {
    const { stream } = createEncoder("csv");
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    const done = new Promise((r) => stream.on("end", r));
    stream.write({ id: "only_id" });
    stream.end();
    await done;
    const lines = Buffer.concat(chunks).toString("utf8").split("\r\n").filter(Boolean);
    const row = lines[1].split(",");
    assert.equal(row[CSV_COLUMNS.indexOf("id")], "only_id");
    assert.equal(row[CSV_COLUMNS.indexOf("type")], "");
  });
});

describe("brotli compression", () => {
  test("writeRecords brotli round-trips JSONL", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const { bytes, location } = await writeRecords({
      records: EVENTS,
      format: "jsonl",
      compression: "brotli",
      sink,
      key: "t/events.jsonl.br"
    });
    const raw = fs.readFileSync(location);
    assert.equal(bytes, raw.length);
    const text = zlib.brotliDecompressSync(raw).toString("utf8");
    assert.equal(text.trim().split("\n").length, 2);
    assert.deepEqual(JSON.parse(text.trim().split("\n")[0]), EVENTS[0]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("createCompressor(brotli) reports .br extension", () => {
    const { extension } = createCompressor("brotli");
    assert.equal(extension, ".br");
  });
});

describe("parquet format", () => {
  test("writeRecords writes a real Parquet file that reads back", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const { bytes, location } = await writeRecords({
      records: EVENTS,
      format: "parquet",
      compression: "gzip", // must be IGNORED (parquet self-compresses)
      sink,
      key: "t/events.parquet"
    });
    const onDisk = fs.readFileSync(location);
    assert.equal(bytes, onDisk.length);
    // Parquet magic header/footer "PAR1"
    assert.equal(onDisk.subarray(0, 4).toString(), "PAR1");
    assert.equal(onDisk.subarray(-4).toString(), "PAR1");

    const parquet = require("@dsnp/parquetjs");
    const reader = await parquet.ParquetReader.openFile(location);
    const cursor = reader.getCursor();
    const rows = [];
    let rec;
    while ((rec = await cursor.next())) rows.push(rec);
    await reader.close();

    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "evt_1");
    assert.equal(rows[0].type, "task.created");
    // object columns stored as JSON strings
    assert.deepEqual(JSON.parse(rows[0].payload), EVENTS[0].payload);
    assert.deepEqual(JSON.parse(rows[0].labels), EVENTS[0].labels);
    assert.equal(rows[1].id, "evt_2");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("parquet eventToRow", () => {
  const { eventToRow } = require("../../src/export/parquet");
  test("stringifies object columns and omits missing optionals", () => {
    const row = eventToRow({ id: "e1", type: "task.created", payload: { a: 1 }, labels: { env: "prod" } });
    assert.equal(row.id, "e1");
    assert.equal(row.type, "task.created");
    assert.equal(row.payload, '{"a":1}');
    assert.equal(row.labels, '{"env":"prod"}');
    assert.ok(!("subject" in row));
  });
  test("throws when the required id is missing", () => {
    assert.throws(() => eventToRow({ type: "task.created" }), /missing required 'id'/);
    assert.throws(() => eventToRow({ id: null }), /missing required 'id'/);
  });
});

describe("buildObjectKey for new formats", () => {
  const now = Date.parse("2026-06-14T10:15:30.000Z");
  test("csv + brotli", () => {
    const key = buildObjectKey({ tenantId: "dev", now, format: "csv", compression: "brotli" });
    assert.equal(key, "dev/aep-events-dev-20260614T101530Z.csv.br");
  });
  test("parquet keys with no external compression suffix when caller passes none", () => {
    const key = buildObjectKey({ tenantId: "dev", now, format: "parquet", compression: "none" });
    assert.equal(key, "dev/aep-events-dev-20260614T101530Z.parquet");
  });
});

function fakeDb({ projects = [], eventsByTenant = {}, eventTenants } = {}) {
  return {
    async listProjects() {
      return projects;
    },
    async getEventsForQuery(tenantId) {
      return eventsByTenant[tenantId] || [];
    },
    async listEventTenantIds() {
      return eventTenants !== undefined ? eventTenants : Object.keys(eventsByTenant);
    }
  };
}

describe("runExport with new formats", () => {
  test("parquet neutralises external compression in summary + key", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const db = fakeDb({ projects: [{ tenant_id: "t1" }], eventsByTenant: { t1: EVENTS } });
    const summary = await runExport({
      db, sink, format: "parquet", compression: "gzip",
      now: Date.parse("2026-06-14T10:15:30.000Z")
    });
    assert.equal(summary.format, "parquet");
    assert.equal(summary.compression, "none"); // gzip neutralised
    const d = summary.details.find((x) => x.tenant_id === "t1");
    assert.equal(d.key, "t1/aep-events-t1-20260614T101530Z.parquet");
    assert.ok(fs.existsSync(d.location));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("csv + brotli flows through end to end", async () => {
    const dir = tmpDir();
    const sink = new LocalFileSink({ dir });
    const db = fakeDb({ projects: [{ tenant_id: "t1" }], eventsByTenant: { t1: EVENTS } });
    const summary = await runExport({ db, sink, format: "csv", compression: "brotli" });
    assert.equal(summary.compression, "brotli");
    const d = summary.details.find((x) => x.tenant_id === "t1");
    const text = zlib.brotliDecompressSync(fs.readFileSync(d.location)).toString("utf8");
    const lines = text.split("\r\n").filter(Boolean);
    assert.equal(lines[0], CSV_COLUMNS.join(",")); // header
    assert.equal(lines.length, 3); // header + 2
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
