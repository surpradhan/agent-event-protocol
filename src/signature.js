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
 *
 * NOTE: the algorithm above describes the **v1** (envelope-only) canonical form.
 * A deeper **v2** form that also covers nested payloads is now supported and
 * selected via the optional `signature.canon` marker — see the
 * "Canonicalization versions (issue #59)" block below and AUTH.md.
 */

const crypto = require("crypto");
const { canonicalize, canonicalizeV2 } = require("./_canonical");

// ---------------------------------------------------------------------------
// Canonicalization versions (issue #59)
// ---------------------------------------------------------------------------
//
// • v1 (legacy)  — `canonicalize`: envelope-only (array-replacer drops nested
//                  payloads). What today's server/Python/Node-SDK emitters use.
// • v2 (deep)    — `canonicalizeV2`: recursive key-sort over the WHOLE event,
//                  so the signature covers nested payloads too.
//
// Events MAY carry `signature.canon` to declare their form ("v1" | "v2"). The
// verifier below is version-aware AND backward-compatible:
//   - canon "v2" → verified against the deep form only
//   - canon "v1" → verified against the shallow form only
//   - canon absent → TRANSITION mode: accepted if it matches EITHER form. This
//     keeps every existing emitter working unchanged — legacy shallow emitters
//     (no marker) AND the current Go SDK, which already signs the deep form
//     without a marker (the latent interop bug from #59 now verifies). Both
//     forms are HMAC-keyed by the same secret, so accepting either is not a
//     security weakening; it only widens which canonical encoding is accepted.
//
// Migration: once emitters set `canon:"v2"`, the server can require it (reject
// v1/absent) to guarantee payload coverage. Tracked in issue #59.
//
// `canonicalize`/`canonicalizeV2` live in ./_canonical so the audit bundle path
// (src/audit.js) hashes events with the EXACT same v2 rule. Both are re-exported
// below for convenience.

const SUPPORTED_CANON = new Set(["v1", "v2"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the HMAC-SHA256 signature on an event envelope.
 *
 * On success the result also carries `canon` — the canonical form that
 * ACTUALLY verified ("v1" | "v2"). This is the *effective* form, which may
 * differ from any `signature.canon` marker in transition mode (an unmarked
 * signature is classified by whichever form matched). Callers that only read
 * `.valid`/`.error` are unaffected; observability (issue #65) uses `canon` to
 * see who is still relying on the legacy v1 form.
 *
 * @param {object} event   Full event envelope including the `signature` field.
 * @param {string} secret  The HMAC secret associated with the API key.
 * @returns {{ valid: boolean, canon?: "v1"|"v2", error?: string }}
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
  if (canon !== undefined && !SUPPORTED_CANON.has(canon)) {
    return {
      valid: false,
      error: `Unsupported signature canonicalization '${canon}' — expected 'v1' or 'v2'`
    };
  }

  // Choose which canonical form(s) to check based on the declared version.
  // Absent marker → try both (transition mode; see the header note).
  //
  // Timing note: in transition mode an unmarked event may run a second HMAC +
  // constant-time compare when the first form doesn't match. Each compare is
  // itself constant-time; the only thing the extra round can reveal is "the v1
  // form didn't match" — never key material or the secret — so it is not a
  // signature-forgery oracle. A marked sig ("v1"/"v2") only ever does one round.
  let candidateForms;
  if (canon === "v2") {
    candidateForms = [{ version: "v2", form: canonicalizeV2(event) }];
  } else if (canon === "v1") {
    candidateForms = [{ version: "v1", form: canonicalize(event) }];
  } else {
    candidateForms = [
      { version: "v1", form: canonicalize(event) },
      { version: "v2", form: canonicalizeV2(event) }
    ];
  }

  for (const { version, form } of candidateForms) {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(form, "utf8")
      .digest("base64");
    if (timingSafeEqualB64(sig.value, expected)) {
      // `canon` reports the EFFECTIVE form (what matched), not the marker. A
      // signature that only verifies under the shallow form is "v1" regardless
      // of marker — that is the population a strict-v2 server would reject.
      return { valid: true, canon: version };
    }
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

module.exports = { verifySignature, canonicalize, canonicalizeV2, SUPPORTED_CANON };
