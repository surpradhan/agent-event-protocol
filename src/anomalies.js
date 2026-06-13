"use strict";

/**
 * src/anomalies.js — workflow anomaly detection (Phase 15-D)
 *
 * Answers the PRD §Phase 15 item "Anomaly detection: alert when workflow deviates
 * from expected patterns" with an explicit, statistically-grounded definition of
 * *expected*:
 *
 *   A workflow (trace) is anomalous on a metric when its **robust modified
 *   z-score** for that metric exceeds a threshold (default 3.5 — the
 *   Iglewicz–Hoaglin cutoff), measured against the per-tenant cross-trace
 *   distribution over the supplied window.
 *
 * Why the *robust* (median / MAD) score rather than plain mean+stddev: a single
 * large spike inflates the standard deviation enough to mask itself, and the
 * common metrics here are sparse (most traces have zero policy.blocked / zero
 * errors). The median and the Median Absolute Deviation are insensitive to a few
 * outliers, so a genuine spike against a calm fleet is caught even with a modest
 * number of traces. When the MAD is zero (≥ half the traces share a value — common
 * for sparse counts) we fall back to the mean-absolute-deviation estimator, also
 * per Iglewicz–Hoaglin; only a perfectly constant metric yields no score at all.
 *
 * Three metrics are evaluated per trace (latency / error-rate / policy.blocked, the
 * loop's brief):
 *   - error_rate          — (task.failed + error.raised) / event_count
 *   - policy_blocked_count — number of policy.blocked events
 *   - latency_max_ms      — slowest paired operation (tool.called→tool.result,
 *                           task.created→task.completed|failed, matched by the end
 *                           event's causation_id), in milliseconds
 *
 * Only the HIGH side is flagged (a spike, positive score). The baseline needs at
 * least `minSamples` traces and a non-zero spread, else it is reported with
 * `stable: false` and never flags — so a handful of traces, or a perfectly uniform
 * fleet, produce no false positives.
 *
 * `detectAnomalies` is pure (no I/O, clock only via injected `now`): the storage
 * backend fetches the tenant-scoped, time-windowed raw envelopes (reusing
 * getEventsForQuery) and hands them here — the same fetch-then-shape split as the
 * sibling analytics modules.
 */

// Start→end operation pairing (mirrors src/performance.js): the end event's
// causation_id names its start; duration is the time delta in ms.
const END_TO_START = {
  "tool.result": "tool.called",
  "task.completed": "task.created",
  "task.failed": "task.created"
};
const ERROR_TYPES = new Set(["task.failed", "error.raised"]);

const DEFAULT_THRESHOLD = 3.5; // Iglewicz–Hoaglin modified-z cutoff
const DEFAULT_LIMIT = 50;
const DEFAULT_MIN_SAMPLES = 3;

// Consistency constants: a normal distribution's stddev ≈ 1.4826·MAD ≈
// 1.2533·meanAD, so these make the score comparable to a standard z.
const MAD_SCALE = 1.4826;
const MEAN_AD_SCALE = 1.2533;

