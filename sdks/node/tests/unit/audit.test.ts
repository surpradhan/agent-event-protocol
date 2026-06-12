import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyAuditBundle } from "../../src/audit";

// Shared KAT generated from the server (src/audit.js buildAuditBundle), verified
// identically by the server and the Python/Go SDKs.
const KAT_SECRET = "shared-secret-123";
const KAT_CONTENT_DIGEST = "3de94f67e3ff35fc9b3e31c2e5efc1932f9e950cc6be0813eed571271ad6f6d5";
const KAT_SIGNATURE = "D6IW2aVORoxIZWy+LiWUrZ08QKLkzFo9uTEySZlcWVA=";

// tests/unit -> tests -> node -> sdks -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "audit", "kat-bundle.json");

function loadBundle(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

describe("verifyAuditBundle", () => {
  it("verifies the shared known-answer bundle", () => {
    const bundle = loadBundle();
    const manifest = bundle.manifest as Record<string, unknown>;
    const signature = bundle.signature as Record<string, unknown>;
    expect(manifest.content_digest).toBe(KAT_CONTENT_DIGEST);
    expect(signature.value).toBe(KAT_SIGNATURE);

    const result = verifyAuditBundle(bundle, KAT_SECRET);
    expect(result.valid).toBe(true);
    expect(result.content_digest_match).toBe(true);
    expect(result.manifest_signature_valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.per_event).toHaveLength(2);
  });

  it("fails the signature under the wrong secret (digest still matches)", () => {
    const result = verifyAuditBundle(loadBundle(), "not-the-secret");
    expect(result.valid).toBe(false);
    expect(result.manifest_signature_valid).toBe(false);
    expect(result.content_digest_match).toBe(true);
  });

  it("detects nested-payload tampering via the content digest", () => {
    const bundle = loadBundle();
    (
      ((bundle.events as unknown[])[0] as Record<string, unknown>).payload as Record<
        string,
        unknown
      >
    ).n = 999;
    const result = verifyAuditBundle(bundle, KAT_SECRET);
    expect(result.valid).toBe(false);
    expect(result.content_digest_match).toBe(false);
    expect(result.errors.some((e) => e.includes("content_digest"))).toBe(true);
  });

  it("detects event reordering", () => {
    const bundle = loadBundle();
    (bundle.events as unknown[]).reverse();
    const result = verifyAuditBundle(bundle, KAT_SECRET);
    expect(result.valid).toBe(false);
    expect(result.content_digest_match).toBe(false);
  });

  it("detects manifest tampering via the signature", () => {
    const bundle = loadBundle();
    (bundle.manifest as Record<string, unknown>).tenant_id = "attacker";
    const result = verifyAuditBundle(bundle, KAT_SECRET);
    expect(result.valid).toBe(false);
    expect(result.manifest_signature_valid).toBe(false);
  });

  it("detects a dropped event (digest + event_count)", () => {
    const bundle = loadBundle();
    (bundle.events as unknown[]).pop();
    const result = verifyAuditBundle(bundle, KAT_SECRET);
    expect(result.valid).toBe(false);
    expect(result.content_digest_match).toBe(false);
    expect(result.errors.some((e) => e.includes("event_count"))).toBe(true);
  });

  it("flags an aep_audit_version downgrade", () => {
    const bundle = loadBundle();
    bundle.aep_audit_version = "9.9.9";
    const result = verifyAuditBundle(bundle, KAT_SECRET);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("aep_audit_version mismatch"))).toBe(true);
  });

  it("rejects an unsupported signature algorithm", () => {
    const bundle = loadBundle();
    (bundle.signature as Record<string, unknown>).alg = "rsa-sha256";
    const result = verifyAuditBundle(bundle, KAT_SECRET);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Unsupported signature algorithm"))).toBe(true);
  });

  it("reports an array-typed signature as present (server parity)", () => {
    const bundle = loadBundle();
    ((bundle.events as unknown[])[0] as Record<string, unknown>).signature = [];
    const result = verifyAuditBundle(bundle, KAT_SECRET);
    expect(result.per_event[0]?.signature_present).toBe(true);
  });

  it("fails gracefully on bad input", () => {
    for (const bad of [null, undefined, 42, "string", []]) {
      expect(verifyAuditBundle(bad, KAT_SECRET).valid).toBe(false);
    }
    expect(verifyAuditBundle(loadBundle(), "").valid).toBe(false);
  });
});
