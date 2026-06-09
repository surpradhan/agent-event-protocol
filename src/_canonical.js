"use strict";

/**
 * src/_canonical.js — the one canonical-JSON rule shared across AEP.
 *
 * AEP's HMAC signatures (both per-event signatures in `signature.js` and the
 * tamper-evident audit bundles in `audit.js`) hash a *canonical form* of an
 * object so the digest is independent of key insertion order across emitter
 * libraries and languages, AND covers nested payloads so any post-hoc tampering
 * is detectable.
 *
 * Canonical form algorithm (the v2, payload-covering rule):
 *   1. Shallow-copy the event (never mutate the caller's value).
 *   2. Remove the `signature` key — a value cannot sign itself.
 *   3. Recursively sort every object's keys alphabetically at every nesting
 *      level (arrays keep their order — order is semantically meaningful).
 *   4. JSON.stringify with no extra whitespace.
 *
 * `canonicalizeV2` is the per-event signature input (src/signature.js) and
 * `stableStringify` is the audit-bundle digest input (src/audit.js); both are
 * the same deep rule, so a v2 signature and the audit digest agree on what "the
 * canonical event" is.
 *
 * History (issue #65): there used to also be a shallow, envelope-only v1
 * `canonicalize` here (it dropped nested payloads via a JSON.stringify array
 * replacer) for the legacy per-event signature form. v1 was retired across the
 * server and all three SDKs; Phase E removed the v1 canonicalizer entirely, so
 * only the deep rule below remains.
 */

/**
 * Recursively sort object keys so two structurally-equal values always produce
 * the same JSON.  Arrays preserve order (order is semantically meaningful);
 * object key order is normalised.  Pure — does not mutate its input.
 *
 * Built on a null-prototype object on purpose: a normal `{}` has an inherited
 * `__proto__` accessor, so `out["__proto__"] = …` would set the prototype
 * instead of creating an own key — silently DROPPING a payload field literally
 * named `__proto__` (which `JSON.parse` produces as a real own property) from
 * the serialization, and thus from the tamper-evidence digest.  A null-prototype
 * object has no such accessor, so every own key — including `__proto__` — round-
 * trips faithfully.  (This also means no `Object.prototype` pollution.)
 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * Deterministic JSON serialization that covers the FULL nested structure.
 * Unlike `canonicalize`, nested payloads are included, so it is suitable for the
 * tamper-evident audit digest.  Order-independent for object keys; whitespace-free.
 *
 * Equality is JSON-*value* equality, not byte equality of any original source
 * text: it inherits `JSON.stringify` semantics, so `1` / `1.0` / `1e0` collapse
 * to `1`, an explicit `undefined` property is dropped (same as an absent one),
 * and `NaN` / `Infinity` become `null`. For audit bundles this is fine — the
 * events come from the store as already-parsed JSON, where those forms cannot
 * represent a meaningful difference an attacker could hide — but callers feeding
 * raw source text should be aware the digest proves value-integrity, not
 * byte-for-byte fidelity of the original encoding.
 *
 * @param {*} value  Any JSON-serialisable value.
 * @returns {string} Deterministic JSON string.
 */
function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

/**
 * Canonical form for a **v2** per-event signature (issue #59): drop the
 * `signature` field (a value cannot sign itself) and deep-stable-stringify the
 * rest, so the digest covers the FULL event including nested payloads. This is
 * the only per-event signature form the server accepts (issue #65 Phase E
 * removed the legacy envelope-only v1 form).
 *
 * This is the same deep rule the Phase 14 audit bundle already uses for its
 * per-event content digest — `audit.js` builds on this function — so a v2
 * signature and the audit digest agree on what "the canonical event" is.
 *
 * Cross-language note: byte-exactness of v2 across Node/Python/Go requires a
 * shared number-serialization rule (this reference impl uses ECMAScript
 * `JSON.stringify` semantics). Typical payloads (strings, integers, booleans,
 * nested objects/arrays) already agree; float edge cases (e.g. `1.0`, `1e-7`)
 * are where runtimes differ — the SDK emitters reconcile these (see issue #59).
 *
 * Marker coverage: the whole `signature` object is dropped before hashing, so
 * the `signature.canon` version marker is INTENTIONALLY outside HMAC coverage —
 * it's a verification *hint*, not an authenticated assertion. Stripping
 * `canon:"v2"` in flight cannot forge a signature without the secret; it only
 * makes the verifier reject the event (the server requires an explicit
 * `canon:"v2"` marker AND a matching deep HMAC).
 *
 * @param {object} event  Full event envelope (may include `signature`).
 * @returns {string}      Deterministic JSON string over the whole event.
 */
function canonicalizeV2(event) {
  const copy = Object.assign({}, event);
  delete copy.signature;
  return stableStringify(copy);
}

module.exports = { canonicalizeV2, stableStringify, sortDeep };
