"use strict";

/**
 * src/signature.js — HMAC-SHA256 event signature verification
 *
 * Protocol
 * --------
 * Emitters that have an HMAC secret configured for their API key sign each
 * event before submitting it.  The signature is attached as:
 *
 *   {
 *     "signature": {
 *       "alg":   "hmac-sha256",
 *       "value": "<base64-encoded HMAC digest>"
 *     },
 *     ...rest of envelope...
 *   }
 *
 * The digest is computed over the *canonical form* of the event: the envelope
 * JSON with the `signature` field removed and all top-level keys sorted
 * alphabetically before serialisation.  This makes the digest independent of
 * key insertion order across different emitter libraries.
 *
 * Canonical form algorithm (emitters must implement the same):
 *   1. Build the event object.
 *   2. Remove the `signature` key (it cannot sign itself).
 *   3. Collect all top-level key names and sort them alphabetically.
 *   4. JSON.stringify(event, sortedKeys) — this emits only the listed keys in
 *      the given order, with no extra whitespace.
 *   5. Compute HMAC-SHA256(canonical_string, secret).
 *   6. Base64-encode the raw digest bytes.
 *   7. Set signature.value to the result and signature.alg to "hmac-sha256".
 *
 * Example (Node.js emitter):
 *   const crypto = require('crypto');
 *   const event  = { specversion: '0.2.0', id: '…', … }; // no signature yet
 *   const keys   = Object.keys(event).filter(k => k !== 'signature').sort();
 *   const canon  = JSON.stringify(event, keys);
 *   const hmac   = crypto.createHmac('sha256', secret).update(canon, 'utf8').digest('base64');
 *   event.signature = { alg: 'hmac-sha256', value: hmac };
 *
 * Server behaviour
 * ----------------
 * • If the API key has no hmac_secret configured:
 *     → Signatures are IGNORED (accepted with or without).
 * • If the API key has an hmac_secret:
 *     → The event MUST include a valid signature field.
 *     → Missing or invalid signatures are rejected with HTTP 401.
 */

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce the canonical JSON string used as the HMAC input.
 * Removes the `signature` field and sorts all remaining top-level keys.
 *
 * @param {object} event  Full event envelope (may include `signature`).
 * @returns {string}      Deterministic JSON string.
 */
function canonicalize(event) {
  // Shallow copy so we don't mutate the caller's object.
  const copy = Object.assign({}, event);
  delete copy.signature;
  const sortedKeys = Object.keys(copy).sort();
  return JSON.stringify(copy, sortedKeys);
}

/**
 * Verify the HMAC-SHA256 signature on an event envelope.
 *
 * @param {object} event   Full event envelope including the `signature` field.
 * @param {string} secret  The HMAC secret associated with the API key.
 * @returns {{ valid: boolean, error?: string }}
 */
function verifySignature(event, secret) {
  const sig = event.signature;

  if (!sig || typeof sig !== "object") {
    return { valid: false, error: "Event is missing a 'signature' field" };
  }

  if (sig.alg !== "hmac-sha256") {
    return {
      valid: false,
      error: `Unsupported signature algorithm '${sig.alg}' — expected 'hmac-sha256'`
    };
  }

  if (!sig.value || typeof sig.value !== "string") {
    return { valid: false, error: "signature.value is missing or not a string" };
  }

  const canonical = canonicalize(event);
  const expected  = crypto
    .createHmac("sha256", secret)
    .update(canonical, "utf8")
    .digest("base64");

  try {
    const providedBuf = Buffer.from(sig.value,  "base64");
    const expectedBuf = Buffer.from(expected, "base64");

    if (providedBuf.length !== expectedBuf.length) {
      return { valid: false, error: "Signature mismatch" };
    }

    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false, error: "Signature mismatch" };
    }
  } catch (_) {
    return { valid: false, error: "Signature mismatch" };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { canonicalize, verifySignature };
