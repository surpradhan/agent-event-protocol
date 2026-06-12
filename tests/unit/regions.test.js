"use strict";

/**
 * Unit tests for the pure data-residency region helpers (Phase 14 PR-G).
 */

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  VALID_REGIONS,
  normalizeRegion,
  isValidRegion,
  getDeploymentRegion,
  isRegionEnforced
} = require("../../src/regions");

const ORIG = process.env.DATA_RESIDENCY_REGION;
afterEach(() => {
  if (ORIG === undefined) delete process.env.DATA_RESIDENCY_REGION;
  else process.env.DATA_RESIDENCY_REGION = ORIG;
});

describe("normalizeRegion", () => {
  test("canonicalizes recognized regions case-insensitively", () => {
    assert.equal(normalizeRegion("EU"), "EU");
    assert.equal(normalizeRegion("eu"), "EU");
    assert.equal(normalizeRegion("us"), "US");
    assert.equal(normalizeRegion("apac"), "APAC");
    assert.equal(normalizeRegion("Global"), "global");
    assert.equal(normalizeRegion("  EU  "), "EU");
  });
  test("null / undefined / empty → null (unspecified)", () => {
    assert.equal(normalizeRegion(null), null);
    assert.equal(normalizeRegion(undefined), null);
    assert.equal(normalizeRegion(""), null);
    assert.equal(normalizeRegion("   "), null);
  });
  test("unrecognized / wrong-type → undefined (invalid)", () => {
    assert.equal(normalizeRegion("mars"), undefined);
    assert.equal(normalizeRegion("EUR"), undefined);
    assert.equal(normalizeRegion(42), undefined);
    assert.equal(normalizeRegion({}), undefined);
  });
  test("VALID_REGIONS is the canonical set", () => {
    assert.deepEqual([...VALID_REGIONS], ["EU", "US", "APAC", "global"]);
  });
});

describe("isValidRegion", () => {
  test("accepts recognized regions and unspecified", () => {
    for (const r of ["EU", "us", "APAC", "global", null, undefined, ""]) {
      assert.equal(isValidRegion(r), true, `${r} should be valid`);
    }
  });
  test("rejects unrecognized values", () => {
    assert.equal(isValidRegion("mars"), false);
    assert.equal(isValidRegion(7), false);
  });
});

describe("getDeploymentRegion", () => {
  test("reads DATA_RESIDENCY_REGION, canonicalized", () => {
    process.env.DATA_RESIDENCY_REGION = "us";
    assert.equal(getDeploymentRegion(), "US");
  });
  test("null when unset or unrecognized", () => {
    delete process.env.DATA_RESIDENCY_REGION;
    assert.equal(getDeploymentRegion(), null);
    process.env.DATA_RESIDENCY_REGION = "nowhere";
    assert.equal(getDeploymentRegion(), null);
  });
});

describe("isRegionEnforced", () => {
  test("no requirement (null / global / invalid) is always enforced", () => {
    assert.equal(isRegionEnforced(null, "US"), true);
    assert.equal(isRegionEnforced("global", "US"), true);
    assert.equal(isRegionEnforced("mars", "US"), true); // invalid project region → nothing to enforce
  });
  test("a specific region is enforced only when the deployment matches", () => {
    assert.equal(isRegionEnforced("EU", "EU"), true);
    assert.equal(isRegionEnforced("EU", "US"), false);
    assert.equal(isRegionEnforced("EU", null), false); // deployment region unknown → not satisfied
  });
  test("defaults the deployment region to DATA_RESIDENCY_REGION", () => {
    process.env.DATA_RESIDENCY_REGION = "EU";
    assert.equal(isRegionEnforced("EU"), true);
    process.env.DATA_RESIDENCY_REGION = "US";
    assert.equal(isRegionEnforced("EU"), false);
  });
});
