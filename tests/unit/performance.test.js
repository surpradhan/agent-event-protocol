"use strict";

/**
 * Unit tests for the pure performance-profiling summarizer (no DB / I/O).
 * Covers operation pairing (tool + task), the nearest-rank percentile math, the
 * four group breakdowns, the slowest list + cap, unmatched-end accounting, and
 * the missing/blank/malformed bucketing rules.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { summarizePerformance, percentile, UNSPECIFIED } = require("../../src/performance");

const NOW = new Date("2026-06-15T12:00:00Z");

/** A tool.called start event. */
function toolCalled({ id = "evt_tc", time = "2026-06-01T00:00:00Z", source = "agent://a", session_id = "ses_1", trace_id = "trc_1", tool = "web_search" } = {}) {
  return { specversion: "0.2.0", id, time, source, type: "tool.called", session_id, trace_id, payload: { tool } };
}
/** A tool.result end event paired to a tool.called by causation_id. */
function toolResult({ id = "evt_tr", time = "2026-06-01T00:00:01Z", source = "agent://a", session_id = "ses_1", trace_id = "trc_1", causation_id = "evt_tc", tool = "web_search" } = {}) {
  return { specversion: "0.2.0", id, time, source, type: "tool.result", session_id, trace_id, causation_id, payload: { tool, status: "success" } };
}
/** A task.created start event. */
function taskCreated({ id = "evt_tk", time = "2026-06-01T00:00:00Z", source = "agent://orch", session_id = "ses_2", trace_id = "trc_1" } = {}) {
  return { specversion: "0.2.0", id, time, source, type: "task.created", session_id, trace_id, payload: { task: "do" } };
}
/** A task.completed end event paired to a task.created by causation_id. */
function taskCompleted({ id = "evt_tkc", time = "2026-06-01T00:00:05Z", source = "agent://orch", session_id = "ses_2", trace_id = "trc_1", causation_id = "evt_tk" } = {}) {
  return { specversion: "0.2.0", id, time, source, type: "task.completed", session_id, trace_id, causation_id, payload: {} };
}

describe("summarizePerformance — empty / non-array input", () => {
  test("empty input yields zero operations and a null overall", () => {
    const s = summarizePerformance([], { now: NOW });
    assert.equal(s.total_operations, 0);
    assert.equal(s.unmatched_ends, 0);
    assert.equal(s.overall, null);
    assert.deepEqual(s.by_tool, []);
    assert.deepEqual(s.by_agent, []);
    assert.deepEqual(s.by_session, []);
    assert.deepEqual(s.by_operation, []);
    assert.deepEqual(s.slowest, []);
    assert.equal(s.generated_at, NOW.toISOString());
  });

  test("non-array input is treated as empty", () => {
    assert.equal(summarizePerformance(null, { now: NOW }).total_operations, 0);
    assert.equal(summarizePerformance(undefined, { now: NOW }).total_operations, 0);
  });
});

