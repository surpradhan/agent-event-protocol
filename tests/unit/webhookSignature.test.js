"use strict";

/**
 * Unit tests for webhook payload signing (src/webhookSignature.js) — Phase 16-C.
 * Secret generation, deterministic HMAC-SHA256 digest, header format, and
 * constant-time verification (valid / tampered / wrong-secret / malformed),
 * including a round-trip over the canonical (stableStringify) body and parity
 * with a hand-computed HMAC.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  generateSigningSecret,
  computeDigest,
  buildSignatureHeader,
  verifyWebhookSignature,
  ALG,
  HEADER
} = require("../../src/webhookSignature");
const { stableStringify } = require("../../src/_canonical");

describe("generateSigningSecret", () => {
  test("is prefixed and high-entropy", () => {
    const s = generateSigningSecret();
    assert.match(s, /^whsec_[0-9a-f]{64}$/);
  });
  test("is unique across calls", () => {
    const set = new Set(Array.from({ length: 50 }, generateSigningSecret));
    assert.equal(set.size, 50);
  });
});

describe("computeDigest / buildSignatureHeader", () => {
  test("matches a hand-computed HMAC-SHA256 base64 digest", () => {
    const body = '{"a":1}';
    const secret = "whsec_test";
    const expected = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
    assert.equal(computeDigest(body, secret), expected);
  });
  test("is deterministic for the same input and differs by secret", () => {
    const body = '{"x":true}';
    assert.equal(computeDigest(body, "s1"), computeDigest(body, "s1"));
    assert.notEqual(computeDigest(body, "s1"), computeDigest(body, "s2"));
  });
  test("header is alg=value", () => {
    const h = buildSignatureHeader("{}", "s");
    assert.ok(h.startsWith(`${ALG}=`));
    assert.equal(HEADER, "X-AEP-Signature");
    assert.equal(h, `${ALG}=${computeDigest("{}", "s")}`);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = generateSigningSecret();
  const body = stableStringify({ delivery_id: "wd_1", event: { id: "evt_1", type: "error.raised" } });
  const header = buildSignatureHeader(body, secret);

  test("accepts a valid header (alg=value form)", () => {
    assert.equal(verifyWebhookSignature(body, header, secret), true);
  });
  test("accepts a bare base64 digest (no alg= prefix)", () => {
    assert.equal(verifyWebhookSignature(body, computeDigest(body, secret), secret), true);
  });
  test("rejects a tampered body", () => {
    assert.equal(verifyWebhookSignature(body + " ", header, secret), false);
  });
  test("rejects the wrong secret", () => {
    assert.equal(verifyWebhookSignature(body, header, generateSigningSecret()), false);
  });
  test("rejects a malformed / empty / non-string header", () => {
    assert.equal(verifyWebhookSignature(body, "hmac-sha256=", secret), false);
    assert.equal(verifyWebhookSignature(body, "", secret), false);
    assert.equal(verifyWebhookSignature(body, undefined, secret), false);
    assert.equal(verifyWebhookSignature(body, "not base64 @@@", secret), false);
  });
  test("rejects when secret is missing", () => {
    assert.equal(verifyWebhookSignature(body, header, ""), false);
    assert.equal(verifyWebhookSignature(body, header, null), false);
  });
  test("round-trips a fresh secret + canonical body", () => {
    const s = generateSigningSecret();
    const b = stableStringify({ z: 1, a: 2, nested: { d: 4, c: 3 } });
    assert.equal(verifyWebhookSignature(b, buildSignatureHeader(b, s), s), true);
  });
});
