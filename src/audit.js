"use strict";

/**
 * src/audit.js — tamper-evident, HMAC-signed audit export bundles (Phase 14 PR-A)
 *
 * The first end-to-end slice of AEP's Compliance & Audit Suite.  It packages an
 * ordered sequence of events into a self-describing bundle whose integrity can
 * be verified offline, without the server or the original database.
 *
 * Tamper-evidence (NOT immutability)
 * ----------------------------------
 * A bundle carries two cryptographic checks, both built on AEP's canonical-JSON
 * + HMAC-SHA256 primitives (see src/_canonical.js):
 *
 *   1. content_digest — a SHA-256 over the deterministic serialization of the
 *      ordered event sequence.  Mutating any event byte (including nested
 *      payload fields), reordering events, or adding/dropping an event changes
 *      this digest.
 *   2. signature      — an HMAC-SHA256 over the canonical manifest, keyed by a
 *      server-side secret (AUDIT_SIGNING_SECRET).  Because content_digest lives
 *      inside the manifest, the signature transitively covers the events too,
 *      and the manifest itself (scope, counts, time range) cannot be edited
 *      without invalidating the signature.
 *
 * Canonicalization
 * ----------------
 * The audit path uses `stableStringify` (a deep, recursively key-sorted
 * serialization) — the same deep rule the per-event v2 signature uses
 * (`canonicalizeV2`; see src/_canonical.js).  The PRD requires payload
 * modification to be detectable, which mandates this deep form.
 *
 * This proves *detection* of post-hoc modification — it does not make storage
 * immutable.  WORM storage can be layered underneath for stricter requirements.
 * (This matches the PRD's framing for Phase 14.)
 *
 * Determinism
 * -----------
 * This module is pure and transport-neutral: it never reads the clock or the
 * environment.  Callers inject `now` and `secret`.  Given the same inputs it
 * always produces byte-identical output, which is what makes verification
 * possible.
 */

const crypto = require("crypto");
const { stableStringify, canonicalizeV2 } = require("./_canonical");

const AUDIT_VERSION = "0.1.0";

// Digest algorithms the bundle format understands. New bundles always use
// sha256; verification honours whatever the (signed) manifest declares, so the
// format can adopt a stronger digest later without silently mis-verifying.
const SUPPORTED_DIGEST_ALGS = new Set(["sha256", "sha512"]);
const DEFAULT_DIGEST_ALG = "sha256";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic serialization of a single event for the content digest. This is
 * exactly the v2 per-event canonical form (`canonicalizeV2`): drop the event's
 * own transport `signature` field (a value cannot sign itself, and whether the
 * event was signed in transit must not perturb the bundle digest), then
 * deep-stable-stringify the rest (envelope AND nested payload). Sharing the rule
 * means a v2 signature and the audit digest agree on "the canonical event".
 *
 * @param {object} event
 * @returns {string}
 */
function serializeEvent(event) {
  return canonicalizeV2(event);
}

/**
 * Canonical serialization of an ordered event sequence: each event serialized
 * deterministically, joined newline-delimited.  Newline-delimited canonical JSON
 * is deterministic and order-sensitive (reordering changes the string).
 *
 * @param {object[]} events  ordered events
 * @returns {string}
 */
function serializeEvents(events) {
  return events.map(serializeEvent).join("\n");
}

/**
 * Hex digest over the canonical serialization of the ordered events.
 * @param {object[]} events
 * @param {string} [alg="sha256"]  a member of SUPPORTED_DIGEST_ALGS
 * @returns {string} lowercase hex digest
 */
function computeContentDigest(events, alg = DEFAULT_DIGEST_ALG) {
  if (!SUPPORTED_DIGEST_ALGS.has(alg)) {
    throw new Error(`Unsupported content_digest_alg '${alg}'`);
  }
  return crypto
    .createHash(alg)
    .update(serializeEvents(events), "utf8")
    .digest("hex");
}

/**
 * HMAC-SHA256 (base64) over the canonical form of the manifest, keyed by secret.
 * @param {object} manifest
 * @param {string} secret
 * @returns {string} base64 digest
 */
function computeManifestSignature(manifest, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(stableStringify(manifest), "utf8")
    .digest("base64");
}

/**
 * Timing-safe comparison of two base64 strings.  Returns false (never throws)
 * on length mismatch or undecodable input.
 */