describe("summarizePerformance — operation pairing", () => {
  test("pairs a tool.called→tool.result by causation_id and computes ms duration", () => {
    const events = [
      toolCalled({ id: "c1", time: "2026-06-01T00:00:00Z" }),
      toolResult({ id: "r1", causation_id: "c1", time: "2026-06-01T00:00:02.500Z" }),
    ];
    const s = summarizePerformance(events, { now: NOW });
    assert.equal(s.total_operations, 1);
    assert.equal(s.unmatched_ends, 0);
    assert.equal(s.overall.count, 1);
    assert.equal(s.overall.p50, 2500);
    assert.equal(s.by_tool.length, 1);
    assert.equal(s.by_tool[0].key, "web_search");
    assert.equal(s.by_operation[0].key, "tool.called→tool.result");
    assert.equal(s.slowest[0].kind, "tool");
    assert.equal(s.slowest[0].duration_ms, 2500);
    assert.equal(s.slowest[0].status, "completed");
  });

  test("pairs a task.created→task.completed and a task.failed (status reflected)", () => {
    const events = [
      taskCreated({ id: "t1", time: "2026-06-01T00:00:00Z" }),
      taskCompleted({ id: "tc1", causation_id: "t1", time: "2026-06-01T00:00:04Z" }),
      taskCreated({ id: "t2", time: "2026-06-01T00:00:00Z" }),
      { specversion: "0.2.0", id: "tf1", time: "2026-06-01T00:00:10Z", source: "agent://orch", type: "task.failed", session_id: "ses_2", trace_id: "trc_1", causation_id: "t2", payload: {} },
    ];
    const s = summarizePerformance(events, { now: NOW });
    assert.equal(s.total_operations, 2);
    const ops = s.by_operation.map((o) => o.key).sort();
    assert.deepEqual(ops, ["task.created→task.completed", "task.created→task.failed"]);
    // by_tool excludes task operations
    assert.deepEqual(s.by_tool, []);
    // slowest is the 10s failure, then the 4s completion
    assert.equal(s.slowest[0].duration_ms, 10000);
    assert.equal(s.slowest[0].status, "failed");
    assert.equal(s.slowest[1].duration_ms, 4000);
  });

  test("end without a locatable start counts as unmatched, not an operation", () => {
    const events = [toolResult({ id: "r1", causation_id: "missing" })];
    const s = summarizePerformance(events, { now: NOW });
    assert.equal(s.total_operations, 0);
    assert.equal(s.unmatched_ends, 1);
  });

  test("end with no causation_id is unmatched", () => {
    const ev = toolResult({ id: "r1" });
    delete ev.causation_id;
    const s = summarizePerformance([ev], { now: NOW });
    assert.equal(s.unmatched_ends, 1);
  });

  test("a causation_id pointing at the wrong start type is unmatched", () => {
    // tool.result whose causation_id points at a task.created — type mismatch.
    const events = [
      taskCreated({ id: "t1" }),
      toolResult({ id: "r1", causation_id: "t1" }),
    ];
    const s = summarizePerformance(events, { now: NOW });
    assert.equal(s.total_operations, 0);
    assert.equal(s.unmatched_ends, 1);
  });

  test("a start may close more than once: two ends sharing a causation_id each pair (stateless, per-record)", () => {
    // One task.created closed by BOTH a task.completed and a task.failed
    // (causation_id is not uniqueness-constrained). Each end is its own operation.
    const events = [
      taskCreated({ id: "t1", time: "2026-06-01T00:00:00Z" }),
      taskCompleted({ id: "tc1", causation_id: "t1", time: "2026-06-01T00:00:04Z" }),
      { specversion: "0.2.0", id: "tf1", time: "2026-06-01T00:00:09Z", source: "agent://orch", type: "task.failed", session_id: "ses_2", trace_id: "trc_1", causation_id: "t1", payload: {} },
    ];
    const s = summarizePerformance(events, { now: NOW });
    assert.equal(s.total_operations, 2);
    assert.equal(s.unmatched_ends, 0);
    assert.deepEqual(s.by_operation.map((o) => [o.key, o.count]).sort(), [
      ["task.created→task.completed", 1],
      ["task.created→task.failed", 1],
    ]);
  });

  test("negative duration (end before start) is unmatched, not negative latency", () => {
    const events = [
      toolCalled({ id: "c1", time: "2026-06-01T00:00:10Z" }),
      toolResult({ id: "r1", causation_id: "c1", time: "2026-06-01T00:00:05Z" }),
    ];
    const s = summarizePerformance(events, { now: NOW });
    assert.equal(s.total_operations, 0);
    assert.equal(s.unmatched_ends, 1);
  });

  test("malformed start/end time is unmatched", () => {
    const events = [
      toolCalled({ id: "c1", time: "not-a-time" }),
      toolResult({ id: "r1", causation_id: "c1", time: "2026-06-01T00:00:05Z" }),
    ];
    const s = summarizePerformance(events, { now: NOW });
    assert.equal(s.unmatched_ends, 1);
  });
});

