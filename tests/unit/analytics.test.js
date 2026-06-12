"use strict";

/**
 * Unit tests for the pure policy.blocked analytics summarizer (no DB / I/O).
 * Covers totals, the four breakdowns (policy / action / source / day), the
 * recent-list ordering + cap, and the missing/blank-field bucketing rules.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { summarizePolicyBlocked, UNSPECIFIED } = require("../../src/analytics");

/** Build a policy.blocked event envelope with sensible defaults. */
function ev({ id = "evt_x", time = "2026-06-01T00:00:00Z", source = "agent://a", policy, reason, action_blocked, session_id = "ses_1", trace_id = "trc_1", agent_role = "orchestrator" } = {}) {
  return {
    specversion: "0.2.0",
    id,
    time,
    source,
    type: "policy.blocked",
    session_id,
    trace_id,
    agent_role,
    payload: { policy, reason, action_blocked }
  };
}

const NOW = new Date("2026-06-15T12:00:00Z");

describe("summarizePolicyBlocked — totals & generated_at", () => {
  test("empty input yields zero total and empty breakdowns", () => {
    const s = summarizePolicyBlocked([], { now: NOW });
    assert.equal(s.total, 0);
    assert.deepEqual(s.by_policy, []);
    assert.deepEqual(s.by_action, []);
    assert.deepEqual(s.by_source, []);
    assert.deepEqual(s.by_day, []);
    assert.deepEqual(s.recent, []);
    assert.equal(s.generated_at, NOW.toISOString());
  });

  test("non-array input is treated as empty", () => {
    assert.equal(summarizePolicyBlocked(null, { now: NOW }).total, 0);
    assert.equal(summarizePolicyBlocked(undefined, { now: NOW }).total, 0);
  });

  test("total equals the number of events", () => {
    const s = summarizePolicyBlocked([ev(), ev(), ev()], { now: NOW });
    assert.equal(s.total, 3);
  });
});

describe("summarizePolicyBlocked — breakdowns", () => {
  const events = [
    ev({ policy: "pii_guard", action_blocked: "tool.called/send_email", source: "agent://a" }),
    ev({ policy: "pii_guard", action_blocked: "tool.called/send_email", source: "agent://a" }),
    ev({ policy: "rate_guard", action_blocked: "tool.called/http", source: "agent://b" })
  ];

  test("by_policy is ranked descending by count", () => {
    const s = summarizePolicyBlocked(events, { now: NOW });
    assert.deepEqual(s.by_policy, [
      { key: "pii_guard", count: 2 },
      { key: "rate_guard", count: 1 }
    ]);
  });

  test("by_action and by_source aggregate correctly", () => {
    const s = summarizePolicyBlocked(events, { now: NOW });
    assert.deepEqual(s.by_action, [
      { key: "tool.called/send_email", count: 2 },
      { key: "tool.called/http", count: 1 }
    ]);
    assert.deepEqual(s.by_source, [
      { key: "agent://a", count: 2 },
      { key: "agent://b", count: 1 }
    ]);
  });

  test("breakdown totals always equal `total` (every event counted once)", () => {
    const s = summarizePolicyBlocked(events, { now: NOW });
    const sum = (arr) => arr.reduce((n, e) => n + e.count, 0);
    assert.equal(sum(s.by_policy), s.total);
    assert.equal(sum(s.by_action), s.total);
    assert.equal(sum(s.by_source), s.total);
  });

  test("missing / blank fields fold into the UNSPECIFIED bucket", () => {
    const s = summarizePolicyBlocked(
      [ev({ policy: undefined, action_blocked: "", source: "  " }), ev({ policy: "x", action_blocked: "y", source: "agent://a" })],
      { now: NOW }
    );
    // tie at count 1 → alphabetical; "(unspecified)" sorts before "x"
    assert.deepEqual(s.by_policy, [
      { key: UNSPECIFIED, count: 1 },
      { key: "x", count: 1 }
    ]);
    // blank action / whitespace source both bucket as UNSPECIFIED
    assert.ok(s.by_action.some((e) => e.key === UNSPECIFIED && e.count === 1));
    assert.ok(s.by_source.some((e) => e.key === UNSPECIFIED && e.count === 1));
  });

  test("an event with no payload object does not throw and counts as unspecified", () => {
    const broken = { id: "evt_z", time: "2026-06-01T00:00:00Z", source: "agent://a", type: "policy.blocked" };
    const s = summarizePolicyBlocked([broken], { now: NOW });
    assert.equal(s.total, 1);
    assert.deepEqual(s.by_policy, [{ key: UNSPECIFIED, count: 1 }]);
  });

  test("ties in a breakdown break alphabetically (deterministic order)", () => {
    const s = summarizePolicyBlocked(
      [ev({ policy: "zebra" }), ev({ policy: "alpha" })],
      { now: NOW }
    );
    assert.deepEqual(s.by_policy, [
      { key: "alpha", count: 1 },
      { key: "zebra", count: 1 }
    ]);
  });
});

