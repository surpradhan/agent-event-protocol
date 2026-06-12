"use strict";

/**
 * src/analytics.js — policy-enforcement analytics (Phase 14 PR-D)
 *
 * Turns a set of `policy.blocked` events into the aggregates the compliance
 * story needs: *what did the agent refuse to do, and when?* (PRD §Phase 14).
 *
 * `summarizePolicyBlocked` is deliberately **pure** (no I/O, no clock except the
 * injected `now`): the storage backend fetches the raw `policy.blocked` envelopes
 * — already tenant-scoped and time-windowed in SQL — and hands them here for
 * shaping.  Keeping the aggregation out of SQL means the SQLite and Postgres
 * backends only need a trivial, dialect-identical SELECT (no `json_extract` vs
 * `->>` divergence), and the shaping logic is unit-testable against fabricated
 * events with zero database.
 *
 * `policy.blocked` payload shape (see tests/fixtures/valid/policy-blocked.json):
 *   { policy: string, reason: string, action_blocked: string }
 * All three are optional in the schema, so each breakdown folds a missing/blank
 * value into a single explicit bucket rather than dropping the event.
 */

// Bucket label used when a payload field (policy / action_blocked) or the event
// source is missing or blank — so every event is counted exactly once and the
// breakdown totals always equal `total`.
const UNSPECIFIED = "(unspecified)";

/**
 * Coerce a value to a non-empty trimmed string, or fall back to `UNSPECIFIED`.
 * @param {*} v
 * @returns {string}
 */
function bucketKey(v) {
  return typeof v === "string" && v.trim() !== "" ? v : UNSPECIFIED;
}

/** Increment `map[key]`, initialising to 0. */
function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/**
 * Sort a `{ key: count }` breakdown into a descending-by-count array, ties broken
 * alphabetically so the output is deterministic (stable across runs/backends).
 * @param {Record<string, number>} map
 * @returns {Array<{ key: string, count: number }>}
 */
function rankBreakdown(map) {
  return Object.entries(map)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Summarize `policy.blocked` events into analytics aggregates.
 *
 * Pure: depends only on its inputs and the injected `now`.  The caller is
 * responsible for scoping (tenant) and time-windowing (`since`/`until`) the
 * `events` it passes; this function counts exactly what it is given.
 *
 * @param {Array<object>} events  policy.blocked event envelopes (any order)
 * @param {{ now?: Date, limit?: number }} [opts]
 *        now   — reference clock for `generated_at` (defaults to new Date())
 *        limit — max entries in the `recent` list (defaults to 20, clamped ≥ 0)
 * @returns {{
 *   total: number,
 *   by_policy: Array<{ key: string, count: number }>,
 *   by_action: Array<{ key: string, count: number }>,
 *   by_source: Array<{ key: string, count: number }>,
 *   by_day: Array<{ date: string, count: number }>,
 *   recent: Array<object>,
 *   generated_at: string
 * }}
 */
function summarizePolicyBlocked(events, { now = new Date(), limit = 20 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 20;

  const policyMap = {};
  const actionMap = {};
  const sourceMap = {};
  const dayMap = {};

  for (const ev of list) {
    const payload = ev && typeof ev.payload === "object" && ev.payload ? ev.payload : {};
    bump(policyMap, bucketKey(payload.policy));
    bump(actionMap, bucketKey(payload.action_blocked));
    bump(sourceMap, bucketKey(ev && ev.source));
    // Bucket by UTC calendar day (event.time is an ISO-8601 string; its first 10
    // chars are the YYYY-MM-DD date). Non-string / malformed times fold into one
    // explicit bucket rather than crashing or silently vanishing.
    const day =
      ev && typeof ev.time === "string" && ev.time.length >= 10
        ? ev.time.slice(0, 10)
        : UNSPECIFIED;
    bump(dayMap, day);
  }

  // Most-recent-first; lexicographic compare on ISO-8601 strings is chronological.
  const recent = [...list]
    .sort((a, b) => String(b && b.time).localeCompare(String(a && a.time)))
    .slice(0, cap)
    .map((ev) => {
      const payload = ev && typeof ev.payload === "object" && ev.payload ? ev.payload : {};
      return {
        id: (ev && ev.id) ?? null,
        time: (ev && ev.time) ?? null,
        source: (ev && ev.source) ?? null,
        session_id: (ev && ev.session_id) ?? null,
        trace_id: (ev && ev.trace_id) ?? null,
        agent_role: (ev && ev.agent_role) ?? null,
        policy: payload.policy ?? null,
        reason: payload.reason ?? null,
        action_blocked: payload.action_blocked ?? null
      };
    });

  const by_day = Object.entries(dayMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    total: list.length,
    by_policy: rankBreakdown(policyMap),
    by_action: rankBreakdown(actionMap),
    by_source: rankBreakdown(sourceMap),
    by_day,
    recent,
    generated_at: now.toISOString()
  };
}

module.exports = { summarizePolicyBlocked, UNSPECIFIED };
