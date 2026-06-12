"use strict";

/**
 * Unit tests for the pure custom-analytics query model (no DB / I/O).
 * The security-critical surface: whitelist enforcement, prototype-pollution guard,
 * safe payload-path resolution, the operator semantics, grouping/aggregation, and
 * the deterministic result ordering + limit.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateQuerySpec,
  runQuery,
  resolveField,
  validateFieldRef,
  UNSPECIFIED
} = require("../../src/customQuery");

const NOW = new Date("2026-06-15T12:00:00Z");

/** Build an event envelope with sensible defaults. */
function ev(o = {}) {
  return {
    specversion: "0.2.0",
    id: o.id ?? "evt_x",
    time: o.time ?? "2026-06-01T00:00:00Z",
    source: o.source ?? "agent://a",
    type: o.type ?? "tool.called",
    session_id: o.session_id ?? "ses_1",
    trace_id: o.trace_id ?? "trc_1",
    agent_role: o.agent_role,
    payload: o.payload ?? {},
    labels: o.labels,
    extensions: o.extensions
  };
}

describe("validateFieldRef — whitelist + prototype-pollution guard", () => {
  test("accepts whitelisted top-level fields", () => {
    for (const f of ["type", "source", "session_id", "trace_id", "agent_role", "time", "id"]) {
      assert.equal(validateFieldRef(f), null, `${f} should be valid`);
    }
  });
  test("accepts payload/labels/extensions dot-paths", () => {
    assert.equal(validateFieldRef("payload.tool"), null);
    assert.equal(validateFieldRef("labels.env"), null);
    assert.equal(validateFieldRef("extensions.a.b.c"), null);
  });
  test("rejects unknown top-level fields", () => {
    assert.match(validateFieldRef("raw_payload"), /unknown field/);
    assert.match(validateFieldRef("ingested_at"), /unknown field/);
  });
  test("rejects non-queryable roots", () => {
    assert.match(validateFieldRef("secret.value"), /not queryable/);
  });
  test("rejects prototype-pollution segments", () => {
    assert.match(validateFieldRef("payload.__proto__"), /forbidden segment/);
    assert.match(validateFieldRef("payload.a.constructor"), /forbidden segment/);
    assert.match(validateFieldRef("payload.prototype"), /forbidden segment/);
  });
  test("rejects empty / non-string fields and empty path segments", () => {
    assert.match(validateFieldRef(""), /non-empty string/);
    assert.match(validateFieldRef(42), /non-empty string/);
    assert.match(validateFieldRef("payload."), /empty path/);
    assert.match(validateFieldRef("payload.a..b"), /empty path segment/);
  });
});

describe("resolveField — safe traversal", () => {
  test("reads top-level and nested values", () => {
    const e = ev({ source: "agent://x", payload: { tool: "web_search", nested: { k: "v" } }, labels: { env: "prod" } });
    assert.equal(resolveField(e, "source"), "agent://x");
    assert.equal(resolveField(e, "payload.tool"), "web_search");
    assert.equal(resolveField(e, "payload.nested.k"), "v");
    assert.equal(resolveField(e, "labels.env"), "prod");
  });
  test("returns undefined for missing paths and non-object traversal", () => {
    const e = ev({ payload: { tool: "x" } });
    assert.equal(resolveField(e, "payload.missing"), undefined);
    assert.equal(resolveField(e, "payload.tool.deeper"), undefined);
    assert.equal(resolveField(e, "labels.env"), undefined); // labels absent
  });
  test("never returns inherited / prototype properties", () => {
    const e = ev({ payload: { tool: "x" } });
    // toString is on Object.prototype — must NOT resolve.
    assert.equal(resolveField(e, "payload.toString"), undefined);
    assert.equal(resolveField(e, "payload.__proto__"), undefined);
  });
});

