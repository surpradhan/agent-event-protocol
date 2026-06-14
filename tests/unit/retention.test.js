"use strict";

/**
 * Unit tests for the pure retention helpers (no DB / I/O).
 *   - isPrunable: which retention_days values mean "prune" vs "keep forever"
 *   - computeCutoff: now - retention_days, as an ISO-8601 string
 * plus the prune.js CLI argument parser.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { isPrunable, computeCutoff, pruneAll } = require("../../src/retention");
const { parseArgs } = require("../../src/prune");

/**
 * Fake storage backend for pruneAll (injected via the `db` option). Records
 * which tenants had pruneEventsBefore called, so tests can assert the
 * export-before-prune safety gate actually blocks deletion.
 */
function fakeDb({ projects = [], deleteResult = { events_deleted: 5, sessions_deleted: 2 }, counts = {} } = {}) {
  const pruned = [];
  return {
    pruned,
    async listProjects() {
      return projects;
    },
    async countEventsBefore(tenantId) {
      return counts[tenantId] ?? 0;
    },
    async pruneEventsBefore(tenantId, cutoff) {
      pruned.push({ tenantId, cutoff });
      return deleteResult;
    }
  };
}

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
    assert.deepEqual(r, { dryRun: false, json: false, exportBeforePrune: false, help: false });
  });

  test("--export-before-prune sets exportBeforePrune", () => {
    assert.equal(parseArgs(["node", "prune", "--export-before-prune"]).exportBeforePrune, true);
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

describe("retention.pruneAll export-before-prune (injected db)", () => {
  const projects = [{ id: "p1", tenant_id: "t1", retention_days: 30 }];
  const now = Date.parse("2026-06-14T00:00:00.000Z");

  test("exports before deleting; records export counts; deletes on success", async () => {
    const db = fakeDb({ projects });
    const exportCalls = [];
    const exportTenant = async (tenantId, cutoff) => {
      exportCalls.push({ tenantId, cutoff });
      return { objects_written: 1, events_exported: 5 };
    };
    const summary = await pruneAll({ db, now, exportBeforePrune: true, exportTenant });

    assert.equal(exportCalls.length, 1);
    assert.equal(exportCalls[0].tenantId, "t1");
    // export window == prune predicate (events older than cutoff)
    assert.equal(exportCalls[0].cutoff, computeCutoff(30, now));
    // deletion happened after a successful export
    assert.deepEqual(db.pruned, [{ tenantId: "t1", cutoff: computeCutoff(30, now) }]);
    assert.equal(summary.events_deleted, 5);
    assert.equal(summary.export_failures, 0);
    const d = summary.details[0];
    assert.equal(d.exported, true);
    assert.equal(d.objects_written, 1);
    assert.equal(d.events_exported, 5);
  });

  test("SAFETY GATE: a failed export skips deletion and records the error", async () => {
    const db = fakeDb({ projects });
    const exportTenant = async () => {
      throw new Error("S3 unreachable");
    };
    const summary = await pruneAll({ db, now, exportBeforePrune: true, exportTenant });

    // The critical invariant: nothing was deleted for the project whose export failed.
    assert.deepEqual(db.pruned, []);
    assert.equal(summary.events_deleted, 0);
    assert.equal(summary.export_failures, 1);
    const d = summary.details[0];
    assert.equal(d.exported, false);
    assert.match(d.export_error, /S3 unreachable/);
    assert.equal(d.events_deleted, 0);
  });

  test("requires an exportTenant function for a real export-before-prune run", async () => {
    const db = fakeDb({ projects });
    await assert.rejects(
      () => pruneAll({ db, now, exportBeforePrune: true }),
      /requires an exportTenant/
    );
  });

  test("dry-run never exports and never deletes", async () => {
    const db = fakeDb({ projects, counts: { t1: 7 } });
    let called = false;
    const exportTenant = async () => {
      called = true;
      return { objects_written: 1, events_exported: 7 };
    };
    const summary = await pruneAll({ db, now, dryRun: true, exportBeforePrune: true, exportTenant });
    assert.equal(called, false);          // no export in dry-run
    assert.deepEqual(db.pruned, []);      // no deletion in dry-run
    assert.equal(summary.details[0].events_deleted, 7); // would-delete count
  });

  test("without exportBeforePrune, deletes directly (no export needed)", async () => {
    const db = fakeDb({ projects });
    const summary = await pruneAll({ db, now });
    assert.deepEqual(db.pruned, [{ tenantId: "t1", cutoff: computeCutoff(30, now) }]);
    assert.equal(summary.exportBeforePrune, false);
    assert.equal(summary.events_deleted, 5);
  });
});
