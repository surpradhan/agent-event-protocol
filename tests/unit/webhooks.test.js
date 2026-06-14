"use strict";

/**
 * Unit tests for webhook registration validation/normalization (src/webhooks.js).
 * Pure logic: event-type filter normalization (wildcard, subset, unknowns), the
 * create/update body validators, and the SSRF delegation for target_url.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateCreateWebhook,
  validateUpdateWebhook,
  normalizeEventTypes,
  MAX_EVENT_TYPES
} = require("../../src/webhooks");

describe("normalizeEventTypes", () => {
  test("omitted → wildcard", () => {
    assert.deepEqual(normalizeEventTypes(undefined), { ok: true, value: ["*"] });
    assert.deepEqual(normalizeEventTypes(null), { ok: true, value: ["*"] });
  });
  test("explicit wildcard alone is allowed", () => {
    assert.deepEqual(normalizeEventTypes(["*"]), { ok: true, value: ["*"] });
  });
  test("a valid subset is preserved and de-duplicated", () => {
    const r = normalizeEventTypes(["error.raised", "task.failed", "error.raised"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, ["error.raised", "task.failed"]);
  });
  test("non-array rejected", () => {
    assert.equal(normalizeEventTypes("error.raised").ok, false);
  });
  test("empty array rejected", () => {
    assert.equal(normalizeEventTypes([]).ok, false);
  });
  test("non-string members rejected", () => {
    assert.equal(normalizeEventTypes([1, 2]).ok, false);
  });
  test("unknown event types rejected", () => {
    const r = normalizeEventTypes(["error.raised", "bogus.type"]);
    assert.equal(r.ok, false);
    assert.match(r.error, /bogus\.type/);
  });
  test("wildcard cannot be mixed with explicit types", () => {
    const r = normalizeEventTypes(["*", "error.raised"]);
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot mix/);
  });
  test("too many types rejected", () => {
    const many = Array.from({ length: MAX_EVENT_TYPES + 1 }, (_, i) => `t${i}`);
    assert.equal(normalizeEventTypes(many).ok, false);
  });
});

describe("validateCreateWebhook", () => {
  test("happy path with defaults (wildcard, enabled)", () => {
    const r = validateCreateWebhook({ target_url: "https://hooks.example.com/x" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, {
      target_url: "https://hooks.example.com/x",
      event_types: ["*"],
      enabled: true
    });
  });

  test("normalizes target_url through the URL parser", () => {
    const r = validateCreateWebhook({ target_url: "https://hooks.example.com" });
    assert.equal(r.ok, true);
    assert.equal(r.value.target_url, "https://hooks.example.com/");
  });

  test("explicit event_types + disabled", () => {
    const r = validateCreateWebhook({
      target_url: "https://h.example.com/x",
      event_types: ["error.raised"],
      enabled: false
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.event_types, ["error.raised"]);
    assert.equal(r.value.enabled, false);
  });

  test("SSRF-blocked target rejected with reason", () => {
    const r = validateCreateWebhook({ target_url: "http://127.0.0.1/x" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /SSRF/.test(e)));
  });

  test("allowlisted private target accepted", () => {
    const r = validateCreateWebhook(
      { target_url: "http://127.0.0.1:9099/x" },
      { allowlist: "127.0.0.1:9099" }
    );
    assert.equal(r.ok, true);
  });

  test("accumulates multiple errors", () => {
    const r = validateCreateWebhook({ target_url: "ftp://x", event_types: [], enabled: "yes" });
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 3);
  });

  test("missing target_url rejected", () => {
    const r = validateCreateWebhook({});
    assert.equal(r.ok, false);
  });

  test("non-boolean enabled rejected", () => {
    const r = validateCreateWebhook({ target_url: "https://x.example.com", enabled: 1 });
    assert.equal(r.ok, false);
  });
});

describe("validateUpdateWebhook", () => {
  test("partial update of a single field", () => {
    const r = validateUpdateWebhook({ enabled: false });
    assert.deepEqual(r, { ok: true, value: { enabled: false } });
  });
  test("updating target_url re-validates SSRF", () => {
    assert.equal(validateUpdateWebhook({ target_url: "http://10.0.0.1/x" }).ok, false);
  });
  test("updating event_types normalizes", () => {
    const r = validateUpdateWebhook({ event_types: ["task.failed", "task.failed"] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.event_types, ["task.failed"]);
  });
  test("empty body rejected (no updatable fields)", () => {
    const r = validateUpdateWebhook({});
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /no updatable fields/);
  });
  test("invalid field still surfaces an error", () => {
    assert.equal(validateUpdateWebhook({ enabled: "nope" }).ok, false);
  });
});
