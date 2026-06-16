"use strict";

/**
 * Unit tests for the pure policy.blocked analytics summarizer (no DB / I/O).
 * Covers totals, the four breakdowns (policy / action / source / day), the
 * recent-list ordering + cap, and the missing/blank-field bucketing rules.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { summarizePolicyBlocked, UNSPECIFIED, toCsvAnalytics, escapeCsvCell } = require("../../src/analytics");

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

// ---------------------------------------------------------------------------
// escapeCsvCell — RFC-4180 cell escaping
// ---------------------------------------------------------------------------

describe("escapeCsvCell — RFC-4180 quoting", () => {
  test("plain strings pass through unchanged", () => {
    assert.equal(escapeCsvCell("hello"), "hello");
    assert.equal(escapeCsvCell("no special chars"), "no special chars");
  });

  test("null and undefined coerce to empty string", () => {
    assert.equal(escapeCsvCell(null), "");
    assert.equal(escapeCsvCell(undefined), "");
  });

  test("numbers coerce to their string representation", () => {
    assert.equal(escapeCsvCell(42), "42");
    assert.equal(escapeCsvCell(3.14), "3.14");
  });

  test("values containing commas are double-quoted", () => {
    assert.equal(escapeCsvCell("a,b"), '"a,b"');
    assert.equal(escapeCsvCell("x,y,z"), '"x,y,z"');
  });

  test("values containing newlines are double-quoted", () => {
    assert.equal(escapeCsvCell("line1\nline2"), '"line1\nline2"');
  });

  test("quotes cells containing bare \\r", () => {
    assert.equal(escapeCsvCell("line1\rline2"), '"line1\rline2"');
  });
  test("quotes cells containing CRLF", () => {
    assert.equal(escapeCsvCell("line1\r\nline2"), '"line1\r\nline2"');
  });

  test("values containing double-quotes are wrapped and inner quotes doubled", () => {
    assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvCell('"'), '""""');
  });

  test("value with both comma and quote triggers quoting and doubling", () => {
    assert.equal(escapeCsvCell('a,"b"'), '"a,""b"""');
  });
});

// ---------------------------------------------------------------------------
// toCsvAnalytics — RFC-4180 encoder for analytics row objects
// ---------------------------------------------------------------------------

describe("toCsvAnalytics — CSV encoding", () => {
  const FIELDS = ["id", "count", "label"];

  test("empty rows array returns just a header line", () => {
    const csv = toCsvAnalytics([], FIELDS);
    assert.equal(csv, "id,count,label\n");
  });

  test("non-array rows returns just a header line", () => {
    assert.equal(toCsvAnalytics(null, FIELDS), "id,count,label\n");
    assert.equal(toCsvAnalytics(undefined, FIELDS), "id,count,label\n");
  });

  test("single row is encoded with header + data row", () => {
    const csv = toCsvAnalytics([{ id: "e1", count: 3, label: "pii_guard" }], FIELDS);
    const lines = csv.trim().split("\n");
    assert.equal(lines[0], "id,count,label");
    assert.equal(lines[1], "e1,3,pii_guard");
  });

  test("multiple rows produce one line each after the header", () => {
    const rows = [
      { id: "e1", count: 1, label: "a" },
      { id: "e2", count: 2, label: "b" }
    ];
    const csv = toCsvAnalytics(rows, FIELDS);
    const lines = csv.trim().split("\n");
    assert.equal(lines.length, 3); // header + 2 rows
    assert.equal(lines[1], "e1,1,a");
    assert.equal(lines[2], "e2,2,b");
  });

  test("cells with commas are quoted", () => {
    const rows = [{ id: "e1", count: 5, label: "a,b" }];
    const csv = toCsvAnalytics(rows, FIELDS);
    assert.ok(csv.includes('"a,b"'), `Expected quoted cell, got: ${csv}`);
  });

  test("cells with embedded double-quotes are escaped by doubling", () => {
    const rows = [{ id: 'say "hi"', count: 1, label: "x" }];
    const csv = toCsvAnalytics(rows, FIELDS);
    assert.ok(csv.includes('"say ""hi"""'), `Expected escaped quotes, got: ${csv}`);
  });

  test("nested objects are JSON-stringified into the cell", () => {
    const rows = [{ id: "e1", count: 1, label: { nested: true } }];
    const csv = toCsvAnalytics(rows, FIELDS);
    // JSON.stringify({nested:true}) → '{"nested":true}' which contains double-quotes, so
    // the cell is wrapped in double-quotes and the inner quotes are doubled per RFC-4180.
    assert.ok(csv.includes('"{""nested"":true}"'), `Expected RFC-4180-escaped JSON cell, got: ${csv}`);
  });

  test("nested arrays are JSON-stringified into the cell", () => {
    const rows = [{ id: "e1", count: 1, label: [1, 2, 3] }];
    const csv = toCsvAnalytics(rows, FIELDS);
    assert.ok(csv.includes("[1,2,3]"), `Expected JSON array cell, got: ${csv}`);
  });

  test("null field values in rows become empty cells", () => {
    const rows = [{ id: "e1", count: null, label: "x" }];
    const csv = toCsvAnalytics(rows, FIELDS);
    const dataLine = csv.trim().split("\n")[1];
    assert.equal(dataLine, "e1,,x");
  });

  test("missing field keys in a row become empty cells", () => {
    const rows = [{ id: "e1" }]; // count and label missing
    const csv = toCsvAnalytics(rows, FIELDS);
    const dataLine = csv.trim().split("\n")[1];
    assert.equal(dataLine, "e1,,");
  });

  test("output always ends with a trailing newline", () => {
    assert.ok(toCsvAnalytics([], FIELDS).endsWith("\n"));
    assert.ok(toCsvAnalytics([{ id: "x", count: 0, label: "y" }], FIELDS).endsWith("\n"));
  });
});