describe("summarizePolicyBlocked — by_day", () => {
  test("buckets by UTC calendar day, sorted ascending", () => {
    const s = summarizePolicyBlocked(
      [
        ev({ time: "2026-06-03T23:00:00Z" }),
        ev({ time: "2026-06-01T01:00:00Z" }),
        ev({ time: "2026-06-03T02:00:00Z" })
      ],
      { now: NOW }
    );
    assert.deepEqual(s.by_day, [
      { date: "2026-06-01", count: 1 },
      { date: "2026-06-03", count: 2 }
    ]);
  });

  test("malformed / missing times fold into one UNSPECIFIED day bucket", () => {
    const s = summarizePolicyBlocked(
      [ev({ time: "2026-06-01T00:00:00Z" }), { type: "policy.blocked", payload: {} }],
      { now: NOW }
    );
    assert.ok(s.by_day.some((d) => d.date === "2026-06-01" && d.count === 1));
    assert.ok(s.by_day.some((d) => d.date === UNSPECIFIED && d.count === 1));
  });
});

describe("summarizePolicyBlocked — recent list", () => {
  test("is most-recent-first and projects the expected fields", () => {
    const s = summarizePolicyBlocked(
      [
        ev({ id: "old", time: "2026-06-01T00:00:00Z", policy: "p1", reason: "r1", action_blocked: "a1" }),
        ev({ id: "new", time: "2026-06-10T00:00:00Z", policy: "p2", reason: "r2", action_blocked: "a2" })
      ],
      { now: NOW }
    );
    assert.equal(s.recent[0].id, "new");
    assert.equal(s.recent[1].id, "old");
    assert.deepEqual(s.recent[0], {
      id: "new",
      time: "2026-06-10T00:00:00Z",
      source: "agent://a",
      session_id: "ses_1",
      trace_id: "trc_1",
      agent_role: "orchestrator",
      policy: "p2",
      reason: "r2",
      action_blocked: "a2"
    });
  });

  test("respects the limit (default 20)", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      ev({ id: `evt_${i}`, time: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` })
    );
    assert.equal(summarizePolicyBlocked(many, { now: NOW }).recent.length, 20);
    assert.equal(summarizePolicyBlocked(many, { now: NOW, limit: 5 }).recent.length, 5);
  });

  test("limit of 0 yields an empty recent list (total still counts all)", () => {
    const s = summarizePolicyBlocked([ev(), ev()], { now: NOW, limit: 0 });
    assert.equal(s.recent.length, 0);
    assert.equal(s.total, 2);
  });

  test("an event with a missing/non-string time sorts LAST, not first", () => {
    const s = summarizePolicyBlocked(
      [
        { id: "no-time", type: "policy.blocked", source: "agent://a", payload: {} },
        ev({ id: "has-time", time: "2026-06-10T00:00:00Z" })
      ],
      { now: NOW }
    );
    assert.equal(s.recent[0].id, "has-time");
    assert.equal(s.recent[1].id, "no-time");
  });

  test("non-finite limit falls back to the default of 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => ev({ id: `e${i}`, time: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }));
    assert.equal(summarizePolicyBlocked(many, { now: NOW, limit: NaN }).recent.length, 20);
  });
});
