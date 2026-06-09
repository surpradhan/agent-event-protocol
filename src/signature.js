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
 *       "value": "<base64-encoded HMAC digest>",
 *       "canon": "v2"
 *     },
 *     ...rest of envelope...
 *   }
 *
 * The digest is computed over the **v2 canonical form** of the event: the whole
 * envelope (including nested payloads) with the `signature` field removed and
 * every object key — at every nesting level — sorted alphabetically before
 * serialisation. This makes the digest independent of key insertion order across
 * emitter libraries AND covers the payload, so any post-hoc tampering with a
 * signed event is detectable.
 *
 * Canonical form algorithm (emitters must implement the same — `canonicalizeV2`
 * in src/_canonical.js is the reference):
 *   1. Build the event object.
 *   2. Remove the `signature` key (it cannot sign itself).
 *   3. Recursively sort every object's keys alphabetically (arrays keep order).
 *   4. JSON.stringify with no extra whitespace.
 *   5. Compute HMAC-SHA256(canonical_string, secret).
 *   6. Base64-encode the raw digest bytes.
 *   7. Set signature.value to the result, signature.alg to "hmac-sha256", and
 *      signature.canon to "v2".
 *
 * Server behaviour
 * ----------------
 * • If the API key has no hmac_secret configured:
 *     → Signatures are IGNORED (accepted with or without).
 * • If the API key has an hmac_secret:
 *     → The event MUST include a valid signature field carrying `canon:"v2"`.
 *     → Missing, non-"v2", or invalid signatures are rejected with HTTP 401.
 *
 * History (issue #65): the server previously also accepted a legacy **v1**
 * (envelope-only) canonical form and an unmarked "transition" mode that tried
 * both. Those were retired in stages and removed entirely in Phase E — only the
 * payload-covering v2 form is accepted now. The published SDKs have defaulted to
 * v2 since `@surpradhan/aep@0.4.0` / PyPI `agent-event-protocol 0.3.0` / Go
 * `sdks/go/v0.3.0`.
 */

const crypto = require("crypto");
const { canonicalizeV2 } = require("./_canonical");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the HMAC-SHA256 signature on an event envelope.
 *
 * A signature is accepted IFF it carries an explicit `signature.canon === "v2"`
 * marker AND its value verifies against the deep, payload-covering v2 canonical
 * form (`canonicalizeV2`). Every other case is rejected:
 *   - missing/non-object `signature`         → invalid
 *   - `alg` other than "hmac-sha256"          → invalid
 *   - missing/non-string `signature.value`    → invalid
 *   - `canon` absent, "v1", or any non-"v2"   → invalid (with a migration hint)
 *   - deep HMAC mismatch (incl. payload edit) → invalid
 *
 * On success the result carries `canon: "v2"` (the effective form). Callers read
 * `.valid` / `.canon` / `.error`.
 *
 * Security note: the `canon` marker is outside HMAC coverage (a routing hint),
 * but requiring it is NOT a downgrade hole — acceptance STILL requires the deep
 * HMAC to verify, which an attacker cannot forge without the secret. Adding or
 * stripping a marker can't manufacture a valid deep signature.
 *
 * @param {object} event   Full event envelope including the `signature` field.
 * @param {string} secret  The HMAC secret associated with the API key.
 * @returns {{ valid: boolean, canon?: "v2", error?: string }}
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

  const canon = sig.canon;

  // The server requires payload-covering v2 signatures: accept ONLY an explicit
  // canon:"v2" marker (verified against the deep form below). Reject "v1",
  // absent, or any non-"v2" value here — INCLUDING an unmarked signature that
  // would once have verified deep (the legacy v1/transition path is gone, #65 E).
  //
  // Two-branch message: v1/absent emitters get the migration hint (explicit fix +
  // SDK upgrade); unknown canon gets an "unsupported" message rather than a
  // misleading "v1" claim. Both fit in 99 chars so sanitizeInput never truncates
  // the actionable text (there is a unit assertion on this).
  if (canon !== "v2") {
    const error = (canon === "v1" || canon === undefined)
      ? 'Signature must use canon:"v2" (payload-covering). Set canon:"v2" or upgrade your AEP SDK.'
      : `Unsupported canon '${String(canon).slice(0, 20)}' — only canon:"v2" is accepted.`;
    return { valid: false, error };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(canonicalizeV2(event), "utf8")
    .digest("base64");

  if (timingSafeEqualB64(sig.value, expected)) {
    return { valid: true, canon: "v2" };
  }

  return { valid: false, error: "Signature mismatch" };
}

/**
 * Timing-safe comparison of two base64 strings. Returns false (never throws) on
 * length mismatch or undecodable input.
 *
 * @param {string} providedB64
 * @param {string} expectedB64
 * @returns {boolean}
 */
function timingSafeEqualB64(providedB64, expectedB64) {
  try {
    const providedBuf = Buffer.from(providedB64, "base64");
    const expectedBuf = Buffer.from(expectedB64, "base64");
    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  verifySignature,
  canonicalizeV2
};
