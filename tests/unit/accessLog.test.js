"use strict";

/**
 * Unit tests for the access-log opt-in gate (Phase 14 PR-E).
 * The recorder middleware's DB write is covered by the integration suite; here we
 * pin the env-var parsing that decides whether anything is recorded at all.
 */

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { isAccessLogEnabled } = require("../../src/middleware/accessLog");

const ORIGINAL = process.env.ACCESS_LOG_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ACCESS_LOG_ENABLED;
  else process.env.ACCESS_LOG_ENABLED = ORIGINAL;
});

describe("isAccessLogEnabled", () => {
  test("unset → false (opt-in, off by default)", () => {
    delete process.env.ACCESS_LOG_ENABLED;
    assert.equal(isAccessLogEnabled(), false);
  });

  test("truthy values enable it (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "On"]) {
      process.env.ACCESS_LOG_ENABLED = v;
      assert.equal(isAccessLogEnabled(), true, `expected ${v} → true`);
    }
  });

  test("falsy / unrelated values keep it off", () => {
    for (const v of ["0", "false", "no", "off", "", "maybe"]) {
      process.env.ACCESS_LOG_ENABLED = v;
      assert.equal(isAccessLogEnabled(), false, `expected ${v} → false`);
    }
  });
});