describe("summarizePerformance — grouping & bucketing", () => {
  test("groups by tool name, agent source, and session; ranked by count desc", () => {
    const events = [
      // 2 web_search ops on agent://a / ses_1
      toolCalled({ id: "c1", tool: "web_search", source: "agent://a", session_id: "ses_1", time: "2026-06-01T00:00:00Z" }),
      toolResult({ id: "r1", causation_id: "c1", tool: "web_search", source: "agent://a", session_id: "ses_1", time: "2026-06-01T00:00:01Z" }),
      toolCalled({ id: "c2", tool: "web_search", source: "agent://a", session_id: "ses_1", time: "2026-06-01T00:00:00Z" }),
      toolResult({ id: "r2", causation_id: "c2", tool: "web_search", source: "agent://a", session_id: "ses_1", time: "2026-06-01T00:00:03Z" }),
      // 1 db_query op on agent://b / ses_2
      toolCalled({ id: "c3", tool: "db_query", source: "agent://b", session_id: "ses_2", time: "2026-06-01T00:00:00Z" }),
      toolResult({ id: "r3", causation_id: "c3", tool: "db_query", source: "agent://b", session_id: "ses_2", time: "2026-06-01T00:00:02Z" }),
    ];
    const s = summarizePerformance(events, { now: NOW });
    assert.equal(s.total_operations, 3);
    assert.deepEqual(s.by_tool.map((t) => [t.key, t.count]), [["web_search", 2], ["db_query", 1]]);
    assert.deepEqual(s.by_agent.map((a) => [a.key, a.count]), [["agent://a", 2], ["agent://b", 1]]);
    assert.deepEqual(s.by_session.map((x) => [x.key, x.count]), [["ses_1", 2], ["ses_2", 1]]);
    // web_search durations are 1000 and 3000 → p50 nearest-rank = 3000
    const ws = s.by_tool.find((t) => t.key === "web_search");
    assert.equal(ws.min, 1000);
    assert.equal(ws.max, 3000);
    assert.equal(ws.mean, 2000);
  });

  test("missing tool name (on both start and end) / blank source fold into the UNSPECIFIED bucket", () => {
    const c = toolCalled({ id: "c1", source: "", time: "2026-06-01T00:00:00Z" });
    delete c.payload.tool;
    const r = toolResult({ id: "r1", causation_id: "c1", source: "", time: "2026-06-01T00:00:01Z" });
    delete r.payload.tool;
    const s = summarizePerformance([c, r], { now: NOW });
    assert.equal(s.by_tool[0].key, UNSPECIFIED);
    assert.equal(s.by_agent[0].key, UNSPECIFIED);
  });

  test("tool name falls back to the end (tool.result) envelope when the start omits it", () => {
    const c = toolCalled({ id: "c1", time: "2026-06-01T00:00:00Z" });
    delete c.payload.tool;
    const r = toolResult({ id: "r1", causation_id: "c1", tool: "web_search", time: "2026-06-01T00:00:01Z" });
    const s = summarizePerformance([c, r], { now: NOW });
    assert.equal(s.by_tool[0].key, "web_search");
  });
});

describe("summarizePerformance — slowest list & limit", () => {
  function nOps(n) {
    const events = [];
    for (let i = 0; i < n; i++) {
      events.push(toolCalled({ id: `c${i}`, time: "2026-06-01T00:00:00Z" }));
      // duration grows with i: i seconds
      events.push(toolResult({ id: `r${i}`, causation_id: `c${i}`, time: new Date(Date.parse("2026-06-01T00:00:00Z") + i * 1000).toISOString() }));
    }
    return events;
  }

  test("slowest is descending by duration and capped at limit", () => {
    const s = summarizePerformance(nOps(5), { now: NOW, limit: 3 });
    assert.equal(s.total_operations, 5);
    assert.equal(s.slowest.length, 3);
    assert.deepEqual(s.slowest.map((o) => o.duration_ms), [4000, 3000, 2000]);
  });

  test("limit=0 yields an empty slowest list but full totals", () => {
    const s = summarizePerformance(nOps(4), { now: NOW, limit: 0 });
    assert.equal(s.total_operations, 4);
    assert.equal(s.slowest.length, 0);
  });

  test("non-finite limit falls back to 20", () => {
    const s = summarizePerformance(nOps(25), { now: NOW, limit: NaN });
    assert.equal(s.slowest.length, 20);
  });
});

describe("percentile — nearest-rank math", () => {
  test("computes nearest-rank percentiles deterministically", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(sorted, 50), 50); // ceil(.5*10)=5 → idx4
    assert.equal(percentile(sorted, 95), 100); // ceil(.95*10)=10 → idx9
    assert.equal(percentile(sorted, 99), 100);
  });

  test("single-element array returns that element for every percentile", () => {
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([42], 99), 42);
  });

  test("empty array returns 0", () => {
    assert.equal(percentile([], 50), 0);
  });
});
