"use strict";

/**
 * Unit tests for the pure compliance-report generator (no DB / I/O).
 * Covers framework validity, evidence-driven status derivation, the summary
 * tally, defensive evidence defaults, and determinism via injected `now`.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  generateComplianceReport,
  normalizeEvidence,
  isValidFramework,
  FRAMEWORK_IDS,
  STATUS
} = require("../../src/compliance");

const NOW = new Date("2026-06-12T12:00:00Z");

// Evidence representing a fully-configured, active deployment.
const STRONG_EVIDENCE = {
  access_control: { api_key_auth: true, scopes_enforced: true, tenant_isolation: true },
  access_log: { enabled: true },
  integrity: { signing_configured: true, bundle_verified: true, per_event_signatures: { present: 10, total: 10 } },
  monitoring: { policy_blocked_count: 4, total_events: 100, distinct_event_types: 8 },
  retention: { configured: true, retention_days: 90 },
  causation: { has_trace_ids: true, has_causation_links: true },
  record_keeping: { total_events: 100, audit_export_available: true }
};

// Evidence for a bare deployment: signing off, access log off, unlimited retention.
const WEAK_EVIDENCE = {
  access_control: { api_key_auth: true, scopes_enforced: true, tenant_isolation: true },
  access_log: { enabled: false },
  integrity: { signing_configured: false },
  monitoring: { policy_blocked_count: 0, total_events: 0, distinct_event_types: 0 },
  retention: { configured: false, retention_days: null },
  causation: { has_trace_ids: false },
  record_keeping: { total_events: 0, audit_export_available: false }
};

describe("isValidFramework / FRAMEWORK_IDS", () => {
  test("the four frameworks are present", () => {
    assert.deepEqual([...FRAMEWORK_IDS].sort(), ["eu_ai_act", "gdpr", "hipaa", "soc2"]);
  });
  test("isValidFramework gates ids", () => {
    assert.equal(isValidFramework("soc2"), true);
    assert.equal(isValidFramework("nope"), false);
    assert.equal(isValidFramework("__proto__"), false);
  });
});

describe("generateComplianceReport — structure", () => {
  test("unknown framework throws", () => {
    assert.throws(() => generateComplianceReport("nope", STRONG_EVIDENCE, { now: NOW }), /Unknown compliance framework/);
  });

  for (const id of ["soc2", "hipaa", "gdpr", "eu_ai_act"]) {
    test(`${id}: report has the expected top-level shape`, () => {
      const r = generateComplianceReport(id, STRONG_EVIDENCE, { now: NOW, scope: { type: "tenant" } });
      assert.equal(r.framework, id);
      assert.ok(typeof r.framework_name === "string");
      assert.equal(r.generated_at, NOW.toISOString());
      assert.deepEqual(r.scope, { type: "tenant" });
      assert.ok(Array.isArray(r.controls) && r.controls.length > 0);
      assert.ok(typeof r.disclaimer === "string" && r.disclaimer.length > 0);
      // every control carries id/title/requirement/status/detail
      for (const c of r.controls) {
        assert.ok(c.id && c.title && c.requirement && c.status && c.detail);
        assert.ok(Object.values(STATUS).includes(c.status));
      }
    });
  }

  test("summary tally equals the control count and is internally consistent", () => {
    const r = generateComplianceReport("soc2", STRONG_EVIDENCE, { now: NOW });
    const s = r.summary;
    assert.equal(s.total_controls, r.controls.length);
    assert.equal(s.satisfied + s.partial + s.unmet + s.not_applicable, s.total_controls);
  });
});

describe("generateComplianceReport — evidence-driven status", () => {
  test("strong evidence → all controls satisfied (no partial/unmet)", () => {
    for (const id of FRAMEWORK_IDS) {
      const r = generateComplianceReport(id, STRONG_EVIDENCE, { now: NOW });
      assert.equal(r.summary.satisfied, r.summary.total_controls, `${id} should be fully satisfied`);
      assert.equal(r.summary.partial, 0);
      assert.equal(r.summary.unmet, 0);
    }
  });

  test("weak evidence → integrity/audit-trail/retention degrade to partial", () => {
    const r = generateComplianceReport("soc2", WEAK_EVIDENCE, { now: NOW });
    const byId = Object.fromEntries(r.controls.map((c) => [c.id, c]));
    assert.equal(byId["CC7.1"].status, STATUS.PARTIAL);   // integrity: signing not configured
    assert.equal(byId["CC7.3"].status, STATUS.PARTIAL);   // audit trail: access log off
    assert.equal(byId["A1.2"].status, STATUS.PARTIAL);    // retention: unlimited
    assert.equal(byId["CC6.1"].status, STATUS.SATISFIED); // access control: architectural
  });

  test("a FAILED bundle verification → integrity control is UNMET", () => {
    const tampered = { ...STRONG_EVIDENCE, integrity: { signing_configured: true, bundle_verified: false } };
    const r = generateComplianceReport("hipaa", tampered, { now: NOW });
    const integrity = r.controls.find((c) => c.id === "164.312(c)(1)");
    assert.equal(integrity.status, STATUS.UNMET);
    assert.match(integrity.detail, /tampering|FAILED/i);
  });

  test("EU AI Act human-oversight reflects policy.blocked presence", () => {
    const withBlocks = generateComplianceReport("eu_ai_act", STRONG_EVIDENCE, { now: NOW });
    const noBlocks = generateComplianceReport("eu_ai_act", { ...STRONG_EVIDENCE, monitoring: { ...STRONG_EVIDENCE.monitoring, policy_blocked_count: 0 } }, { now: NOW });
    assert.equal(withBlocks.controls.find((c) => c.id === "Art.14").status, STATUS.SATISFIED);
    assert.equal(noBlocks.controls.find((c) => c.id === "Art.14").status, STATUS.PARTIAL);
  });
});

describe("normalizeEvidence — defensive defaults", () => {
  test("empty / missing evidence does not throw and yields safe defaults", () => {
    const ev = normalizeEvidence(undefined);
    assert.equal(ev.access_log.enabled, false);
    assert.equal(ev.integrity.signing_configured, false);
    assert.equal(ev.integrity.bundle_verified, null);
    assert.equal(ev.monitoring.total_events, 0);
    assert.equal(ev.retention.configured, false);
  });

  test("report generation tolerates a bare-{} evidence object", () => {
    const r = generateComplianceReport("gdpr", {}, { now: NOW });
    assert.equal(r.summary.total_controls, r.controls.length);
    // with no evidence, access-control defaults to active (architectural) but the
    // rest degrade to partial.
    assert.ok(r.summary.partial > 0);
  });

  test("access-control flags can be explicitly disabled", () => {
    const ev = normalizeEvidence({ access_control: { tenant_isolation: false } });
    assert.equal(ev.access_control.tenant_isolation, false);
    assert.equal(ev.access_control.api_key_auth, true); // unspecified stays true
  });
});

describe("determinism", () => {
  test("same inputs render an identical report (injected now)", () => {
    const a = generateComplianceReport("soc2", STRONG_EVIDENCE, { now: NOW });
    const b = generateComplianceReport("soc2", STRONG_EVIDENCE, { now: NOW });
    assert.deepEqual(a, b);
  });
});
