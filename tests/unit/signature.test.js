"use strict";

/**
 * Unit tests for the per-event HMAC signature verifier.
 *
 * Issue #65 Phase E retired the legacy v1 (envelope-only) canonical form and the
 * unmarked "transition" mode: `verifySignature(event, secret)` now accepts a
 * signature IFF it carries an explicit `canon:"v2"` marker AND verifies against
 * the deep, payload-covering v2 form (`canonicalizeV2`). Everything else — a v1
 * marker, an absent marker, an unmarked-but-deep-valid signature, an unknown or
 * non-string canon, a wrong secret, a payload edit — is rejected.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { verifySignature, canonicalizeV2 } = require("../../src/signature");

const SECRET = "shared-hmac-secret";

// Build an event signed over `form(event)`. `canon` controls the marker written
// onto signature.canon (omit / pass a non-string to simulate unmarked or
// type-confused emitters); `mutate` lets a test tamper with the event AFTER it
// is signed.
function makeSigned(opts = {}) {
  const { form = canonicalizeV2, secret = SECRET, mutate } = opts;
  // Distinguish an explicitly-omitted marker (`{ canon: undefined }`) from the
  // default — a plain default param can't, since passing `undefined` triggers it.
  const canon = "canon" in opts ? opts.canon : "v2";
  const event = {
    specversion: "0.2.0",
    id: "evt_xyz",
    time: "2026-06-06T10:00:00.000Z",
    source: "agent://a",
    type: "task.created",
    session_id: "ses_1",
    trace_id: "trc_1",
    payload: { k: "v", nested: { deep: 1 } },
  };
  const value = crypto.createHmac("sha256", secret).update(form(event), "utf8").digest("base64");
  event.signature = { alg: "hmac-sha256", value };
  if (typeof canon === "string") event.signature.canon = canon;
  if (mutate) mutate(event);
  return event;
}

describe("verifySignature — v2 acceptance (issue #65)", () => {
  test("a correctly signed canon:\"v2\" event is accepted, reporting canon 'v2'", () => {
    assert.deepEqual(verifySignature(makeSigned(), SECRET), { valid: true, canon: "v2" });
  });

  test("v2 COVERS nested-payload tampering (the whole point of the deep form)", () => {
    const tampered = makeSigned({ mutate: (e) => { e.payload.nested.deep = 999; } });
    const res = verifySignature(tampered, SECRET);
    assert.equal(res.valid, false);
    assert.equal(res.canon, undefined);
    assert.match(res.error, /Signature mismatch/);
  });

  test("a top-level field edit is detected", () => {
    const ev = makeSigned({ mutate: (e) => { e.source = "agent://impostor"; } });
    assert.equal(verifySignature(ev, SECRET).valid, false);
  });

  test("rejects when the secret is wrong (carries no canon)", () => {
    const res = verifySignature(makeSigned(), "wrong-secret");
    assert.equal(res.valid, false);
    assert.equal(res.canon, undefined);
    assert.match(res.error, /Signature mismatch/);
  });
});

describe("verifySignature — structural rejections", () => {
  test("rejects a missing signature field", () => {
    const ev = makeSigned();
    delete ev.signature;
    const res = verifySignature(ev, SECRET);
    assert.equal(res.valid, false);
    assert.match(res.error, /missing a 'signature' field/);
  });

  test("rejects an unsupported algorithm", () => {
    const ev = makeSigned();
    ev.signature.alg = "rsa";
    const res = verifySignature(ev, SECRET);
    assert.equal(res.valid, false);
    assert.match(res.error, /Unsupported signature algorithm/);
  });

  test("rejects a missing/non-string signature.value", () => {
    const ev = makeSigned();
    delete ev.signature.value;
    assert.equal(verifySignature(ev, SECRET).valid, false);
    ev.signature.value = 123;
    assert.equal(verifySignature(ev, SECRET).valid, false);
  });
});

describe("verifySignature — only canon:\"v2\" is accepted (v1 retired, issue #65 Phase E)", () => {
  test("a v1 marker is rejected with the migration hint (no HMAC computed)", () => {
    // The marker is checked before any HMAC, so the value is irrelevant.
    const ev = makeSigned({ canon: "v1" });
    const res = verifySignature(ev, SECRET);
    assert.equal(res.valid, false);
    assert.equal(res.canon, undefined);
    // The hint must fit in 99 chars (sanitizeInput truncates at 100) and name
    // the actionable fix.
    assert.ok(res.error.length <= 99, `error too long (${res.error.length}): ${res.error}`);
    assert.match(res.error, /canon:"v2"/);
    assert.match(res.error, /AEP SDK/);
  });

  test("an ABSENT marker is rejected — even when the deep HMAC would verify", () => {
    // A valid deep signature with NO canon marker (e.g. a pre-v0.3.0 Go emitter)
    // was accepted in transition mode; Phase E rejects it — the explicit marker
    // is now required.
    const ev = makeSigned({ canon: undefined, form: canonicalizeV2 });
    const res = verifySignature(ev, SECRET);
    assert.equal(res.valid, false);
    assert.ok(res.error.length <= 99, `error too long (${res.error.length}): ${res.error}`);
    assert.match(res.error, /canon:"v2"/);
  });

  test("an unknown canon value is rejected with an accurate 'unsupported' error (NOT a v1 claim)", () => {
    const ev = makeSigned({ canon: "v9" });
    const res = verifySignature(ev, SECRET);
    assert.equal(res.valid, false);
    assert.ok(res.error.length <= 99, `error too long (${res.error.length}): ${res.error}`);
    assert.match(res.error, /Unsupported canon/);
    assert.match(res.error, /v9/);
  });

  test("a non-string canon (number/null/object/array/bool/empty) is rejected, never throws", () => {
    for (const bad of [1, 0, true, false, null, [], {}, ""]) {
      const ev = makeSigned({ canon: undefined, form: canonicalizeV2 }); // valid deep sig
      ev.signature.canon = bad;                                          // inject a bad marker
      const res = verifySignature(ev, SECRET);
      assert.equal(res.valid, false, `canon=${JSON.stringify(bad)} should be invalid`);
      assert.equal(res.canon, undefined);
    }
  });

  test("a v2-marked but payload-tampered signature is rejected", () => {
    const ev = makeSigned({ canon: "v2", mutate: (e) => { e.payload.nested.deep = 999; } });
    assert.equal(verifySignature(ev, SECRET).valid, false);
  });
});
