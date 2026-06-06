"use strict";

/**
 * Unit tests for the pure retention helpers (no DB / I/O).
 *   - isPrunable: which retention_days values mean "prune" vs "keep forever"
 *   - computeCutoff: now - retention_days, as an ISO-8601 string
 * plus the prune.js CLI argument parser.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { isPrunable, computeCutoff } = require("../../src/retention");
const { parseArgs } = require("../../src/prune");

describe("retention.isPrunable", () => {
  test("positive finite day counts are prunable", () => {
    assert.equal(isPrunable(1), true);
    assert.equal(isPrunable(30), true);
    assert.equal(isPrunable(90), true);
  });

  test("NULL / undefined means keep forever (not prunable)", () => {
    assert.equal(isPrunable(null), false);
    assert.equal(isPrunable(undefined), false);
  });

  test("zero and negative day counts mean keep forever", () => {
    assert.equal(isPrunable(0), false);
    assert.equal(isPrunable(-5), false);
  });

  test("non-finite values are not prunable", () => {
    assert.equal(isPrunable(NaN), false);
    assert.equal(isPrunable(Infinity), false);
  });
});

describe("retention.computeCutoff", () => {
  test("subtracts retention_days from now and returns ISO-8601", () => {
    const now = new Date("2026-06-06T00:00:00.000Z");
    // 30 days earlier
    assert.equal(computeCutoff(30, now), "2026-05-07T00:00:00.000Z");
  });

  test("accepts an epoch-millis 'now' as well as a Date", () => {
    const nowMs = Date.parse("2026-06-06T12:00:00.000Z");
    assert.equal(computeCutoff(1, nowMs), "2026-06-05T12:00:00.000Z");
  });

  test("a 1-day window keeps events from the last 24h", () => {
    const now = new Date("2026-06-06T00:00:00.000Z");
    const cutoff = computeCutoff(1, now);
    // An event timestamped 25h ago is older than the cutoff (string compare ==
    // chronological for ISO-8601, the same comparison the SQL uses).
    const old = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();
    const recent = new Date(now.getTime() - 23 * 3600 * 1000).toISOString();
    assert.ok(old < cutoff, "25h-old event is before cutoff");
    assert.ok(recent >= cutoff, "23h-old event is at/after cutoff");
  });
});

describe("prune.js parseArgs", () => {
  test("defaults: no flags", () => {
    const r = parseArgs(["node", "prune"]);
    assert.deepEqual(r, { dryRun: false, json: false, help: false });
  });

  test("--dry-run sets dryRun", () => {
    assert.equal(parseArgs(["node", "prune", "--dry-run"]).dryRun, true);
  });

  test("--json sets json", () => {
    assert.equal(parseArgs(["node", "prune", "--json"]).json, true);
  });

  test("--help / -h set help", () => {
    assert.equal(parseArgs(["node", "prune", "--help"]).help, true);
    assert.equal(parseArgs(["node", "prune", "-h"]).help, true);
  });

  test("flags combine", () => {
    const r = parseArgs(["node", "prune", "--dry-run", "--json"]);
    assert.equal(r.dryRun, true);
    assert.equal(r.json, true);
  });
});
