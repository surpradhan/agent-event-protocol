/**
 * Offline verification of tamper-evident audit bundles (Phase 14 add-on).
 *
 * Mirrors the server's `verifyAuditBundle` (`src/audit.js`): recompute the content
 * digest from the bundle's events and the HMAC signature from its manifest,
 * comparing both timing-safe. A compliance reviewer can verify a bundle produced
 * by `GET /sessions/:id/audit-bundle` (or `aep audit export`) entirely offline —
 * no server, no database — using only the bundle JSON and the audit signing
 * secret.
 *
 * Canonical forms are byte-identical to the server: events use the v2 deep
 * canonical form ({@link canonicalizeV2}) and the manifest uses the same deep,
 * recursively key-sorted JSON ({@link stableStringify}). Cross-language parity is
 * locked by a shared known-answer bundle fixture
 * (`tests/fixtures/audit/kat-bundle.json`) the server + Python/Go SDKs verify too.
 *
 * This module only **verifies** — building/signing bundles stays server-side (the
 * signing secret lives on the server).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalizeV2, stableStringify } from "./signature.js";

const SUPPORTED_DIGEST_ALGS = new Set(["sha256", "sha512"]);
const DEFAULT_DIGEST_ALG = "sha256";

/** Per-event summary entry in an {@link AuditVerification}. */
export interface AuditPerEvent {
  index: number;
  id: string | undefined;
  signature_present: boolean;
}

/** Result of {@link verifyAuditBundle}. */
export interface AuditVerification {
  valid: boolean;
  errors: string[];
  content_digest_match: boolean;
  manifest_signature_valid: boolean;
  per_event: AuditPerEvent[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(error: string): AuditVerification {
  return {
    valid: false,
    errors: [error],
    content_digest_match: false,
    manifest_signature_valid: false,
    per_event: [],
  };
}

function serializeEvents(events: unknown[]): string {
  return events.map((e) => canonicalizeV2(e as Record<string, unknown>)).join("\n");
}

function contentDigest(events: unknown[], alg: string): string {
  return createHash(alg).update(serializeEvents(events), "utf8").digest("hex");
}

function manifestSignature(manifest: unknown, secret: string): string {
  return createHmac("sha256", secret).update(stableStringify(manifest), "utf8").digest("base64");
}

/** Timing-safe base64 comparison; never throws on undecodable input. */
function timingSafeBase64Equal(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "base64");
    const bb = Buffer.from(b, "base64");
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Verify an audit bundle offline.
 *
 * @param bundle a bundle produced by the server's `buildAuditBundle` (or tampered).
 * @param secret the audit signing secret (`AUDIT_SIGNING_SECRET`).
 */
export function verifyAuditBundle(bundle: unknown, secret: string): AuditVerification {
  if (!isObject(bundle)) return fail("Bundle is not an object");
  if (typeof secret !== "string" || secret.length === 0) {
    return fail("A non-empty secret is required to verify (set AUDIT_SIGNING_SECRET)");
  }

  const manifest = bundle.manifest;
  const events = bundle.events;
  const signature = bundle.signature;
  const eventList: unknown[] = Array.isArray(events) ? events : [];

  const errors: string[] = [];
  if (!Array.isArray(events)) errors.push("Bundle is missing an `events` array");
  if (!isObject(manifest)) errors.push("Bundle is missing a `manifest` object");
  if (!isObject(signature)) errors.push("Bundle is missing a `signature` object");

  // --- content digest check ---
  let contentDigestMatch = false;
  if (isObject(manifest)) {
    const declaredAlg =
      typeof manifest.content_digest_alg === "string"
        ? manifest.content_digest_alg
        : DEFAULT_DIGEST_ALG;
    if (!SUPPORTED_DIGEST_ALGS.has(declaredAlg)) {
      errors.push(`Unsupported content_digest_alg '${declaredAlg}'`);
    } else {
      const recomputed = contentDigest(eventList, declaredAlg);
      const cd = manifest.content_digest;
      contentDigestMatch =
        typeof cd === "string" &&
        cd.length === recomputed.length &&
        timingSafeEqual(Buffer.from(cd, "utf8"), Buffer.from(recomputed, "utf8"));
      if (!contentDigestMatch) {
        errors.push(
          "content_digest does not match the bundled events (events were modified, reordered, added, or dropped)"
        );
      }
    }
    const ec = manifest.event_count;
    if (typeof ec !== "number") {
      errors.push("manifest.event_count is missing or not a number");
    } else if (ec !== eventList.length) {
      errors.push(
        `manifest.event_count (${ec}) does not match the number of bundled events (${eventList.length})`
      );
    }
  }

  // --- manifest signature check ---
  let manifestSignatureValid = false;
  if (isObject(manifest) && isObject(signature)) {
    if (signature.alg !== "hmac-sha256") {
      errors.push(
        `Unsupported signature algorithm '${String(signature.alg)}' — expected 'hmac-sha256'`
      );
    } else if (typeof signature.value !== "string") {
      errors.push("signature.value is missing or not a string");
    } else {
      const expected = manifestSignature(manifest, secret);
      manifestSignatureValid = timingSafeBase64Equal(signature.value, expected);
      if (!manifestSignatureValid) {
        errors.push(
          "manifest signature is invalid (manifest was modified or the wrong secret was used)"
        );
      }
    }
  }

  // --- version cross-check (the top-level copy is unsigned) ---
  if (
    isObject(manifest) &&
    bundle.aep_audit_version !== undefined &&
    bundle.aep_audit_version !== manifest.aep_audit_version
  ) {
    errors.push(
      `aep_audit_version mismatch: bundle '${String(bundle.aep_audit_version)}' vs signed manifest '${String(
        manifest.aep_audit_version
      )}'`
    );
  }

  const per_event: AuditPerEvent[] = eventList.map((e, index) => ({
    index,
    id: isObject(e) && typeof e.id === "string" ? e.id : undefined,
    signature_present: isObject(e) && isObject(e.signature),
  }));

  return {
    valid: errors.length === 0 && contentDigestMatch && manifestSignatureValid,
    errors,
    content_digest_match: contentDigestMatch,
    manifest_signature_valid: manifestSignatureValid,
    per_event,
  };
}
