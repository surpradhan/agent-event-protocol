"use strict";

/**
 * src/tiers.js — Subscription tier definitions (Phase 13 PR-C)
 *
 * A "project" is the unit that owns ingested data and carries a subscription
 * tier.  Each tier defines two policy knobs that the rest of the server
 * enforces:
 *
 *   event_quota     — the maximum number of accepted events the project may
 *                     store.  `null` means "unlimited".  Enforced on ingest
 *                     (POST /events → 429 once exceeded).
 *   retention_days  — how long events are retained.  `null` means "unlimited".
 *                     Not enforced here (a background pruning job lands in
 *                     PR-D); the value is stored on the project so the data
 *                     model is complete and PR-D can read it without a schema
 *                     change.
 *
 * Defaults mirror the PRD's Phase 13 tier table:
 *   - Free:       1 project, 30-day retention.  The PRD frames free as
 *                 "unlimited events … up to 5 GB storage"; since this repo
 *                 meters by event count (not bytes), we translate that to a
 *                 conservative finite event quota so the quota path is testable
 *                 and the free tier still has a guard rail.  Operators who want
 *                 byte-based metering can revisit in a later phase.
 *   - Team:       90-day retention, a larger event quota.
 *   - Enterprise: unlimited retention, unlimited events.
 *
 * Every default is overridable via environment variables so a deployment can
 * tune limits without a code change:
 *
 *   TIER_FREE_EVENT_QUOTA / TIER_FREE_RETENTION_DAYS
 *   TIER_TEAM_EVENT_QUOTA / TIER_TEAM_RETENTION_DAYS
 *   TIER_ENTERPRISE_EVENT_QUOTA / TIER_ENTERPRISE_RETENTION_DAYS
 *
 * A value of "unlimited" (case-insensitive) or an empty string maps to `null`.
 */

const TIER_NAMES = ["free", "team", "enterprise"];

const DEFAULT_TIER = "free";

// Built-in defaults (used when the matching env var is unset).
const BUILTIN_DEFAULTS = {
  free:       { event_quota: 100000,  retention_days: 30 },
  team:       { event_quota: 5000000, retention_days: 90 },
  enterprise: { event_quota: null,    retention_days: null }
};

/**
 * Parse a "limit" env value into a non-negative integer or null (= unlimited).
 * Empty string / "unlimited" / unset → fall back to `fallback`.
 * @param {string|undefined} raw
 * @param {number|null} fallback
 * @returns {number|null}
 */
function parseLimit(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  if (trimmed === "" ) return fallback;
  if (trimmed.toLowerCase() === "unlimited") return null;
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 0) return fallback;
  return n;
}

/**
 * Resolve the effective tier table, applying any environment overrides.
 * Read fresh each call so tests can toggle env vars without a module reload.
 * @returns {Record<string, { event_quota: number|null, retention_days: number|null }>}
 */
function getTierDefinitions() {
  const env = process.env;
  return {
    free: {
      event_quota:    parseLimit(env.TIER_FREE_EVENT_QUOTA,       BUILTIN_DEFAULTS.free.event_quota),
      retention_days: parseLimit(env.TIER_FREE_RETENTION_DAYS,    BUILTIN_DEFAULTS.free.retention_days)
    },
    team: {
      event_quota:    parseLimit(env.TIER_TEAM_EVENT_QUOTA,       BUILTIN_DEFAULTS.team.event_quota),
      retention_days: parseLimit(env.TIER_TEAM_RETENTION_DAYS,    BUILTIN_DEFAULTS.team.retention_days)
    },
    enterprise: {
      event_quota:    parseLimit(env.TIER_ENTERPRISE_EVENT_QUOTA, BUILTIN_DEFAULTS.enterprise.event_quota),
      retention_days: parseLimit(env.TIER_ENTERPRISE_RETENTION_DAYS, BUILTIN_DEFAULTS.enterprise.retention_days)
    }
  };
}

/**
 * Return true if `tier` is a recognised tier name.
 * @param {string} tier
 * @returns {boolean}
 */
function isValidTier(tier) {
  return TIER_NAMES.includes(tier);
}

/**
 * Resolve the policy (event_quota / retention_days) for a tier, applying env
 * overrides.  Unknown tiers fall back to the default tier so the server never
 * throws on a stale project row.
 * @param {string} tier
 * @returns {{ event_quota: number|null, retention_days: number|null }}
 */
function getTierPolicy(tier) {
  const defs = getTierDefinitions();
  return defs[tier] || defs[DEFAULT_TIER];
}

module.exports = {
  TIER_NAMES,
  DEFAULT_TIER,
  getTierDefinitions,
  getTierPolicy,
  isValidTier
};