describe("validateQuerySpec", () => {
  test("an empty spec is valid (count of everything)", () => {
    const r = validateQuerySpec({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.normalized.aggregations, [{ op: "count" }]);
    assert.deepEqual(r.normalized.group_by, []);
    assert.equal(r.normalized.limit, 100);
  });
  test("rejects a non-object spec", () => {
    assert.equal(validateQuerySpec(null).ok, false);
    assert.equal(validateQuerySpec([]).ok, false);
    assert.equal(validateQuerySpec("x").ok, false);
  });
  test("validates filter operators and value shapes", () => {
    assert.equal(validateQuerySpec({ filters: [{ field: "type", op: "eq", value: "tool.called" }] }).ok, true);
    assert.match(validateQuerySpec({ filters: [{ field: "type", op: "bogus", value: "x" }] }).errors[0], /not a valid operator/);
    assert.match(validateQuerySpec({ filters: [{ field: "type", op: "in", value: "notarray" }] }).errors[0], /non-empty 'value' array/);
    assert.match(validateQuerySpec({ filters: [{ field: "type", op: "eq", value: { a: 1 } }] }).errors[0], /scalar 'value'/);
    assert.equal(validateQuerySpec({ filters: [{ field: "payload.tool", op: "exists" }] }).ok, true);
  });
  test("propagates field-whitelist errors from filters/group_by/aggregations", () => {
    assert.match(validateQuerySpec({ filters: [{ field: "payload.__proto__", op: "exists" }] }).errors[0], /forbidden segment/);
    assert.match(validateQuerySpec({ group_by: ["nope"] }).errors[0], /unknown field/);
    assert.match(validateQuerySpec({ aggregations: [{ op: "count_distinct", field: "secret.x" }] }).errors[0], /not queryable/);
  });
  test("rejects unsupported aggregation ops and always guarantees a count", () => {
    assert.match(validateQuerySpec({ aggregations: [{ op: "sum", field: "x" }] }).errors[0], /not supported/);
    const r = validateQuerySpec({ aggregations: [{ op: "count_distinct", field: "session_id" }] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.normalized.aggregations[0], { op: "count" }); // count prepended
  });
  test("validates time_bucket, since/until, and limit bounds", () => {
    assert.match(validateQuerySpec({ time_bucket: "year" }).errors[0], /time_bucket must be/);
    assert.equal(validateQuerySpec({ time_bucket: "day" }).ok, true);
    assert.match(validateQuerySpec({ since: "nope" }).errors[0], /ISO-8601/);
    assert.match(validateQuerySpec({ limit: 0 }).errors[0], /\[1, 1000\]/);
    assert.match(validateQuerySpec({ limit: 5000 }).errors[0], /\[1, 1000\]/);
  });
  test("enforces collection size caps", () => {
    const many = Array.from({ length: 26 }, () => ({ field: "type", op: "exists" }));
    assert.match(validateQuerySpec({ filters: many }).errors[0], /too many filters/);
  });
});

describe("runQuery — filtering & aggregation", () => {
  const events = [
    ev({ id: "e1", type: "tool.called", source: "agent://a", session_id: "s1", payload: { tool: "web_search" }, time: "2026-06-01T00:00:00Z" }),
    ev({ id: "e2", type: "tool.called", source: "agent://a", session_id: "s1", payload: { tool: "web_search" }, time: "2026-06-01T01:00:00Z" }),
    ev({ id: "e3", type: "tool.called", source: "agent://b", session_id: "s2", payload: { tool: "db_query" }, time: "2026-06-02T00:00:00Z" }),
    ev({ id: "e4", type: "task.created", source: "agent://a", session_id: "s1", payload: {}, time: "2026-06-02T00:00:00Z" }),
  ];
  const run = (specIn) => {
    const { ok, normalized, errors } = validateQuerySpec(specIn);
    assert.equal(ok, true, JSON.stringify(errors));
    return runQuery(events, normalized, { now: NOW });
  };

  test("no group_by → a single total row", () => {
    const r = run({});
    assert.equal(r.total_matched, 4);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].count, 4);
    assert.deepEqual(r.rows[0].group, {});
    assert.equal(r.generated_at, NOW.toISOString());
  });

  test("filters narrow the matched set", () => {
    const r = run({ filters: [{ field: "type", op: "eq", value: "tool.called" }] });
    assert.equal(r.total_matched, 3);
  });

  test("group_by a payload path, ranked by count desc then key asc", () => {
    const r = run({ filters: [{ field: "type", op: "eq", value: "tool.called" }], group_by: ["payload.tool"] });
    assert.deepEqual(r.rows.map((x) => [x.group["payload.tool"], x.count]), [
      ["web_search", 2],
      ["db_query", 1],
    ]);
  });

  test("count_distinct counts unique resolved values per group", () => {
    const r = run({ group_by: ["source"], aggregations: [{ op: "count" }, { op: "count_distinct", field: "session_id" }] });
    const a = r.rows.find((x) => x.group.source === "agent://a");
    assert.equal(a.count, 3);
    assert.equal(a.distinct.session_id, 1); // all s1
    const b = r.rows.find((x) => x.group.source === "agent://b");
    assert.equal(b.distinct.session_id, 1);
  });

  test("time_bucket adds a _bucket group dimension", () => {
    const r = run({ time_bucket: "day" });
    const days = r.rows.map((x) => x.group._bucket).sort();
    assert.deepEqual(days, ["2026-06-01", "2026-06-02"]);
  });

  test("missing group value folds into the UNSPECIFIED bucket", () => {
    const r = run({ group_by: ["payload.tool"] });
    const unspec = r.rows.find((x) => x.group["payload.tool"] === UNSPECIFIED);
    assert.equal(unspec.count, 1); // the task.created with no payload.tool
  });

  test("since/until window is applied", () => {
    const r = run({ since: "2026-06-02T00:00:00Z" });
    assert.equal(r.total_matched, 2); // e3 + e4
  });

  test("limit truncates rows and sets truncated=true", () => {
    const { normalized } = validateQuerySpec({ group_by: ["id"], limit: 2 });
    const r = runQuery(events, normalized, { now: NOW });
    assert.equal(r.rows.length, 2);
    assert.equal(r.truncated, true);
  });
});

