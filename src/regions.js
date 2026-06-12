"use strict";

/**
 * src/regions.js — data-residency region labels (Phase 14 PR-G)
 *
 * Scope (deliberately a *control*, not infrastructure)
 * ----------------------------------------------------
 * A project can declare the data-residency region its events should live in
 * (EU / US / APAC, or `global` for "no specific requirement"). The deployment
 * declares where its storage *actually* is via the `DATA_RESIDENCY_REGION` env.
 *
 * AEP does NOT route storage by region — a single deployment writes to one
 * backend. What this module provides is the **declaration + a mismatch signal**:
 * a project's `regionEnforced` flag is true only when its declared region is
 * satisfiable by this deployment (the regions match, or the project asks for
 * `global`/nothing). A false flag tells an operator the data is NOT physically in
 * the region the project requires — actual multi-region routing is an
 * infrastructure concern (separate ingest endpoints per region), out of scope
 * here. This honest framing is documented in `.env.example` and OPERATIONS.md.
 */

// Canonical region labels. `global` = no specific residency requirement.
const VALID_REGIONS = Object.freeze(["EU", "US", "APAC", "global"]);

// Case-insensitive lookup → canonical form.
const CANONICAL = new Map(VALID_REGIONS.map((r) => [r.toLowerCase(), r]));

/**
 * Normalize a region value to its canonical form, or return `undefined` if it is
 * not a recognized region. `null`/`undefined`/empty normalize to `null`
 * ("unspecified").
 *
 * @param {*} value
 * @returns {string|null|undefined} canonical region, `null` (unspecified), or
 *   `undefined` (invalid)
 */
function normalizeRegion(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return CANONICAL.get(trimmed.toLowerCase()) ?? undefined;
}

/**
 * True if `value` is an acceptable region input: unspecified (null/empty) or a
 * recognized region.
 * @param {*} value
 * @returns {boolean}
 */
function isValidRegion(value) {
  return normalizeRegion(value) !== undefined;
}

/**
 * The region this deployment's storage actually resides in, from the
 * `DATA_RESIDENCY_REGION` env var. `null` when unset or unrecognized.
 * @returns {string|null}
 */
function getDeploymentRegion() {
  const r = normalizeRegion(process.env.DATA_RESIDENCY_REGION);
  return r === undefined ? null : r;
}

/**
 * Whether a project's declared region is satisfied by this deployment.
 *
 * True when the project has no specific requirement (`null` or `global`), or when
 * the deployment's region matches the project's. False means the data does NOT
 * physically reside in the region the project requires — a signal, not a block.
 *
 * @param {string|null} projectRegion
 * @param {string|null} [deploymentRegion]  defaults to getDeploymentRegion()
 * @returns {boolean}
 */
function isRegionEnforced(projectRegion, deploymentRegion = getDeploymentRegion()) {
  const pr = normalizeRegion(projectRegion);
  // Invalid or no specific requirement → nothing to enforce, so "enforced" holds.
  if (pr === undefined || pr === null || pr === "global") return true;
  return pr === deploymentRegion;
}

module.exports = {
  VALID_REGIONS,
  normalizeRegion,
  isValidRegion,
  getDeploymentRegion,
  isRegionEnforced
};
