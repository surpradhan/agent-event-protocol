"use strict";

/**
 * Webhook payload signing (Phase 16-C).
 *
 * Every webhook gets a per-webhook signing secret at registration. When a
 * delivery is sent, the (canonical) request body is HMAC-SHA256-signed with that
 * secret and the digest is attached as an `X-AEP-Signature` header, so a receiver
 * can verify the delivery genuinely came from AEP and was not tampered with in
 * transit. This delivers PRD §Phase 16 "signing: webhook payloads are HMAC-signed
 * for verification".
 *
 * Crypto reuses the same primitive as the rest of the stack (HMAC-SHA256 over a
 * canonical JSON form, base64 digest — see src/signature.js / src/_canonical.js):
 *   • The delivery body is serialized with `stableStringify` (the deep, key-sorted
 *     canonical form), so the exact bytes sent are deterministic.
 *   • The signature is HMAC-SHA256(body_bytes, secret), base64-encoded.
 *   • Because the transmitted bytes ARE the canonical form, a receiver can verify
 *     simply by HMAC-ing the raw request body they received — no need to
 *     re-canonicalize. (verifyWebhookSignature does exactly this.)
 *
 * Header format:  X-AEP-Signature: hmac-sha256=<base64 digest>
 *
 * Replay note: the signed body includes a unique `delivery_id` and a
 * `delivered_at` timestamp, so a receiver can dedupe by delivery_id and reject a
 * stale delivered_at. (No separate timestamp header is used — the signed body
 * already carries both.)
 */

const crypto = require("crypto");

const ALG = "hmac-sha256";
const HEADER = "X-AEP-Signature";

/** Generate a new per-webhook signing secret (opaque, prefixed like API keys). */
function generateSigningSecret() {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

/** Compute the base64 HMAC-SHA256 digest of `body` (a string) under `secret`. */
function computeDigest(body, secret) {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

/** Build the `X-AEP-Signature` header value for a body + secret: `hmac-sha256=<b64>`. */
function buildSignatureHeader(body, secret) {
  return `${ALG}=${computeDigest(body, secret)}`;
}

/** Timing-safe comparison of two base64 strings; false (never throws) on mismatch. */
function timingSafeEqualB64(a, b) {
  try {
    const ba = Buffer.from(String(a), "base64");
    const bb = Buffer.from(String(b), "base64");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Verify an `X-AEP-Signature` header value against a raw body + secret.
 * Accepts the `hmac-sha256=<b64>` form (or a bare `<b64>` digest). Constant-time.
 *
 * @param {string} body         the raw request body bytes (as received)
 * @param {string} headerValue  the X-AEP-Signature header value
 * @param {string} secret       the webhook's signing secret
 * @returns {boolean}
 */
function verifyWebhookSignature(body, headerValue, secret) {
  if (typeof headerValue !== "string" || !secret) return false;
  // Strip an exact `hmac-sha256=` prefix if present; otherwise treat the value as
  // a bare base64 digest. (Don't split on the first `=` — base64 padding contains
  // `=`, which would corrupt a bare digest.)
  const prefix = `${ALG}=`;
  const provided = headerValue.startsWith(prefix)
    ? headerValue.slice(prefix.length).trim()
    : headerValue.trim();
  if (!provided) return false;
  const expected = computeDigest(body, secret);
  return timingSafeEqualB64(provided, expected);
}

module.exports = {
  ALG,
  HEADER,
  generateSigningSecret,
  computeDigest,
  buildSignatureHeader,
  verifyWebhookSignature
};
