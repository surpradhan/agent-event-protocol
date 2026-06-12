"use strict";

/**
 * src/performance.js — latency / performance profiling (Phase 15-A)
 *
 * Answers the PRD §Phase 15 question "latency breakdown per agent, per tool, per
 * event type" by turning a flat set of lifecycle events into *operations* — paired
 * (start → end) spans — and computing p50/p95/p99 latency percentiles over them,
 * sliced several ways.
 *
 * Two operation kinds are recognised, each paired by the end event's
 * `causation_id` pointing at the start event's `id` (the same correlation the
 * fixtures use — tool.result.causation_id == tool.called.id, etc.):
 *
 *   tool: tool.called  → tool.result                      (name = payload.tool)
 *   task: task.created → task.completed | task.failed     (status = completed|failed)
 *
 * Duration is `end.time - start.time` in milliseconds, computed purely from the
 * event `time` fields — no clock except the injected `now` (for `generated_at`).
 *
 * `summarizePerformance` is deliberately **pure** (no I/O): the storage backend
 * fetches the raw lifecycle envelopes — already tenant-scoped and time-windowed in
 * a trivial, dialect-identical SQL SELECT — and hands them here for shaping. This
 * mirrors src/analytics.js (PR-D): aggregation stays out of SQL so the SQLite and
 * Postgres backends stay byte-identical and the shaping logic is unit-testable
 * against fabricated events with zero database.
 *
 * Windowing caveat (documented, matches PR-D's lexicographic time model): an
 * operation is only counted when BOTH its start and end events fall inside the
 * fetched window, since pairing happens within the fetched set. End events whose
 * start is outside the window (or missing) are reported in `unmatched_ends`.
 */

// Bucket label for a missing/blank grouping key (tool name / source / session),
// so every operation is counted exactly once.
const UNSPECIFIED = "(unspecified)";

// The start events, keyed by the end event type that closes them.
const END_TO_START = {
  "tool.result": "tool.called",
  "task.completed": "task.created",
  "task.failed": "task.created"
};

/** Coerce to a non-empty trimmed string, else `UNSPECIFIED`. */
function bucketKey(v) {
  return typeof v === "string" && v.trim() !== "" ? v : UNSPECIFIED;
}

/** Parse an event `time` to epoch ms, or null if missing/unparseable. */
function epochMs(t) {
  if (typeof t !== "string") return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Nearest-rank percentile over an ascending-sorted numeric array.
 *
 * rank = ceil(p/100 * n); the value is the element at (rank - 1), clamped into
 * range. Nearest-rank (not interpolated) keeps every reported percentile an
 * actual observed sample and stays deterministic across runs/backends.
 *
 * @param {number[]} sorted  ascending-sorted durations
 * @param {number} p         percentile in (0,100]
 * @returns {number}
 */
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return sorted[idx];
}

/**
 * Compute latency stats over a list of durations (ms).
 * @param {number[]} durations
 * @returns {{ count: number, p50: number, p95: number, p99: number, min: number, max: number, mean: number }}
 */
function stats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  }
  const sum = sorted.reduce((acc, d) => acc + d, 0);
  return {
    count: n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round(sum / n)
  };
}

/**
 * Group operations by `keyFn` and compute stats per group, ranked by count
 * descending then key ascending (deterministic, mirrors analytics.rankBreakdown).
 * @param {Array<object>} ops
 * @param {(op: object) => string} keyFn
 * @returns {Array<{ key: string } & ReturnType<typeof stats>>}
 */
function groupStats(ops, keyFn) {
  const groups = new Map();
  for (const op of ops) {
    const key = keyFn(op);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(op.duration_ms);
  }
  return [...groups.entries()]
    .map(([key, durations]) => ({ key, ...stats(durations) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Project an operation to the public shape used in the `slowest` list. */
function projectOp(op) {
  return {
    kind: op.kind,
    op_type: op.op_type,
    name: op.name,
    source: op.source,
    session_id: op.session_id,
    trace_id: op.trace_id,
    status: op.status,
    duration_ms: op.duration_ms,
    started_at: op.started_at,
    ended_at: op.ended_at
  };
}

/**
 * Summarize lifecycle events into latency-profiling aggregates.
 *
 * Pure: depends only on its inputs and the injected `now`. The caller scopes
 * (tenant) and time-windows (`since`/`until`) the `events` it passes; this counts
 * exactly what it is given.
 *
 * @param {Array<object>} events  task / tool lifecycle event envelopes (any order)
 * @param {{ now?: Date, limit?: number }} [opts]
 *        now   — reference clock for `generated_at` (defaults to new Date())
 *        limit — max entries in the `slowest` list (defaults to 20, clamped >= 0)
 * @returns {{
 *   total_operations: number,
 *   unmatched_ends: number,
 *   overall: (ReturnType<typeof stats>) | null,
 *   by_tool: Array<object>,
 *   by_agent: Array<object>,
 *   by_session: Array<object>,
 *   by_operation: Array<object>,
 *   slowest: Array<object>,
 *   generated_at: string
 * }}
 */
function summarizePerformance(events, { now = new Date(), limit = 20 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 20;

  // Index start events (tool.called / task.created) by id for O(1) pairing.
  const startsById = new Map();
  for (const ev of list) {
    if (ev && (ev.type === "tool.called" || ev.type === "task.created") && ev.id !== undefined && ev.id !== null) {
      startsById.set(ev.id, ev);
    }
  }

  const ops = [];
  let unmatched = 0;

  for (const ev of list) {
    const startType = ev && END_TO_START[ev.type];
    if (!startType) continue; // not an end event

    const start =
      ev.causation_id !== undefined && ev.causation_id !== null
        ? startsById.get(ev.causation_id)
        : undefined;
    // Pair only when the start exists, is the right type, and both timestamps
    // parse to a non-negative duration. Anything else is an unmatched end.
    if (!start || start.type !== startType) {
      unmatched += 1;
      continue;
    }
    const startMs = epochMs(start.time);
    const endMs = epochMs(ev.time);
    if (startMs === null || endMs === null || endMs < startMs) {
      unmatched += 1;
      continue;
    }

    const kind = startType === "tool.called" ? "tool" : "task";
    const startPayload =
      start.payload && typeof start.payload === "object" ? start.payload : {};
    const endPayload = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
    ops.push({
      kind,
      op_type: `${startType}→${ev.type}`, // e.g. "tool.called→tool.result"
      // Tool ops carry a tool name (prefer the start envelope, fall back to end);
      // task ops have no tool name.
      name: kind === "tool" ? bucketKey(startPayload.tool ?? endPayload.tool) : null,
      // Attribute the operation to the start event's agent/session (where it began).
      source: bucketKey(start.source),
      session_id: bucketKey(start.session_id),
      trace_id: start.trace_id ?? ev.trace_id ?? null,
      status: ev.type === "task.failed" ? "failed" : "completed",
      duration_ms: endMs - startMs,
      started_at: start.time,
      ended_at: ev.time
    });
  }

  const toolOps = ops.filter((o) => o.kind === "tool");

  const slowest = [...ops]
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, cap)
    .map(projectOp);

  return {
    total_operations: ops.length,
    unmatched_ends: unmatched,
    overall: ops.length ? stats(ops.map((o) => o.duration_ms)) : null,
    by_tool: groupStats(toolOps, (o) => o.name),
    by_agent: groupStats(ops, (o) => o.source),
    by_session: groupStats(ops, (o) => o.session_id),
    by_operation: groupStats(ops, (o) => o.op_type),
    slowest,
    generated_at: now.toISOString()
  };
}

module.exports = { summarizePerformance, percentile, UNSPECIFIED };
