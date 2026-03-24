"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { validateEvent } = require("../../src/validator");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture(dir, filename) {
  const full = path.join(__dirname, "..", "fixtures", dir, filename);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function makeEvent(overrides = {}) {
  return {
    specversion: "0.2.0",
    id: "evt_test_001",
    time: "2026-01-01T10:00:00Z",
    source: "agent://test",
    type: "task.created",
    session_id: "ses_test_001",
    trace_id: "trc_test_001",
    payload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid events
// ---------------------------------------------------------------------------

describe("validateEvent — valid events", () => {
  test("returns valid:true for a minimal well-formed event", () => {
    const result = validateEvent(makeEvent());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
  });

  test("accepts all 12 core event types", () => {
    const types = [
      "task.created", "task.updated", "task.completed", "task.failed",
      "tool.called", "tool.result", "memory.read", "memory.write",
      "handoff.started", "handoff.completed", "policy.blocked", "error.raised",
    ];
    for (const type of types) {
      const result = validateEvent(makeEvent({ type }));
      assert.equal(result.valid, true, `type '${type}' should be valid`);
    }
  });

  test("accepts all valid agent_role values", () => {
    for (const role of ["orchestrator", "subagent", "standalone"]) {
      const result = validateEvent(makeEvent({ agent_role: role }));
      assert.equal(result.valid, true, `agent_role '${role}' should be valid`);
    }
  });

  test("valid fixture: task-created.json", () => {
    const event = loadFixture("valid", "task-created.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: task-completed.json", () => {
    const event = loadFixture("valid", "task-completed.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: tool-called.json", () => {
    const event = loadFixture("valid", "tool-called.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: tool-result.json", () => {
    const event = loadFixture("valid", "tool-result.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: error-raised.json", () => {
    const event = loadFixture("valid", "error-raised.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: memory-write.json", () => {
    const event = loadFixture("valid", "memory-write.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: handoff-started.json", () => {
    const event = loadFixture("valid", "handoff-started.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: policy-blocked.json", () => {
    const event = loadFixture("valid", "policy-blocked.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: task-updated.json", () => {
    const event = loadFixture("valid", "task-updated.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: task-failed.json", () => {
    const event = loadFixture("valid", "task-failed.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: memory-read.json", () => {
    const event = loadFixture("valid", "memory-read.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("valid fixture: handoff-completed.json", () => {
    const event = loadFixture("valid", "handoff-completed.json");
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("accepts optional fields without errors", () => {
    const event = makeEvent({
      parent_session_id: "ses_parent_001",
      causation_id: "evt_cause_001",
      idempotency_key: "idem_abc",
      subject: "topic:quarterly-report",
      labels: { env: "test" },
      extensions: { custom_key: "value" },
    });
    const result = validateEvent(event);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// Invalid events
// ---------------------------------------------------------------------------

describe("validateEvent — invalid events", () => {
  test("rejects null input", () => {
    const result = validateEvent(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  test("rejects empty object", () => {
    const result = validateEvent({});
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  test("rejects unknown event type", () => {
    const result = validateEvent(makeEvent({ type: "not.a.real.type" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("type must be one of")));
  });

  test("rejects bad specversion", () => {
    const result = validateEvent(makeEvent({ specversion: "1.0" }));
    assert.equal(result.valid, false);
  });

  test("rejects missing id", () => {
    const { id: _omit, ...event } = makeEvent();
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("rejects empty string id", () => {
    const result = validateEvent(makeEvent({ id: "" }));
    assert.equal(result.valid, false);
  });

  test("rejects missing time", () => {
    const { time: _omit, ...event } = makeEvent();
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("rejects malformed time (non-ISO-8601)", () => {
    const result = validateEvent(makeEvent({ time: "not-a-date" }));
    assert.equal(result.valid, false);
  });

  test("rejects missing source", () => {
    const { source: _omit, ...event } = makeEvent();
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("rejects missing session_id", () => {
    const { session_id: _omit, ...event } = makeEvent();
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("rejects missing trace_id", () => {
    const { trace_id: _omit, ...event } = makeEvent();
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("rejects missing payload", () => {
    const { payload: _omit, ...event } = makeEvent();
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("rejects invalid agent_role value", () => {
    const result = validateEvent(makeEvent({ agent_role: "supervisor" }));
    assert.equal(result.valid, false);
  });

  test("invalid fixture: missing-required-fields.json", () => {
    const event = loadFixture("invalid", "missing-required-fields.json");
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("invalid fixture: unknown-type.json", () => {
    const event = loadFixture("invalid", "unknown-type.json");
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("invalid fixture: bad-specversion.json", () => {
    const event = loadFixture("invalid", "bad-specversion.json");
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("invalid fixture: bad-time-format.json", () => {
    const event = loadFixture("invalid", "bad-time-format.json");
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("invalid fixture: bad-agent-role.json", () => {
    const event = loadFixture("invalid", "bad-agent-role.json");
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("invalid fixture: empty-id.json", () => {
    const event = loadFixture("invalid", "empty-id.json");
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });

  test("invalid fixture: missing-payload.json", () => {
    const event = loadFixture("invalid", "missing-payload.json");
    const result = validateEvent(event);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Deduplication / idempotency behaviour (via validateEvent result shape)
// ---------------------------------------------------------------------------

describe("validateEvent — error shape", () => {
  test("returns { valid, errors } structure", () => {
    const result = validateEvent(makeEvent());
    assert.ok("valid" in result, "result must have 'valid' key");
    assert.ok("errors" in result, "result must have 'errors' key");
    assert.ok(Array.isArray(result.errors), "'errors' must be an array");
  });

  test("errors array contains descriptive strings on failure", () => {
    const result = validateEvent(makeEvent({ type: "bad.type" }));
    assert.ok(result.errors.every(e => typeof e === "string"), "each error must be a string");
  });
});
