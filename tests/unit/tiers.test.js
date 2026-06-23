"use strict";

/**
 * Unit tests for subscription tier helpers.
 *
 * Covers:
 *   - tier validation
 *   - default tier definitions
 *   - environment variable overrides
 *   - tier policy resolution
 */

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  TIER_NAMES,
  DEFAULT_TIER,
  getTierDefinitions,
  getTierPolicy,
  isValidTier
} = require("../../src/tiers");

const ORIGINAL_ENV = { ...process.env };

// Keep environment changes isolated between tests.
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("tiers.isValidTier", () => {
  test("returns true for known tier names", () => {
    assert.equal(isValidTier("free"), true);
    assert.equal(isValidTier("team"), true);
    assert.equal(isValidTier("enterprise"), true);
  });

  test("returns false for unknown tier names", () => {
    assert.equal(isValidTier("premium"), false);
    assert.equal(isValidTier("basic"), false);
    assert.equal(isValidTier(""), false);
  });
});

describe("tiers constants", () => {
  test("exports the expected default tier", () => {
    assert.equal(DEFAULT_TIER, "free");
  });

  test("exports all supported tier names", () => {
    assert.deepEqual(TIER_NAMES, ["free", "team", "enterprise"]);
  });
});

describe("tiers.getTierDefinitions", () => {
  test("returns built-in defaults when no environment overrides exist", () => {
    const defs = getTierDefinitions();

    assert.equal(defs.free.event_quota, 100000);
    assert.equal(defs.free.retention_days, 30);

    assert.equal(defs.team.event_quota, 5000000);
    assert.equal(defs.team.retention_days, 90);

    assert.equal(defs.enterprise.event_quota, null);
    assert.equal(defs.enterprise.retention_days, null);
  });

  test("applies environment variable overrides", () => {
    process.env.TIER_FREE_EVENT_QUOTA = "123";
    process.env.TIER_TEAM_RETENTION_DAYS = "45";

    const defs = getTierDefinitions();

    assert.equal(defs.free.event_quota, 123);
    assert.equal(defs.team.retention_days, 45);
  });

  test("treats 'unlimited' as null", () => {
    process.env.TIER_ENTERPRISE_EVENT_QUOTA = "unlimited";
    process.env.TIER_ENTERPRISE_RETENTION_DAYS = "UNLIMITED";

    const defs = getTierDefinitions();

    assert.equal(defs.enterprise.event_quota, null);
    assert.equal(defs.enterprise.retention_days, null);
  });

  test("falls back to defaults for invalid values", () => {
    process.env.TIER_FREE_EVENT_QUOTA = "-10";
    process.env.TIER_FREE_RETENTION_DAYS = "not-a-number";

    const defs = getTierDefinitions();

    assert.equal(defs.free.event_quota, 100000);
    assert.equal(defs.free.retention_days, 30);
  });

  test("falls back to defaults for empty strings", () => {
    process.env.TIER_TEAM_EVENT_QUOTA = "";
    process.env.TIER_TEAM_RETENTION_DAYS = "";

    const defs = getTierDefinitions();

    assert.equal(defs.team.event_quota, 5000000);
    assert.equal(defs.team.retention_days, 90);
  });
});

describe("tiers.getTierPolicy", () => {
  test("returns policy for a valid tier", () => {
    const policy = getTierPolicy("team");

    assert.equal(policy.event_quota, 5000000);
    assert.equal(policy.retention_days, 90);
  });

  test("falls back to default tier for unknown tiers", () => {
    const policy = getTierPolicy("does-not-exist");

    assert.equal(policy.event_quota, 100000);
    assert.equal(policy.retention_days, 30);
  });

  test("respects environment overrides when resolving policies", () => {
    process.env.TIER_TEAM_EVENT_QUOTA = "999999";

    const policy = getTierPolicy("team");

    assert.equal(policy.event_quota, 999999);
  });
});