/** Parse an event time to epoch ms, or null. */
function epochMs(t) {
  if (typeof t !== "string") return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

/** Median of a numeric array (returns 0 for empty). */
function median(values) {
  const n = values.length;
  if (n === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Robust dispersion estimate for a metric: a scale (≈ stddev) derived from the
 * MAD, falling back to the mean-absolute-deviation when the MAD is zero, and the
 * median. `scale` is 0 only for a perfectly constant metric.
 * @param {number[]} values
 * @returns {{ med: number, scale: number }}
 */
function robustScale(values) {
  const med = median(values);
  const absDev = values.map((v) => Math.abs(v - med));
  const mad = median(absDev);
  if (mad > 0) return { med, scale: MAD_SCALE * mad };
  // MAD === 0 (≥ half the values equal the median): use mean-absolute-deviation.
  const meanAD = absDev.length ? absDev.reduce((a, b) => a + b, 0) / absDev.length : 0;
  return { med, scale: meanAD > 0 ? MEAN_AD_SCALE * meanAD : 0 };
}

/** Map a robust-score distance to a coarse severity band. */
function severityFor(score) {
  if (score >= 8) return "critical";
  if (score >= 5) return "high";
  if (score >= 3.5) return "medium";
  return "low";
}

/**
 * Compute the slowest paired-operation duration (ms) within one trace's events.
 * @param {Array<object>} events
 * @returns {number} max duration in ms, or 0 if no operation pairs
 */
function maxOperationLatency(events) {
  const startsById = new Map();
  for (const e of events) {
    if (e && (e.type === "tool.called" || e.type === "task.created") && e.id !== undefined && e.id !== null) {
      startsById.set(e.id, e);
    }
  }
  let max = 0;
  for (const e of events) {
    const startType = e && END_TO_START[e.type];
    if (!startType) continue;
    const start =
      e.causation_id !== undefined && e.causation_id !== null ? startsById.get(e.causation_id) : undefined;
    if (!start || start.type !== startType) continue;
    const s = epochMs(start.time);
    const en = epochMs(e.time);
    if (s === null || en === null || en < s) continue;
    if (en - s > max) max = en - s;
  }
  return max;
}

/** Per-trace metrics from a trace's events. */
function traceMetrics(traceId, events) {
  let errorCount = 0;
  let policyBlocked = 0;
  for (const e of events) {
    if (e && ERROR_TYPES.has(e.type)) errorCount += 1;
    if (e && e.type === "policy.blocked") policyBlocked += 1;
  }
  const eventCount = events.length;
  return {
    trace_id: traceId,
    event_count: eventCount,
    error_count: errorCount,
    error_rate: eventCount > 0 ? errorCount / eventCount : 0,
    policy_blocked_count: policyBlocked,
    latency_max_ms: maxOperationLatency(events)
  };
}

// The metrics we baseline + flag, with the per-trace field they read.
const METRICS = [
  { key: "error_rate", field: "error_rate" },
  { key: "policy_blocked_count", field: "policy_blocked_count" },
  { key: "latency_max_ms", field: "latency_max_ms" }
];

/**
 * Detect anomalous workflows via the robust modified-z (median/MAD) rule.
 *
 * Pure: depends only on its inputs and the injected `now`. The caller scopes
 * (tenant) and windows (`since`/`until`) the events it passes.
 *
 * @param {Array<object>} events  event envelopes for the tenant/window (any order)
 * @param {{ now?: Date, threshold?: number, limit?: number, minSamples?: number }} [opts]
 * @returns {{
 *   threshold: number,
 *   trace_count: number,
 *   baselines: Record<string, { median, scale, value_threshold, sample_size, stable }>,
 *   anomalies: Array<object>,
 *   anomaly_count: number,
 *   generated_at: string
 * }}
 */
function detectAnomalies(events, { now = new Date(), threshold = DEFAULT_THRESHOLD, limit = DEFAULT_LIMIT, minSamples = DEFAULT_MIN_SAMPLES } = {}) {
  const list = Array.isArray(events) ? events : [];
  // These are defensive clamps for direct callers; over HTTP the route already
  // rejects threshold <= 0 (400) and validateQueryParams bounds limit to [1,1000],
  // so `cap === 0` (return-none) is only reachable from a direct in-process call.
  const cutoff = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_LIMIT;
  const minN = Number.isFinite(minSamples) && minSamples >= 2 ? Math.floor(minSamples) : DEFAULT_MIN_SAMPLES;

  // Group events by trace_id. Events with no (or a non-string) trace_id fold into
  // a single synthetic "(none)" bucket — treated as one trace, so it can itself be
  // baselined and flagged as `trace_id: "(none)"`. In practice every ingested event
  // carries a trace_id, so this is a defensive fold rather than an expected path.
  const byTrace = new Map();
  for (const e of list) {
    const tid = (e && typeof e.trace_id === "string" && e.trace_id) || "(none)";
    if (!byTrace.has(tid)) byTrace.set(tid, []);
    byTrace.get(tid).push(e);
  }

  const traces = [...byTrace.entries()].map(([tid, evs]) => traceMetrics(tid, evs));

  // Robust baseline (median + scale + raw-value threshold) per metric.
  const baselines = {};
  for (const m of METRICS) {
    const values = traces.map((t) => t[m.field]);
    const { med, scale } = robustScale(values);
    const stable = traces.length >= minN && scale > 0;
    baselines[m.key] = {
      median: med,
      scale,
      value_threshold: stable ? med + cutoff * scale : null,
      sample_size: traces.length,
      stable
    };
  }

  // Flag traces whose metric exceeds the high-side value threshold.
  const anomalies = [];
  for (const t of traces) {
    const flags = [];
    for (const m of METRICS) {
      const b = baselines[m.key];
      if (!b.stable) continue;
      const value = t[m.field];
      const score = (value - b.median) / b.scale;
      if (score > cutoff) {
        flags.push({
          metric: m.key,
          value,
          baseline_median: b.median,
          value_threshold: b.value_threshold,
          score,
          severity: severityFor(score)
        });
      }
    }
    if (flags.length) {
      const maxScore = Math.max(...flags.map((f) => f.score));
      anomalies.push({
        trace_id: t.trace_id,
        max_score: maxScore,
        severity: severityFor(maxScore),
        metrics: {
          event_count: t.event_count,
          error_count: t.error_count,
          error_rate: t.error_rate,
          policy_blocked_count: t.policy_blocked_count,
          latency_max_ms: t.latency_max_ms
        },
        flags
      });
    }
  }

  // Most anomalous first; ties broken by trace_id for determinism.
  anomalies.sort((a, b) => b.max_score - a.max_score || a.trace_id.localeCompare(b.trace_id));

  return {
    threshold: cutoff,
    trace_count: traces.length,
    baselines,
    anomalies: anomalies.slice(0, cap),
    anomaly_count: anomalies.length,
    generated_at: now.toISOString()
  };
}

module.exports = { detectAnomalies, median, robustScale, severityFor };
