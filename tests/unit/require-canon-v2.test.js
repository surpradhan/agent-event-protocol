"use strict";

/**
 * Unit tests for requireCanonV2Enabled() — the env parser that decides whether
 * the server runs in strict mode (reject legacy v1 signatures).
 *
 * Issue #65 Phase D (BREAKING) flipped the default from off → ON: unset/empty
 * and any value that is NOT an explicit opt-out now enable strict mode. Only the
 * case-insensitive opt-out values false/0/no/off restore transition mode (v1
 * accepted). The flag is read per-request, so we just toggle process.env around
 * each assertion.
 */

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { requireCanonV2Enabled } = require("../../src/server");

describe("requireCanonV2Enabled (issue #65 Phase D — default strict)", () => {
  afterEach(() => { delete process.env.REQUIRE_CANON_V2; });

  test("unset → strict (true) — the new Phase D default", () => {
    delete process.env.REQUIRE_CANON_V2;
    assert.equal(requireCanonV2Enabled(), true);
  });

  test("empty / whitespace-only → strict (true)", () => {
    process.env.REQUIRE_CANON_V2 = "   ";
    assert.equal(requireCanonV2Enabled(), true);
  });

  test("explicit opt-out values (any case) → transition (false)", () => {
    for (const raw of ["false", "FALSE", "False", "0", "no", "NO", "off", "OFF", " off "]) {
      process.env.REQUIRE_CANON_V2 = raw;
      assert.equal(requireCanonV2Enabled(), false, `REQUIRE_CANON_V2=${JSON.stringify(raw)} should disable strict`);
    }
  });

  test("explicit enable values → strict (true)", () => {
    for (const raw of ["true", "1", "yes", "on", "TRUE"]) {
      process.env.REQUIRE_CANON_V2 = raw;
      assert.equal(requireCanonV2Enabled(), true, `REQUIRE_CANON_V2=${JSON.stringify(raw)} should enable strict`);
    }
  });

  test("any unrecognised value → strict (true) — fail closed", () => {
    for (const raw of ["maybe", "v2", "enabled", "2"]) {
      process.env.REQUIRE_CANON_V2 = raw;
      assert.equal(requireCanonV2Enabled(), true, `REQUIRE_CANON_V2=${JSON.stringify(raw)} should enable strict`);
    }
  });
});
