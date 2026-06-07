"use strict";

/**
 * Regression lock for the canonicalize refactor (Phase 14 PR-A).
 *
 * `canonicalize` was lifted out of signature.js into src/_canonical.js so the
 * audit bundle path can reuse the EXACT same rule. These tests pin down the
 * canonical-form contract and the verifySignature round-trip so the refactor is
 * provably behaviour-preserving.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { verifySignature, canonicalize, canonicalizeV2 } = require("../../src/signature");
const { canonicalize: canonicalizeShared } = require("../../src/_canonical");

const SECRET = "shared-hmac-secret";

// Build an event signed with an explicit canonical form. `canon` controls the
// marker written onto signature.canon (pass null to OMIT the marker, simulating
// legacy/Go emitters); `form` is the canonicalizer used to compute the digest.
function makeSigned({ canon, form, secret = SECRET, mutate } = {}) {
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

function signedEvent(secret = SECRET) {
  const event = {
    specversion: "0.2.0",
    id: "evt_xyz",
    time: "2026-06-06T10:00:00.000Z",
    source: "agent://a",
    type: "task.created",
    session_id: "ses_1",
    trace_id: "trc_1",
    payload: { k: "v" },
  };
  const canon = canonicalize(event);
  event.signature = {
    alg: "hmac-sha256",
    value: crypto.createHmac("sha256", secret).update(canon, "utf8").digest("base64"),
  };
  return event;
}

describe("canonicalize", () => {
  test("signature.js re-exports the same function as _canonical.js", () => {
    assert.equal(canonicalize, canonicalizeShared);
  });

  test("sorts top-level keys and drops the signature field", () => {
    const out = canonicalize({ b: 2, a: 1, signature: { alg: "x", value: "y" } });
    assert.equal(out, '{"a":1,"b":2}');
  });

  test("is independent of key insertion order", () => {
    const a = canonicalize({ type: "t", id: "1", source: "s" });
    const b = canonicalize({ source: "s", type: "t", id: "1" });
    assert.equal(a, b);
  });

  test("does not mutate the caller's object", () => {
    const ev = { a: 1, signature: { alg: "x" } };
    canonicalize(ev);
    assert.deepEqual(ev, { a: 1, signature: { alg: "x" } });
  });
});

describe("verifySignature (behaviour unchanged after refactor)", () => {
  test("accepts a correctly signed event", () => {
    assert.deepEqual(verifySignature(signedEvent(), SECRET), { valid: true });
  });

  test("rejects when the secret is wrong", () => {
    const res = verifySignature(signedEvent(), "wrong");
    assert.equal(res.valid, false);
  });

  test("rejects an event with a tampered top-level field", () => {
    const ev = signedEvent();
    ev.source = "agent://impostor";
    assert.equal(verifySignature(ev, SECRET).valid, false);
  });

  test("documents the shallow-canonicalize limitation: nested payload edits are NOT detected", () => {
    // The per-event signature canonicalizes with an array replacer, which drops
    // nested object contents — so a payload-only edit does not change the digest.
    // This is preserved behaviour (cross-SDK parity); the Phase 14 audit bundle
    // uses a deep digest (stableStringify) to close this gap for compliance.
    const ev = signedEvent();
    ev.payload.k = "tampered";
    assert.equal(verifySignature(ev, SECRET).valid, true);
  });

  test("rejects a missing signature field", () => {
    const ev = signedEvent();
    delete ev.signature;
    const res = verifySignature(ev, SECRET);
    assert.equal(res.valid, false);
    assert.match(res.error, /missing a 'signature' field/);
  });

  test("rejects an unsupported algorithm", () => {
    const ev = signedEvent();
    ev.signature.alg = "rsa";
    const res = verifySignature(ev, SECRET);
    assert.equal(res.valid, false);
    assert.match(res.error, /Unsupported signature algorithm/);
  });
});

describe("verifySignature canonicalization versions (issue #59)", () => {
  test("v2 (deep, marker present) verifies and COVERS nested payload tampering", () => {
    const ev = makeSigned({ canon: "v2", form: canonicalizeV2 });
    assert.equal(verifySignature(ev, SECRET).valid, true);

    // The whole point of v2: a nested payload edit is now detected.
    const tampered = makeSigned({
      canon: "v2", form: canonicalizeV2,
      mutate: (e) => { e.payload.nested.deep = 999; },
    });
    assert.equal(verifySignature(tampered, SECRET).valid, false);
  });

  test("v1 (marker present) verifies against the shallow form only", () => {
    const ev = makeSigned({ canon: "v1", form: canonicalize });
    assert.equal(verifySignature(ev, SECRET).valid, true);
  });

  test("a v2-signed event with a v1 marker does NOT verify (version is honoured)", () => {
    // Signed deep, but mislabeled v1 → server checks shallow only → mismatch.
    const ev = makeSigned({ canon: "v1", form: canonicalizeV2 });
    assert.equal(verifySignature(ev, SECRET).valid, false);
  });

  test("unmarked legacy shallow signature still verifies (back-compat)", () => {
    const ev = makeSigned({ canon: null, form: canonicalize });
    assert.equal(verifySignature(ev, SECRET).valid, true);
  });

  test("unmarked DEEP signature verifies too (fixes the Go-SDK interop bug)", () => {
    // The Go SDK currently signs the deep form with NO marker; transition-mode
    // dual-verify must accept it.
    const ev = makeSigned({ canon: null, form: canonicalizeV2 });
    assert.equal(verifySignature(ev, SECRET).valid, true);
  });

  test("an unknown canon value is rejected with a clear error", () => {
    const ev = makeSigned({ canon: "v9", form: canonicalizeV2 });
    const res = verifySignature(ev, SECRET);
    assert.equal(res.valid, false);
    assert.match(res.error, /Unsupported signature canonicalization/);
  });

  test("the wrong secret fails for both v1 and v2", () => {
    assert.equal(verifySignature(makeSigned({ canon: "v1", form: canonicalize }), "nope").valid, false);
    assert.equal(verifySignature(makeSigned({ canon: "v2", form: canonicalizeV2 }), "nope").valid, false);
  });
});
