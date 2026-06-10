/**
 * HMAC-SHA256 event signing + verification.
 *
 * Two canonicalization versions are supported (issue #59):
 *
 * • **v2 (deep, default)** — `canonicalizeV2`: drop `signature`, then recursively
 *   key-sort the WHOLE event (envelope AND nested payloads) before HMAC, so the
 *   signature covers payload contents. This is the same deep rule the server
 *   verifier (`src/_canonical.js`) and the Phase 14 audit bundle use. v2
 *   signatures carry a `signature.canon: "v2"` marker. **This is now the default**
 *   so payload tamper-evidence is on without opt-in.
 *
 * • **v1 (legacy)** — `canonicalize`: shallow-copy the event, drop `signature`,
 *   sort the top-level keys, and `JSON.stringify(copy, sortedKeys)`. The
 *   replacer-array form emits only those keys at every nesting level, so nested
 *   objects are emptied (`payload` → `{}`). It is **identical across the Node,
 *   Python, and Go SDKs and the server** and is locked by a cross-language
 *   known-answer test. It covers the envelope but NOT nested payloads. Select it
 *   explicitly with `{ canon: "v1" }`.
 *
 * `signEvent` defaults to v2 (issue #59 default flip); pass `{ canon: "v1" }` to
 * sign the legacy envelope-only form. `verifySignature` is version-aware and
 * backward-compatible: it honours the `signature.canon` marker, and treats an
 * absent marker as transition mode (accept either form), matching the server.
 *
 * **Compatibility:** a v2-default emitter requires a v2-aware server (one that
 * includes server PR #60+). The current server requires v2 and rejects legacy v1
 * with `401` (issue #65, v1 retirement complete). `{ canon: "v1" }` is retained
 * only for talking to an older self-hosted server that predates `signature.canon`
 * support.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { AEPEvent, SignatureResult } from "./types.js";

/** Canonicalization versions understood by this module. */
const SUPPORTED_CANON = new Set(["v1", "v2"]);

/**
 * Produce the **v1** canonical JSON string (envelope-only; nested payloads are
 * emptied by the array-replacer form). Kept byte-identical for cross-SDK parity.
 */
export function canonicalize(event: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...event };
  delete copy.signature;
  const sortedKeys = Object.keys(copy).sort();
  return JSON.stringify(copy, sortedKeys);
}

/**
 * Recursively sort object keys so structurally-equal values serialize
 * identically. Arrays preserve order; object keys are normalised. Built on a
 * null-prototype accumulator so a payload key literally named `__proto__`
 * (which `JSON.parse` yields as a real own property) is preserved rather than
 * silently dropped via the prototype accessor — matching the server's
 * `src/_canonical.js`.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Produce the **v2** (deep) canonical JSON string covering the whole event
 * including nested payloads. Byte-identical to the server's `canonicalizeV2`.
 *
 * The whole `signature` object is dropped before hashing, so the
 * `signature.canon` marker is intentionally OUTSIDE HMAC coverage — a hint, not
 * an authenticated assertion (see issue #59 / AUTH.md).
 */
export function canonicalizeV2(event: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...event };
  delete copy.signature;
  return JSON.stringify(sortDeep(copy));
}

function digestFor(event: AEPEvent, canon: "v1" | "v2", secret: string): string {
  const canonical = canon === "v2" ? canonicalizeV2(event) : canonicalize(event);
  return createHmac("sha256", secret).update(canonical, "utf8").digest("base64");
}

/** Options for {@link signEvent}. */
export interface SignOptions {
  /** Canonicalization version: "v2" (default, deep, payload-covering) or "v1" (legacy, envelope-only). */
  canon?: "v1" | "v2";
}

/**
 * Sign `event` in place with HMAC-SHA256 and return it. Attaches
 * `event.signature = { alg: "hmac-sha256", value: <base64> }`. Defaults to v2
 * (deep): the signature covers nested payloads and a `canon: "v2"` marker is
 * added. Pass `{ canon: "v1" }` for the legacy envelope-only form (no marker).
 */
export function signEvent(event: AEPEvent, secret: string, opts: SignOptions = {}): AEPEvent {
  const canon = opts.canon ?? "v2";
  const value = digestFor(event, canon, secret);
  event.signature =
    canon === "v2" ? { alg: "hmac-sha256", value, canon: "v2" } : { alg: "hmac-sha256", value };
  return event;
}

/** Timing-safe base64 compare. Never throws; false on length mismatch / bad input. */
function timingSafeEqualB64(providedB64: string, expectedB64: string): boolean {
  try {
    const providedBuf = Buffer.from(providedB64, "base64");
    const expectedBuf = Buffer.from(expectedB64, "base64");
    if (providedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Verify the HMAC-SHA256 signature on an event envelope. Version-aware: honours
 * `signature.canon` ("v2" → deep only, "v1" → shallow only, absent → transition
 * mode that accepts either form). Never throws — all failure paths return
 * `{ valid: false, error }`. Uses a timing-safe compare.
 *
 * Timing note (mirrors the server's `src/signature.js`): in transition mode an
 * unmarked event may run a second HMAC + constant-time compare when the first
 * form doesn't match. Each compare is itself constant-time; the only thing the
 * extra round can reveal is "the v1 form didn't match" — never key material or
 * the secret — so it is not a signature-forgery oracle. A marked sig ("v1"/"v2")
 * only ever does one round.
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

  const canon = sig.canon;
  if (canon !== undefined && !SUPPORTED_CANON.has(canon as string)) {
    return {
      valid: false,
      error: `Unsupported signature canonicalization '${canon}' — expected 'v1' or 'v2'`,
    };
  }

  // Absent marker → transition mode: accept either form (legacy shallow emitters
  // and unmarked deep ones, e.g. the current Go SDK).
  const forms: Array<"v1" | "v2"> =
    canon === "v2" ? ["v2"] : canon === "v1" ? ["v1"] : ["v1", "v2"];

  for (const form of forms) {
    if (timingSafeEqualB64(sig.value, digestFor(event, form, secret))) {
      return { valid: true };
    }
  }
  return { valid: false, error: "Signature mismatch" };
}
