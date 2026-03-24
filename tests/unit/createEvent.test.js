"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { createEvent } = require("../../src/createEvent");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(overrides = {}) {
  return {
    source: "agent://test",
    type: "task.created",
    session_id: "ses_test_001",
    trace_id: "trc_test_001",
    payload: { task: "do something" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe("createEvent — success cases", () => {
  test("returns an object with required envelope fields", () => {
    const event = createEvent(baseInput());
    assert.ok(typeof event === "object" && event !== null);
    assert.equal(event.specversion, "0.2.0");
    assert.ok(event.id.startsWith("evt_"), `id should start with 'evt_', got '${event.id}'`);
    assert.ok(typeof event.time === "string");
    assert.equal(event.source, "agent://test");
    assert.equal(event.type, "task.created");
    assert.equal(event.session_id, "ses_test_001");
    assert.equal(event.trace_id, "trc_test_001");
    assert.deepEqual(event.payload, { task: "do something" });
  });

  test("generates a unique id when none provided", () => {
    const a = createEvent(baseInput());
    const b = createEvent(baseInput());
    assert.notEqual(a.id, b.id, "Each call should produce a fresh id");
  });

  test("preserves a caller-supplied id", () => {
    const event = createEvent(baseInput({ id: "evt_custom_abc" }));
    assert.equal(event.id, "evt_custom_abc");
  });

  test("generates a time close to now when none provided", () => {
    const before = Date.now();
    const event = createEvent(baseInput());
    const after = Date.now();
    const ts = new Date(event.time).getTime();
    assert.ok(ts >= before && ts <= after + 50, "Generated time should be approximately now");
  });

  test("preserves a caller-supplied time", () => {
    const time = "2026-06-01T12:00:00.000Z";
    const event = createEvent(baseInput({ time }));
    assert.equal(event.time, time);
  });

  test("accepts all 12 core event types", () => {
    const types = [
      "task.created", "task.updated", "task.completed", "task.failed",
      "tool.called", "tool.result", "memory.read", "memory.write",
      "handoff.started", "handoff.completed", "policy.blocked", "error.raised",
    ];
    for (const type of types) {
      assert.doesNotThrow(() => createEvent(baseInput({ type })), `type '${type}' should not throw`);
    }
  });

  test("includes optional fields when provided", () => {
    const event = createEvent(
      baseInput({
        parent_session_id: "ses_parent",
        agent_role: "subagent",
        subject: "topic:foo",
        causation_id: "evt_cause",
        idempotency_key: "idem_xyz",
        labels: { env: "test" },
        extensions: { custom: true },
      })
    );
    assert.equal(event.parent_session_id, "ses_parent");
    assert.equal(event.agent_role, "subagent");
    assert.equal(event.subject, "topic:foo");
    assert.equal(event.causation_id, "evt_cause");
    assert.equal(event.idempotency_key, "idem_xyz");
    assert.deepEqual(event.labels, { env: "test" });
    assert.deepEqual(event.extensions, { custom: true });
  });

  test("omits optional fields that are undefined", () => {
    const event = createEvent(baseInput());
    assert.ok(!("parent_session_id" in event), "parent_session_id should be absent");
    assert.ok(!("agent_role" in event), "agent_role should be absent");
    assert.ok(!("causation_id" in event), "causation_id should be absent");
  });

  test("accepts all valid agent_role values", () => {
    for (const role of ["orchestrator", "subagent", "standalone"]) {
      assert.doesNotThrow(
        () => createEvent(baseInput({ agent_role: role })),
        `agent_role '${role}' should be accepted`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Error / rejection cases
// ---------------------------------------------------------------------------

describe("createEvent — error cases", () => {
  test("throws when input is null", () => {
    assert.throws(() => createEvent(null), /input is required/);
  });

  test("throws when input is not an object", () => {
    assert.throws(() => createEvent("string"), /input is required/);
    assert.throws(() => createEvent(42), /input is required/);
  });

  test("throws for unknown event type", () => {
    assert.throws(
      () => createEvent(baseInput({ type: "not.a.type" })),
      /Unsupported event type/
    );
  });

  test("throws for invalid agent_role", () => {
    assert.throws(
      () => createEvent(baseInput({ agent_role: "supervisor" })),
      /Invalid agent_role/
    );
  });
});
