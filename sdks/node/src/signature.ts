/**
 * HMAC-SHA256 event signing + verification.
 *
 * The canonical form is **identical across the Node, Python, and Go SDKs and the
 * server** (`src/signature.js`): shallow-copy the event, drop `signature`, sort
 * the top-level keys, and `JSON.stringify(copy, sortedKeys)` — the replacer-array
 * form emits only those keys, at every nesting level, with no extra whitespace.
 * A signature produced here verifies under the Python/Go verifiers and vice
 * versa (locked by a cross-language parity test).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { AEPEvent, SignatureResult } from "./types.js";

/** Produce the canonical JSON string used as the HMAC input. */
export function canonicalize(event: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...event };
  delete copy.signature;
  const sortedKeys = Object.keys(copy).sort();
  return JSON.stringify(copy, sortedKeys);
}

/**
 * Sign `event` in place with HMAC-SHA256 and return it. Attaches
 * `event.signature = { alg: "hmac-sha256", value: <base64> }`.
 */
export function signEvent(event: AEPEvent, secret: string): AEPEvent {
  const canonical = canonicalize(event);
  const value = createHmac("sha256", secret).update(canonical, "utf8").digest("base64");
  event.signature = { alg: "hmac-sha256", value };
  return event;
}

/**
 * Verify the HMAC-SHA256 signature on an event envelope. Never throws — all
 * failure paths return `{ valid: false, error }`. Uses a timing-safe compare.
 */
export function verifySignature(event: AEPEvent, secret: string): SignatureResult {
  const sig = event?.signature;
  if (!sig || typeof sig !== "object") {
    return { valid: false, error: "Event is missing a 'signature' field" };
  }
  if (sig.alg !== "hmac-sha256") {
    return {
      valid: false,
      error: `Unsupported signature algorithm '${sig.alg}' — expected 'hmac-sha256'`,
    };
  }
  if (!sig.value || typeof sig.value !== "string") {
    return { valid: false, error: "signature.value is missing or not a string" };
  }

  const canonical = canonicalize(event);
  const expected = createHmac("sha256", secret).update(canonical, "utf8").digest("base64");

  try {
    const providedBuf = Buffer.from(sig.value, "base64");
    const expectedBuf = Buffer.from(expected, "base64");
    if (providedBuf.length !== expectedBuf.length) {
      return { valid: false, error: "Signature mismatch" };
    }
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false, error: "Signature mismatch" };
    }
  } catch {
    return { valid: false, error: "Signature mismatch" };
  }

  return { valid: true };
}