function timingSafeBase64Equal(a, b) {
  try {
    const ab = Buffer.from(String(a), "base64");
    const bb = Buffer.from(String(b), "base64");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch (_) {
    return false;
  }
}

/**
 * Derive the {first,last} time range from an ordered event sequence.  Does not
 * assume the events are pre-sorted — scans for the min/max ISO timestamp so the
 * range is correct regardless of input ordering.  Returns {first:null,last:null}
 * for an empty sequence.
 */
function computeTimeRange(events) {
  let first = null;
  let last = null;
  for (const e of events) {
    const t = e && e.time;
    if (typeof t !== "string") continue;
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;
  }
  return { first, last };
}

/**
 * Summarize the per-event transport signatures present on the events.  This is
 * informational only — the bundle's tamper-evidence comes from content_digest +
 * the manifest signature, not from these per-event signatures (which may be
 * absent if the emitter's API key had no HMAC secret).
 */
function summarizePerEventSignatures(events) {
  let present = 0;
  for (const e of events) {
    if (e && e.signature && typeof e.signature === "object") present += 1;
  }
  return { present, total: events.length };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a signed, tamper-evident audit bundle from an ordered event sequence.
 *
 * @param {object}   params
 * @param {object[]} params.events  ordered events to include (as returned by the
 *                                  read API; included verbatim in the bundle).
 * @param {object}   [params.meta]  scope/context metadata:
 *   { session_id?, trace_id?, tenant_id? } — at least one scope id is recommended.
 * @param {string}   params.secret  the audit signing secret (AUDIT_SIGNING_SECRET).
 * @param {Date|number|string} params.now  reference "now" for `exported_at`
 *                                  (injected — this module never reads the clock).
 * @returns {{ aep_audit_version: string, manifest: object, events: object[],
 *             signature: { alg: string, value: string } }}
 */
function buildAuditBundle({ events, meta = {}, secret, now } = {}) {
  if (!Array.isArray(events)) {
    throw new Error("buildAuditBundle: `events` must be an array");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      "buildAuditBundle: a non-empty `secret` is required (set AUDIT_SIGNING_SECRET)"
    );
  }
  if (now === undefined || now === null) {
    throw new Error("buildAuditBundle: `now` must be injected (deterministic export)");
  }
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error("buildAuditBundle: `now` is not a valid date");
  }

  const exportedAt = nowDate.toISOString();
  const contentDigest = computeContentDigest(events, DEFAULT_DIGEST_ALG);

  const scope = {};
  if (meta.session_id) scope.session_id = meta.session_id;
  if (meta.trace_id) scope.trace_id = meta.trace_id;

  const manifest = {
    // Signed so the bundle format version cannot be downgraded without detection
    // (the top-level copy below is for at-a-glance reading and is cross-checked
    // against this signed value at verify time).
    aep_audit_version: AUDIT_VERSION,
    scope,
    tenant_id: meta.tenant_id ?? null,
    event_count: events.length,
    time_range: computeTimeRange(events),
    content_digest: contentDigest,
    content_digest_alg: DEFAULT_DIGEST_ALG,
    exported_at: exportedAt,
    per_event_signatures: summarizePerEventSignatures(events),
  };

  // Phase 14 PR-G: when the deployment declares a storage region, record it in the
  // signed manifest so an exported bundle is self-describing about where the data
  // physically resided. Added only when provided, so bundles from deployments
  // without DATA_RESIDENCY_REGION are byte-identical to before (key order is
  // irrelevant — the manifest is signed over its deep-stable serialization).
  if (meta.data_residency_region) {
    manifest.data_residency_region = meta.data_residency_region;
  }

  const signature = {
    alg: "hmac-sha256",
    value: computeManifestSignature(manifest, secret),
  };

  return {
    aep_audit_version: AUDIT_VERSION,
    manifest,
    events,
    signature,
  };
}

/**
 * Verify a bundle offline.  Recomputes the content digest from `bundle.events`
 * and the manifest signature from `bundle.manifest`, comparing both timing-safe.
 *
 * @param {object} bundle  a bundle produced by buildAuditBundle (or tampered).
 * @param {string} secret  the audit signing secret.
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   content_digest_match: boolean,
 *   manifest_signature_valid: boolean,
 *   per_event: Array<{ index: number, id: string|undefined, signature_present: boolean }>
 * }}
 */
