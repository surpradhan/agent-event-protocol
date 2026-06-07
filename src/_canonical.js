"use strict";

/**
 * src/_canonical.js — the one canonical-JSON rule shared across AEP.
 *
 * AEP's HMAC signatures (both per-event signatures in `signature.js` and the
 * tamper-evident audit bundles in `audit.js`) hash a *canonical form* of an
 * object so the digest is independent of key insertion order across emitter
 * libraries and languages.
 *
 * Canonical form algorithm:
 *   1. Shallow-copy the object (never mutate the caller's value).
 *   2. Remove the `signature` key — a value cannot sign itself.
 *   3. Collect all top-level key names and sort them alphabetically.
 *   4. JSON.stringify(copy, sortedKeys) — emits only the listed keys, in the
 *      given order, with no extra whitespace.
 *
 * This was originally an internal helper in `signature.js`; it is lifted here so
 * the per-event signature path keeps using it with ZERO behavioural drift.  The
 * `canonicalize` implementation below is byte-for-byte the original.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * A subtlety worth knowing: `canonicalize` passes the sorted top-level key
 * names as JSON.stringify's *array replacer*.  An array replacer is a global key
 * whitelist applied at EVERY nesting level, so nested objects keep only keys
 * whose names happen to appear in that top-level list — in practice a `payload`
 * object serialises as `{}`.  The per-event HMAC signature therefore covers the
 * envelope, not the nested payload.  Changing that would break cross-SDK
 * signature parity (Python/Go/Node emitters all implement the same rule) and is
 * out of scope here, so `canonicalize` is preserved exactly.
 *
 * For the Phase 14 audit bundle the PRD requires that "any post-hoc modification
 * to the event payload or ordering is detectable" — i.e. the digest MUST cover
 * nested payloads.  `stableStringify` below provides that: a deterministic
 * serialization that recursively sorts keys at every level (so it is
 * order-independent like `canonicalize`) WITHOUT dropping nested content.  The
 * audit path (src/audit.js) uses `stableStringify`; the per-event signature path
 * keeps `canonicalize`.  Unifying the two (deepening the per-event signature
 * across all SDKs) is a candidate for a later PR.
 */

/**
 * Produce the canonical JSON string used as a per-event HMAC input.
 * Removes the `signature` field and sorts all remaining top-level keys.
 *
 * NOTE: uses an array replacer, so nested object contents are NOT included
 * (see the module header).  Preserved byte-for-byte for cross-SDK parity.
 *
 * @param {object} obj  Object to canonicalize (may include `signature`).
 * @returns {string}    Deterministic JSON string.
 */
function canonicalize(obj) {
  // Shallow copy so we don't mutate the caller's object.
  const copy = Object.assign({}, obj);
  delete copy.signature;
  const sortedKeys = Object.keys(copy).sort();
  return JSON.stringify(copy, sortedKeys);
}

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
 * @param {*} value  Any JSON-serialisable value.
 * @returns {string} Deterministic JSON string.
 */
function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

module.exports = { canonicalize, stableStringify, sortDeep };
