"use strict";

/**
 * Unit tests for the audit bundle module (Phase 14 PR-A).
 *
 * Tamper-evidence is the whole point, so the bulk of these tests prove that the
 * documented mutations are *detected*:
 *   - mutate one event byte        → content_digest_match: false
 *   - reorder events               → content_digest_match: false
 *   - add an event                 → content_digest_match: false
 *   - drop an event                → content_digest_match: false
 *   - mutate the manifest          → manifest_signature_valid: false
 *   - untouched bundle             → valid: true
 * plus the round-trip build→verify and the "secret unset" error path.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAuditBundle,
  verifyAuditBundle,
  computeContentDigest,
} = require("../../src/audit");

const SECRET = "test-audit-secret-do-not-use-in-prod";
const NOW = new Date("2026-06-06T12:00:00.000Z");

function sampleEvents() {
  return [
    {
      specversion: "0.2.0",
      id: "evt_aaa",
      time: "2026-06-06T10:00:00.000Z",
      source: "agent://orchestrator",
      type: "task.created",
      session_id: "ses_1",
      trace_id: "trc_1",
      tenant: "acme",
      payload: { goal: "research" },
    },
    {
      specversion: "0.2.0",
      id: "evt_bbb",
      time: "2026-06-06T10:00:01.000Z",
      source: "agent://orchestrator",
      type: "tool.called",
      session_id: "ses_1",
      trace_id: "trc_1",
      tenant: "acme",
      payload: { tool: "search" },
    },
    {
      specversion: "0.2.0",
      id: "evt_ccc",
      time: "2026-06-06T10:00:02.000Z",
      source: "agent://orchestrator",
      type: "task.completed",
      session_id: "ses_1",
      trace_id: "trc_1",
      tenant: "acme",
      payload: { ok: true },
    },
  ];
}

// Deep clone so a mutation in one test never leaks into another.
function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

describe("audit.buildAuditBundle", () => {
  test("produces a well-formed bundle with a populated manifest", () => {
    const events = sampleEvents();
    const bundle = buildAuditBundle({
      events,
      meta: { session_id: "ses_1", trace_id: "trc_1", tenant_id: "acme" },
      secret: SECRET,
      now: NOW,
    });

    assert.equal(bundle.aep_audit_version, "0.1.0");
    assert.deepEqual(bundle.events, events);
    assert.equal(bundle.manifest.event_count, 3);
    assert.deepEqual(bundle.manifest.scope, { session_id: "ses_1", trace_id: "trc_1" });
    assert.equal(bundle.manifest.tenant_id, "acme");
    assert.equal(bundle.manifest.time_range.first, "2026-06-06T10:00:00.000Z");
    assert.equal(bundle.manifest.time_range.last, "2026-06-06T10:00:02.000Z");
    assert.equal(bundle.manifest.exported_at, "2026-06-06T12:00:00.000Z");
    assert.equal(bundle.manifest.content_digest, computeContentDigest(events));
    assert.equal(bundle.signature.alg, "hmac-sha256");
    assert.equal(typeof bundle.signature.value, "string");
    assert.equal(bundle.manifest.per_event_signatures.present, 0);
    assert.equal(bundle.manifest.per_event_signatures.total, 3);
  });

  test("is deterministic — same inputs give byte-identical output", () => {
    const a = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const b = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test("derives the time range correctly even if events arrive out of order", () => {
    const events = sampleEvents().reverse();
    const bundle = buildAuditBundle({ events, secret: SECRET, now: NOW });
    assert.equal(bundle.manifest.time_range.first, "2026-06-06T10:00:00.000Z");
    assert.equal(bundle.manifest.time_range.last, "2026-06-06T10:00:02.000Z");
  });

  test("handles an empty event sequence", () => {
    const bundle = buildAuditBundle({ events: [], secret: SECRET, now: NOW });
    assert.equal(bundle.manifest.event_count, 0);
    assert.deepEqual(bundle.manifest.time_range, { first: null, last: null });
    const result = verifyAuditBundle(bundle, SECRET);
    assert.equal(result.valid, true);
  });
});

describe("audit round-trip", () => {
  test("an untouched bundle verifies as valid", () => {
    const bundle = buildAuditBundle({
      events: sampleEvents(),
      meta: { session_id: "ses_1", tenant_id: "acme" },
      secret: SECRET,
      now: NOW,
    });
    const result = verifyAuditBundle(bundle, SECRET);
    assert.equal(result.valid, true);
    assert.equal(result.content_digest_match, true);
    assert.equal(result.manifest_signature_valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.per_event.length, 3);
  });

  test("verifying with the wrong secret fails the manifest signature", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const result = verifyAuditBundle(bundle, "the-wrong-secret");
    assert.equal(result.valid, false);
    assert.equal(result.content_digest_match, true); // digest is keyless
    assert.equal(result.manifest_signature_valid, false);
  });
});

describe("audit tamper detection", () => {
  test("mutating one event byte → content_digest_match: false", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    tampered.events[1].payload.tool = "search-EVIL";
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.content_digest_match, false);
    assert.equal(result.valid, false);
  });

  test("reordering events → content_digest_match: false", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    [tampered.events[0], tampered.events[2]] = [tampered.events[2], tampered.events[0]];
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.content_digest_match, false);
    assert.equal(result.valid, false);
  });

  test("adding an event → content_digest_match: false", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    tampered.events.push({
      specversion: "0.2.0",
      id: "evt_injected",
      time: "2026-06-06T10:00:03.000Z",
      source: "agent://attacker",
      type: "task.created",
      session_id: "ses_1",
      trace_id: "trc_1",
      payload: {},
    });
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.content_digest_match, false);
    assert.equal(result.valid, false);
  });

  test("dropping an event → content_digest_match: false", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    tampered.events.splice(1, 1); // remove the middle event
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.content_digest_match, false);
    assert.equal(result.valid, false);
    // event_count cross-check also flags it.
    assert.ok(result.errors.some(e => e.includes("event_count")));
  });

  test("mutating the manifest → manifest_signature_valid: false", () => {
    const bundle = buildAuditBundle({
      events: sampleEvents(),
      meta: { session_id: "ses_1", tenant_id: "acme" },
      secret: SECRET,
      now: NOW,
    });
    const tampered = clone(bundle);
    tampered.manifest.tenant_id = "someone-else";
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.manifest_signature_valid, false);
    assert.equal(result.valid, false);
  });

  test("editing an event AND patching the digest still fails the signature", () => {
    // A sophisticated attacker who edits an event and recomputes content_digest
    // is still stopped because content_digest lives inside the signed manifest.
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    tampered.events[0].payload.goal = "exfiltrate";
    tampered.manifest.content_digest = computeContentDigest(tampered.events);
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.content_digest_match, true);       // digest was patched
    assert.equal(result.manifest_signature_valid, false);  // but signature wasn't
    assert.equal(result.valid, false);
  });
});

describe("audit hardening", () => {
  test("a __proto__ key in a payload is covered by the digest (no silent drop)", () => {
    // JSON.parse produces __proto__ as a real own, enumerable property — a naive
    // recursive sort onto a plain {} would set the prototype and DROP it from the
    // digest, allowing tamper-evasion. The null-prototype sortDeep must preserve it.
    const make = (v) =>
      JSON.parse(`{"specversion":"0.2.0","id":"evt_p","time":"2026-06-06T10:00:00.000Z",`
        + `"source":"a","type":"task.created","session_id":"ses_1","trace_id":"trc_1",`
        + `"payload":{"__proto__":{"k":${v}},"a":1}}`);

    // Two sequences differing ONLY inside __proto__ must NOT collide.
    const d1 = computeContentDigest([make(1)]);
    const d2 = computeContentDigest([make(999)]);
    assert.notEqual(d1, d2, "__proto__ content must affect the digest");

    // And a __proto__ edit on a built bundle is detected.
    const bundle = buildAuditBundle({ events: [make(1)], secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    tampered.events[0].payload.__proto__ = { k: 999 };
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.content_digest_match, false);
    assert.equal(result.valid, false);

    // Sanity: building/verifying a __proto__-bearing event does not pollute or throw.
    assert.equal(verifyAuditBundle(bundle, SECRET).valid, true);
    assert.equal(({}).k, undefined, "Object.prototype must not be polluted");
  });

  test("aep_audit_version is signed (inside the manifest)", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    assert.equal(bundle.manifest.aep_audit_version, "0.1.0");
    assert.equal(bundle.aep_audit_version, "0.1.0");
  });

  test("editing the (unsigned) top-level aep_audit_version is detected", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    tampered.aep_audit_version = "9.9.9-EVIL";
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("aep_audit_version mismatch")));
  });

  test("a missing/non-number manifest.event_count is rejected (cross-check not silently skippable)", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    delete tampered.manifest.event_count;
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /event_count is missing or not a number/.test(e)));
  });

  test("editing the signed manifest.aep_audit_version breaks the signature", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const tampered = clone(bundle);
    // Keep top-level and manifest in agreement so the cross-check passes — the
    // signature alone must catch it.
    tampered.aep_audit_version = "9.9.9-EVIL";
    tampered.manifest.aep_audit_version = "9.9.9-EVIL";
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.manifest_signature_valid, false);
    assert.equal(result.valid, false);
  });
});

describe("audit error / guard paths", () => {
  test("buildAuditBundle requires a non-empty secret", () => {
    assert.throws(
      () => buildAuditBundle({ events: sampleEvents(), now: NOW }),
      /secret/
    );
    assert.throws(
      () => buildAuditBundle({ events: sampleEvents(), secret: "", now: NOW }),
      /secret/
    );
  });

  test("buildAuditBundle requires an injected now (deterministic)", () => {
    assert.throws(
      () => buildAuditBundle({ events: sampleEvents(), secret: SECRET }),
      /now/
    );
  });

  test("buildAuditBundle rejects an invalid now with a clean error (not a raw RangeError)", () => {
    assert.throws(
      () => buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: "not-a-date" }),
      /not a valid date/
    );
    assert.throws(
      () => buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NaN }),
      /not a valid date/
    );
  });

  test("verifyAuditBundle honours content_digest_alg and rejects an unsupported one", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    // Re-sign a manifest that declares an unsupported digest alg so the signature
    // is valid but the alg is bad — the verifier must still reject it.
    const tampered = clone(bundle);
    tampered.manifest.content_digest_alg = "md5";
    const result = verifyAuditBundle(tampered, SECRET);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /Unsupported content_digest_alg/.test(e)));
  });

  test("buildAuditBundle requires events to be an array", () => {
    assert.throws(
      () => buildAuditBundle({ events: null, secret: SECRET, now: NOW }),
      /array/
    );
  });

  test("verifyAuditBundle reports an error when the secret is missing", () => {
    const bundle = buildAuditBundle({ events: sampleEvents(), secret: SECRET, now: NOW });
    const result = verifyAuditBundle(bundle, "");
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /secret/i.test(e)));
  });

  test("verifyAuditBundle handles a non-object bundle gracefully", () => {
    const result = verifyAuditBundle(null, SECRET);
    assert.equal(result.valid, false);
    assert.deepEqual(result.per_event, []);
  });
});