describe("runQuery — operator semantics", () => {
  const events = [
    ev({ id: "a", source: "agent://alpha", payload: { n: 5, status: "ok" } }),
    ev({ id: "b", source: "agent://beta", payload: { n: 15, status: "error" } }),
    ev({ id: "c", source: "other://gamma", payload: { n: 25 } }),
  ];
  const count = (filters) => {
    const { normalized } = validateQuerySpec({ filters });
    return runQuery(events, normalized, { now: NOW }).total_matched;
  };

  test("prefix / contains on strings", () => {
    assert.equal(count([{ field: "source", op: "prefix", value: "agent://" }]), 2);
    assert.equal(count([{ field: "source", op: "contains", value: "gamma" }]), 1);
  });
  test("in / nin membership", () => {
    assert.equal(count([{ field: "payload.status", op: "in", value: ["ok", "error"] }]), 2);
    assert.equal(count([{ field: "payload.status", op: "nin", value: ["ok"] }]), 2); // 'error' + missing both pass nin
  });
  test("numeric gt/gte/lt/lte coerce numbers", () => {
    assert.equal(count([{ field: "payload.n", op: "gt", value: 10 }]), 2);
    assert.equal(count([{ field: "payload.n", op: "lte", value: 15 }]), 2);
  });
  test("exists / not_exists on a payload field", () => {
    assert.equal(count([{ field: "payload.status", op: "exists" }]), 2);
    assert.equal(count([{ field: "payload.status", op: "not_exists" }]), 1);
  });
  test("lt against a missing field does not match (NaN-guarded)", () => {
    assert.equal(count([{ field: "payload.status", op: "lt", value: "zzz" }]), 2); // only present ones compared
  });
});
