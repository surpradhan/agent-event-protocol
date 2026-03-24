"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { CORE_EVENT_TYPES } = require("../../src/coreEventTypes");

describe("CORE_EVENT_TYPES", () => {
  test("is a non-empty array", () => {
    assert.ok(Array.isArray(CORE_EVENT_TYPES));
    assert.ok(CORE_EVENT_TYPES.length > 0);
  });

  test("contains all 12 v0.2 types", () => {
    const expected = [
      "task.created",
      "task.updated",
      "task.completed",
      "task.failed",
      "tool.called",
      "tool.result",
      "memory.read",
      "memory.write",
      "handoff.started",
      "handoff.completed",
      "policy.blocked",
      "error.raised",
    ];
    assert.deepEqual(CORE_EVENT_TYPES, expected);
  });

  test("every entry is a dot-namespaced string", () => {
    for (const t of CORE_EVENT_TYPES) {
      assert.match(t, /^[a-z]+\.[a-z]+$/, `'${t}' does not match pattern`);
    }
  });

  test("has no duplicate entries", () => {
    const unique = new Set(CORE_EVENT_TYPES);
    assert.equal(unique.size, CORE_EVENT_TYPES.length);
  });
});
