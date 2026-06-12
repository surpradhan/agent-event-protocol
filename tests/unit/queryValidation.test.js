"use strict";

/**
 * Unit tests for the query-param validation middleware helpers (issue #94).
 *
 * Focused on coerceArrayParams: Express parses a repeated query param
 * (?type=a&type=b) into an array, which throws when passed to a string method or
 * a SQL binding (→ 500). The middleware reduces every array param to its LAST
 * value (last wins) before any other check runs.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { coerceArrayParams } = require("../../src/middleware/queryValidation");

describe("coerceArrayParams", () => {
  test("reduces an array param to its last element (last wins)", () => {
    assert.deepEqual(coerceArrayParams({ type: ["a", "b", "c"] }), { type: "c" });
  });

  test("leaves a scalar string param untouched", () => {
    assert.deepEqual(coerceArrayParams({ type: "task.created" }), { type: "task.created" });
  });

  test("a single-element array collapses to that element", () => {
    assert.deepEqual(coerceArrayParams({ q: ["only"] }), { q: "only" });
  });

  test("normalizes every key independently (mixed scalar + array)", () => {
    assert.deepEqual(
      coerceArrayParams({ type: ["a", "b"], q: "scalar", format: ["x", "y"] }),
      { type: "b", q: "scalar", format: "y" }
    );
  });

  test("returns an empty object for empty / nullish input", () => {
    assert.deepEqual(coerceArrayParams({}), {});
    assert.deepEqual(coerceArrayParams(undefined), {});
    assert.deepEqual(coerceArrayParams(null), {});
  });

  test("returns a NEW object — does not mutate its input", () => {
    const input = { type: ["a", "b"] };
    const out = coerceArrayParams(input);
    assert.notEqual(out, input);
    assert.deepEqual(input, { type: ["a", "b"] }, "input is untouched");
  });

  test("preserves an empty-string value", () => {
    assert.deepEqual(coerceArrayParams({ q: "" }), { q: "" });
  });

  test("keeps the last value even when it is an empty string (?q=x&q=)", () => {
    assert.deepEqual(coerceArrayParams({ q: ["x", ""] }), { q: "" });
  });
});
