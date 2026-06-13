"use strict";

/**
 * Unit tests for the pure workflow anomaly detector (no DB / I/O).
 * Covers the robust modified-z baseline (median / MAD with mean-AD fallback), the
 * three metrics (error-rate, policy.blocked volume, latency spike), the stability
 * guard (too few traces / constant metric never flag), high-side-only flagging,
 * severity banding, and deterministic ordering + cap.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { detectAnomalies, median, robustScale, severityFor } = require("../../src/anomalies");

const NOW = new Date("2026-06-15T12:00:00Z");

function ev(o = {}) {
  return {
    specversion: "0.2.0",
    id: o.id,
    time: o.time ?? "2026-06-01T00:00:00Z",
    source: o.source ?? "agent://a",
    type: o.type ?? "task.created",
    session_id: o.session_id ?? "ses_1",
    trace_id: o.trace_id ?? "trc_1",
    causation_id: o.causation_id,
    payload: o.payload ?? {}
  };
}

// Build a "normal" trace of N benign task.created events.
function normalTrace(tid, n = 5) {
  return Array.from({ length: n }, (_, i) =>
    ev({ id: `${tid}_e${i}`, trace_id: tid, type: "task.created" })
  );
}

describe("median / robustScale / severityFor", () => {
  test("median of odd and even arrays", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), 0);
  });
  test("robustScale falls back to mean-AD when MAD is zero (sparse counts)", () => {
    // mostly zeros + one spike → MAD is 0, mean-AD drives the scale (non-zero)
    const { med, scale } = robustScale([0, 0, 0, 0, 0, 0, 8]);
    assert.equal(med, 0);
    assert.ok(scale > 0);
  });
  test("robustScale is zero for a perfectly constant metric", () => {
    assert.equal(robustScale([4, 4, 4, 4]).scale, 0);
  });
  test("severity bands", () => {
    assert.equal(severityFor(8), "critical");
    assert.equal(severityFor(5), "high");
    assert.equal(severityFor(3.5), "medium");
    assert.equal(severityFor(2), "low");
  });
});

describe("detectAnomalies — stability guard", () => {
  test("empty input → no anomalies", () => {
    const r = detectAnomalies([], { now: NOW });
    assert.equal(r.trace_count, 0);
    assert.equal(r.anomaly_count, 0);
    assert.deepEqual(r.anomalies, []);
    assert.equal(r.threshold, 3.5);
    assert.equal(r.generated_at, NOW.toISOString());
  });

  test("too few traces (< minSamples) never flag", () => {
    const events = [...normalTrace("t1"), ...normalTrace("t2"),
      ev({ id: "x1", trace_id: "t2", type: "policy.blocked" }),
      ev({ id: "x2", trace_id: "t2", type: "policy.blocked" })];
    const r = detectAnomalies(events, { now: NOW, minSamples: 3 });
    assert.equal(r.trace_count, 2);
    assert.equal(r.anomaly_count, 0);
    for (const b of Object.values(r.baselines)) assert.equal(b.stable, false);
  });

  test("constant (uniform fleet) never flags", () => {
    const events = [];
    for (let i = 0; i < 5; i++) events.push(...normalTrace(`u${i}`, 4));
    const r = detectAnomalies(events, { now: NOW });
    assert.equal(r.trace_count, 5);
    assert.equal(r.anomaly_count, 0);
    assert.equal(r.baselines.error_rate.scale, 0);
    assert.equal(r.baselines.error_rate.stable, false);
  });
});

describe("detectAnomalies — flagging", () => {
  test("flags a policy.blocked-volume spike against a calm baseline", () => {
    const events = [];
    for (let i = 0; i < 6; i++) events.push(...normalTrace(`c${i}`, 4));
    events.push(...normalTrace("spike", 4));
    for (let i = 0; i < 8; i++) events.push(ev({ id: `pb${i}`, trace_id: "spike", type: "policy.blocked" }));

    const r = detectAnomalies(events, { now: NOW });
    assert.equal(r.anomaly_count, 1);
    const a = r.anomalies[0];
    assert.equal(a.trace_id, "spike");
    assert.equal(a.metrics.policy_blocked_count, 8);
    const flag = a.flags.find((f) => f.metric === "policy_blocked_count");
    assert.ok(flag, "policy_blocked_count flag present");
    assert.ok(flag.score > 3.5);
  });

  test("flags an error-rate spike", () => {
    const events = [];
    for (let i = 0; i < 6; i++) events.push(...normalTrace(`ok${i}`, 5)); // 0 errors
    events.push(
      ev({ id: "f_a", trace_id: "bad", type: "task.created" }),
      ev({ id: "f_b", trace_id: "bad", type: "task.failed" }),
      ev({ id: "f_c", trace_id: "bad", type: "error.raised" }),
      ev({ id: "f_d", trace_id: "bad", type: "error.raised" })
    );
    const r = detectAnomalies(events, { now: NOW });
    const bad = r.anomalies.find((a) => a.trace_id === "bad");
    assert.ok(bad, "bad trace flagged");
    assert.equal(bad.metrics.error_count, 3);
    assert.ok(bad.flags.some((f) => f.metric === "error_rate"));
  });

  test("flags a latency spike (slowest operation)", () => {
    const events = [];
    for (let i = 0; i < 6; i++) {
      events.push(
        ev({ id: `g${i}_c`, trace_id: `g${i}`, type: "tool.called", time: "2026-06-01T00:00:00Z", payload: { tool: "x" } }),
        ev({ id: `g${i}_r`, trace_id: `g${i}`, type: "tool.result", time: "2026-06-01T00:00:01Z", causation_id: `g${i}_c` })
      );
    }
    events.push(
      ev({ id: "slow_c", trace_id: "slow", type: "tool.called", time: "2026-06-01T00:00:00Z", payload: { tool: "x" } }),
      ev({ id: "slow_r", trace_id: "slow", type: "tool.result", time: "2026-06-01T00:01:00Z", causation_id: "slow_c" })
    );
    const r = detectAnomalies(events, { now: NOW });
    const slow = r.anomalies.find((a) => a.trace_id === "slow");
    assert.ok(slow, "slow trace flagged");
    assert.equal(slow.metrics.latency_max_ms, 60000);
    assert.ok(slow.flags.some((f) => f.metric === "latency_max_ms"));
  });

  test("anomalies are ordered by max_score desc and capped by limit", () => {
    // A large calm baseline (10 traces, 0 policy.blocked) makes two spikes
    // (12 and 10) both clear outliers, with the bigger one ranked first.
    const events = [];
    for (let i = 0; i < 10; i++) events.push(...normalTrace(`n${i}`, 4));
    events.push(...normalTrace("big", 4));
    for (let i = 0; i < 12; i++) events.push(ev({ id: `big${i}`, trace_id: "big", type: "policy.blocked" }));
    events.push(...normalTrace("small", 4));
    for (let i = 0; i < 10; i++) events.push(ev({ id: `sm${i}`, trace_id: "small", type: "policy.blocked" }));

    const all = detectAnomalies(events, { now: NOW });
    assert.ok(all.anomaly_count >= 2);
    assert.equal(all.anomalies[0].trace_id, "big"); // larger spike first
    assert.ok(all.anomalies[0].max_score >= all.anomalies[1].max_score);
    const capped = detectAnomalies(events, { now: NOW, limit: 1 });
    assert.equal(capped.anomalies.length, 1);
    assert.equal(capped.anomaly_count, all.anomaly_count); // count is pre-cap
  });

  test("only the high side is flagged (a low metric is never an anomaly)", () => {
    const events = [];
    for (let i = 0; i < 6; i++) {
      events.push(...normalTrace(`h${i}`, 3));
      events.push(ev({ id: `h${i}_pb`, trace_id: `h${i}`, type: "policy.blocked" }));
    }
    events.push(...normalTrace("calm", 3)); // zero policy.blocked, below the baseline
    const r = detectAnomalies(events, { now: NOW });
    assert.equal(r.anomalies.find((a) => a.trace_id === "calm"), undefined);
  });
});
