"use strict";

/**
 * Example: verifying an AEP webhook delivery (Phase 16-C).
 *
 * When you register a webhook (POST /webhooks), the 201 response includes a
 * one-time `signing_secret` (shown only once). Store it. Every delivery AEP sends
 * to your endpoint carries an `X-AEP-Signature` header of the form:
 *
 *     X-AEP-Signature: hmac-sha256=<base64 digest>
 *
 * The digest is HMAC-SHA256 over the EXACT raw request body bytes, keyed by your
 * signing secret. To verify, recompute the HMAC over the raw body you received and
 * compare in constant time. Reject the delivery if it does not match — and dedupe
 * on the body's `delivery_id` / reject a stale `delivered_at` to guard replays.
 *
 * This example uses only Node's stdlib so you can drop it into any receiver.
 *
 *   node examples/verify-webhook-signature.js   # runs a tiny self-check
 */

const crypto = require("crypto");
const http = require("http");

/**
 * Verify an AEP webhook signature.
 * @param {string|Buffer} rawBody      the EXACT bytes of the request body
 * @param {string} signatureHeader     the `X-AEP-Signature` header value
 * @param {string} signingSecret       your webhook's signing secret (whsec_…)
 * @returns {boolean}
 */
function verifyAepWebhook(rawBody, signatureHeader, signingSecret) {
  if (typeof signatureHeader !== "string" || !signingSecret) return false;
  // Accept "hmac-sha256=<b64>" or a bare "<b64>". Strip the exact prefix only —
  // don't split on the first "=", since base64 padding itself contains "=".
  const prefix = "hmac-sha256=";
  const provided = signatureHeader.startsWith(prefix)
    ? signatureHeader.slice(prefix.length).trim()
    : signatureHeader.trim();
  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(rawBody)
    .digest("base64");
  try {
    const a = Buffer.from(provided, "base64");
    const b = Buffer.from(expected, "base64");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * A minimal receiver. NOTE: read the RAW body — do not let a JSON body-parser
 * re-serialize it, or the bytes (and thus the HMAC) will differ.
 */
function makeReceiver(signingSecret, onEvent) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const ok = verifyAepWebhook(rawBody, req.headers["x-aep-signature"], signingSecret);
      if (!ok) {
        res.writeHead(401).end("invalid signature");
        return;
      }
      const payload = JSON.parse(rawBody.toString("utf8"));
      if (onEvent) onEvent(payload);
      res.writeHead(200).end("ok");
    });
  });
}

module.exports = { verifyAepWebhook, makeReceiver };

// --- tiny self-check when run directly --------------------------------------
if (require.main === module) {
  const secret = "whsec_example_secret";
  const body = JSON.stringify({ delivery_id: "wd_1", event_type: "error.raised" });
  const sig = "hmac-sha256=" + crypto.createHmac("sha256", secret).update(body).digest("base64");
  console.log("valid signature verifies:", verifyAepWebhook(body, sig, secret) === true);
  console.log("tampered body rejected:  ", verifyAepWebhook(body + " ", sig, secret) === false);
  console.log("wrong secret rejected:   ", verifyAepWebhook(body, sig, "whsec_other") === false);
}
