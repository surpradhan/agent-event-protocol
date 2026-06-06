"use strict";

/**
 * src/middleware/quota.js — per-project event-quota enforcement (Phase 13 PR-C)
 *
 * A project carries an `event_quota` (max accepted events; NULL = unlimited).
 * On ingest (POST /events) we must refuse new events once a project is at or
 * over its quota.
 *
 * Hot-path concern
 * ----------------
 * Counting events in the database on *every* POST /events would add a query
 * (and, under Postgres, a network round-trip) to the busiest endpoint.  The
 * PR-C plan calls for an in-memory counter strategy instead.  This module keeps
 * a per-project cache of { usage, quota } that is:
 *
 *   • Seeded lazily from the DB the first time a project is seen (one COUNT) and
 *     then refreshed at most once per QUOTA_REFRESH_MS to absorb out-of-band
 *     writes (e.g. another node, or pruning in PR-D).
 *   • Incremented in-process whenever an event is actually accepted, so the
 *     check stays correct between refreshes without re-querying.
 *
 * This is deliberately a soft limit: with multiple server instances the cache
 * is per-process, so the effective ceiling can drift by up to one refresh
 * window × instance count.  For hard global enforcement a shared counter
 * (Redis / a DB upsert per ingest) would be required — out of scope for PR-C,
 * which establishes the data model + single-node enforcement.
 *
 * Environment variables
 * ---------------------
 * QUOTA_ENFORCEMENT   — "true" (default) | "false".  When false, quotas are
 *                       recorded but never block ingest (useful for staged
 *                       rollout).
 * QUOTA_REFRESH_MS    — how stale the cached usage may get before a re-count
 *                       (default: 10000).
 */

const db = require("../db");

const DEFAULT_REFRESH_MS = 10000;

// projectId -> { usage, quota, tenantId, fetchedAt }
const cache = new Map();

function enforcementEnabled() {
  return (process.env.QUOTA_ENFORCEMENT ?? "true").toLowerCase() !== "false";
}

function refreshMs() {
  const n = parseInt(process.env.QUOTA_REFRESH_MS ?? String(DEFAULT_REFRESH_MS), 10);
  return Number.isNaN(n) || n < 0 ? DEFAULT_REFRESH_MS : n;
}

/**
 * Load (or refresh) the cached usage/quota for a project.  Resolves the cache
 * entry, or null if the project does not exist (caller treats unknown projects
 * as unlimited so a misconfigured key never hard-fails ingest).
 *
 * @param {string} projectId
 * @returns {Promise<{ usage: number, quota: number|null, tenantId: string }|null>}
 */
async function loadProject(projectId) {
  const now = Date.now();
  const cached = cache.get(projectId);
  if (cached && now - cached.fetchedAt < refreshMs()) {
    return cached;
  }

  const project = await db.getProject(projectId);
  if (!project) {
    cache.delete(projectId);
    return null;
  }

  // event_quota === null means unlimited; skip the (potentially large) COUNT.
  const usage = project.event_quota === null || project.event_quota === undefined
    ? 0
    : await db.getProjectEventCount(project.tenant_id);

  const entry = {
    usage,
    quota: project.event_quota ?? null,
    tenantId: project.tenant_id,
    fetchedAt: now
  };
  cache.set(projectId, entry);
  return entry;
}

/**
 * Record that one event was accepted for a project, so the in-memory usage
 * stays correct between DB refreshes.  No-op if the project isn't cached yet.
 * @param {string} projectId
 */
function recordAccepted(projectId) {
  const entry = cache.get(projectId);
  if (entry) entry.usage += 1;
}

/**
 * Reset the cache.  Exposed for tests so each run starts clean.
 */
function _reset() {
  cache.clear();
}

/**
 * Express middleware: reject ingest with 429 once the calling key's project is
 * at or over its event quota.  Placed AFTER requireApiKey so req.project_id is
 * resolved.  Unlimited projects (quota === null) and unknown projects pass
 * through with no DB cost beyond the first lookup.
 *
 * @type {import('express').RequestHandler}
 */
async function enforceQuota(req, res, next) {
  if (!enforcementEnabled()) return next();

  const projectId = req.project_id || "default";

  let entry;
  try {
    entry = await loadProject(projectId);
  } catch (_err) {
    // Fail open: a quota-lookup failure must not take down ingest.
    return next();
  }

  // Unknown project or unlimited quota → allow.
  if (!entry || entry.quota === null) return next();

  if (entry.usage >= entry.quota) {
    res.setHeader("Retry-After", "3600");
    return res.status(429).json({
      accepted: false,
      error:    "Event quota exceeded for this project",
      quota:    entry.quota,
      usage:    entry.usage,
      project:  projectId
    });
  }

  next();
}

module.exports = { enforceQuota, recordAccepted, _reset };