function verifyAuditBundle(bundle, secret, { now } = {}) {
  void now; // reserved for future not-before / not-after checks; unused today.
  const errors = [];

  if (!bundle || typeof bundle !== "object") {
    return {
      valid: false,
      errors: ["Bundle is not an object"],
      content_digest_match: false,
      manifest_signature_valid: false,
      per_event: [],
    };
  }
  if (typeof secret !== "string" || secret.length === 0) {
    return {
      valid: false,
      errors: ["A non-empty secret is required to verify (set AUDIT_SIGNING_SECRET)"],
      content_digest_match: false,
      manifest_signature_valid: false,
      per_event: [],
    };
  }

  const { manifest, events, signature } = bundle;
  const eventList = Array.isArray(events) ? events : [];

  if (!Array.isArray(events)) errors.push("Bundle is missing an `events` array");
  if (!manifest || typeof manifest !== "object") errors.push("Bundle is missing a `manifest` object");
  if (!signature || typeof signature !== "object") errors.push("Bundle is missing a `signature` object");

  // --- content digest check ---
  let contentDigestMatch = false;
  if (manifest && typeof manifest === "object") {
    // Honour the algorithm the (signed) manifest declares, defaulting to sha256
    // for older bundles that predate the field.
    const declaredAlg = manifest.content_digest_alg ?? DEFAULT_DIGEST_ALG;
    if (!SUPPORTED_DIGEST_ALGS.has(declaredAlg)) {
      errors.push(`Unsupported content_digest_alg '${declaredAlg}'`);
    } else {
      const recomputed = computeContentDigest(eventList, declaredAlg);
      contentDigestMatch =
        typeof manifest.content_digest === "string" &&
        manifest.content_digest.length === recomputed.length &&
        crypto.timingSafeEqual(
          Buffer.from(manifest.content_digest, "utf8"),
          Buffer.from(recomputed, "utf8")
        );
      if (!contentDigestMatch) {
        errors.push("content_digest does not match the bundled events (events were modified, reordered, added, or dropped)");
      }
    }
    // Cross-check the recorded event_count against the actual array length —
    // catches a dropped/added event even though the digest already would. A
    // missing/non-number count on an otherwise-populated manifest is itself an
    // error: defense-in-depth shouldn't be silently skippable by deleting it
    // (the manifest signature would catch the deletion too, but be explicit).
    if (typeof manifest.event_count !== "number") {
      errors.push("manifest.event_count is missing or not a number");
    } else if (manifest.event_count !== eventList.length) {
      errors.push(
        `manifest.event_count (${manifest.event_count}) does not match the number of bundled events (${eventList.length})`
      );
    }
  }

  // --- manifest signature check ---
  let manifestSignatureValid = false;
  if (manifest && typeof manifest === "object" && signature && typeof signature === "object") {
    if (signature.alg !== "hmac-sha256") {
      errors.push(`Unsupported signature algorithm '${signature.alg}' — expected 'hmac-sha256'`);
    } else if (typeof signature.value !== "string") {
      errors.push("signature.value is missing or not a string");
    } else {
      const expected = computeManifestSignature(manifest, secret);
      manifestSignatureValid = timingSafeBase64Equal(signature.value, expected);
      if (!manifestSignatureValid) {
        errors.push("manifest signature is invalid (manifest was modified or the wrong secret was used)");
      }
    }
  }

  // --- version cross-check ---
  // `aep_audit_version` is duplicated at the bundle top level for readability; the
  // signed copy lives inside the manifest. If the (unsigned) top-level value has
  // been edited to disagree with the signed one, flag it — this closes the
  // downgrade-attack surface for version-aware verifiers.
  if (
    manifest && typeof manifest === "object" &&
    bundle.aep_audit_version !== undefined &&
    bundle.aep_audit_version !== manifest.aep_audit_version
  ) {
    errors.push(
      `aep_audit_version mismatch: bundle '${bundle.aep_audit_version}' vs signed manifest '${manifest.aep_audit_version}'`
    );
  }

  const perEvent = eventList.map((e, index) => ({
    index,
    id: e && e.id,
    signature_present: !!(e && e.signature && typeof e.signature === "object"),
  }));

  return {
    valid: errors.length === 0 && contentDigestMatch && manifestSignatureValid,
    errors,
    content_digest_match: contentDigestMatch,
    manifest_signature_valid: manifestSignatureValid,
    per_event: perEvent,
  };
}

module.exports = {
  AUDIT_VERSION,
  buildAuditBundle,
  verifyAuditBundle,
  // exported for tests / reuse
  computeContentDigest,
  serializeEvents,
};
