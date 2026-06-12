"use strict";

/**
 * src/compliance.js — pre-built compliance report templates (Phase 14 PR-F)
 *
 * Maps the evidence AEP already produces — tamper-evident audit bundles + HMAC
 * signatures (integrity), the API-key access log (access trail), policy.blocked
 * analytics (enforcement), tenant isolation + key scopes (access control), the
 * retention policy (storage limitation), and the causation-linked event store
 * (record-keeping / traceability) — onto the control areas of four compliance
 * frameworks: SOC 2, HIPAA, GDPR, and the EU AI Act.
 *
 * Design
 * ------
 * `generateComplianceReport` is **pure** (no I/O, no clock except the injected
 * `now`). The server/CLI assembles an `evidence` object from the live system and
 * passes it here; each control's `evaluate(evidence)` derives a status from that
 * evidence rather than asserting a fixed verdict — so the report reflects the
 * *actual* configuration (e.g. signing not configured → integrity controls are
 * "partial", not "satisfied").
 *
 * Honesty
 * -------
 * These templates **map AEP's technical evidence to control areas**; they are an
 * input to a compliance review, not a certification. A "satisfied" status means
 * "AEP provides the technical control this requirement asks for, and it is
 * configured here" — organizational controls, BAAs, DPAs, physical security, etc.
 * are out of AEP's scope and are flagged as such in each report's `disclaimer`.
 */

// Per-control status values.
const STATUS = Object.freeze({
  SATISFIED: "satisfied",       // AEP provides the control and it is configured/active
  PARTIAL: "partial",           // capability exists but is not enabled, or only partly met
  UNMET: "unmet",               // the control is not met (e.g. verification failed)
  NOT_APPLICABLE: "not_applicable"
});

const DISCLAIMER =
  "This report maps AEP's technical evidence (signed audit trail, access logs, " +
  "policy enforcement, tenant isolation, retention) to the named framework's " +
  "control areas. It is an input to a compliance review, not a certification or " +
  "legal advice. Organizational, contractual (BAA/DPA), and physical controls are " +
  "outside AEP's scope and must be assessed separately.";

// ---------------------------------------------------------------------------
// Evidence normalization — defensive defaults so a missing/partial evidence
// object never throws inside an evaluator.
// ---------------------------------------------------------------------------

/**
 * @param {object} [evidence]
 * @returns {object} a fully-populated evidence object with safe defaults.
 */
function normalizeEvidence(evidence) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  const accessControl = e.access_control || {};
  const accessLog = e.access_log || {};
  const integrity = e.integrity || {};
  const perEvent = integrity.per_event_signatures || {};
  const monitoring = e.monitoring || {};
  const retention = e.retention || {};
  const causation = e.causation || {};
  const recordKeeping = e.record_keeping || {};

  return {
    access_control: {
      api_key_auth: accessControl.api_key_auth !== false,
      scopes_enforced: accessControl.scopes_enforced !== false,
      tenant_isolation: accessControl.tenant_isolation !== false
    },
    access_log: {
      enabled: !!accessLog.enabled
    },
    integrity: {
      signing_configured: !!integrity.signing_configured,
      bundle_verified: integrity.bundle_verified === undefined ? null : integrity.bundle_verified,
      per_event_signatures: {
        present: Number(perEvent.present) || 0,
        total: Number(perEvent.total) || 0
      }
    },
    monitoring: {
      policy_blocked_count: Number(monitoring.policy_blocked_count) || 0,
      total_events: Number(monitoring.total_events) || 0,
      distinct_event_types: Number(monitoring.distinct_event_types) || 0
    },
    retention: {
      configured: !!retention.configured,
      retention_days:
        retention.retention_days === undefined ? null : retention.retention_days
    },
    causation: {
      has_trace_ids: !!causation.has_trace_ids,
      has_causation_links: !!causation.has_causation_links
    },
    record_keeping: {
      total_events: Number(recordKeeping.total_events) || 0,
      audit_export_available: !!recordKeeping.audit_export_available
    }
  };
}

// ---------------------------------------------------------------------------
// Shared evaluators — each returns { status, detail }. Referenced by controls
// across frameworks so the AEP→control mapping is defined once.
// ---------------------------------------------------------------------------

function evalAccessControl(ev) {
  const ac = ev.access_control;
  if (ac.api_key_auth && ac.scopes_enforced && ac.tenant_isolation) {
    return {
      status: STATUS.SATISFIED,
      detail: "Every request is authenticated by a scoped API key; data is isolated per tenant at the DB and API layer."
    };
  }
  return {
    status: STATUS.PARTIAL,
    detail: "One or more access-control primitives (key auth, scopes, tenant isolation) is not active in this deployment."
  };
}

function evalAuditTrail(ev) {
  return ev.access_log.enabled
    ? {
        status: STATUS.SATISFIED,
        detail: "ACCESS_LOG_ENABLED is on: every key-authenticated request is recorded (key, method, path, status, time)."
      }
    : {
        status: STATUS.PARTIAL,
        detail: "The API-key access-log capability exists but ACCESS_LOG_ENABLED is off, so request-level access is not being recorded."
      };
}

function evalIntegrity(ev) {
  const i = ev.integrity;
  if (!i.signing_configured) {
    return {
      status: STATUS.PARTIAL,
      detail: "HMAC tamper-evidence is available but AUDIT_SIGNING_SECRET is not configured, so signed audit bundles cannot be produced here."
    };
  }
  if (i.bundle_verified === false) {
    return {
      status: STATUS.UNMET,
      detail: "An audit bundle for this scope FAILED verification — post-hoc modification or reordering was detected."
    };
  }
  const verified = i.bundle_verified === true ? " A bundle for this scope verified successfully." : "";
  return {
    status: STATUS.SATISFIED,
    detail: "AUDIT_SIGNING_SECRET is configured: event logs export as HMAC-signed, tamper-evident bundles." + verified
  };
}

function evalRetention(ev) {
  return ev.retention.configured
    ? {
        status: STATUS.SATISFIED,
        detail: `A finite retention policy is configured (${ev.retention.retention_days} days); events past the window are pruned.`
      }
    : {
        status: STATUS.PARTIAL,
        detail: "No finite retention is configured (unlimited): the storage-limitation control is available (per-project retention + pruning) but not enforced here."
      };
}

function evalMonitoring(ev) {
  return ev.monitoring.total_events > 0
    ? {
        status: STATUS.SATISFIED,
        detail: `Agent activity is captured as structured events (${ev.monitoring.total_events} events, ${ev.monitoring.distinct_event_types} distinct types in scope), queryable in real time.`
      }
    : {
        status: STATUS.PARTIAL,
        detail: "No events were found in scope to evidence monitoring; the capture pipeline is present but unused here."
      };
}

function evalEnforcement(ev) {
  return ev.monitoring.policy_blocked_count > 0
    ? {
        status: STATUS.SATISFIED,
        detail: `${ev.monitoring.policy_blocked_count} policy.blocked enforcement event(s) recorded — points where an agent action was refused are captured and auditable.`
      }
    : {
        status: STATUS.PARTIAL,
        detail: "The policy.blocked enforcement-logging capability exists but no blocks were recorded in scope."
      };
}

function evalTransparency(ev) {
  return ev.causation.has_trace_ids
    ? {
        status: STATUS.SATISFIED,
        detail: "Workflows are traceable end-to-end via trace_id / session_id / causation_id causation chains."
      }
    : {
        status: STATUS.PARTIAL,
        detail: "No trace-linked events were found in scope to evidence end-to-end traceability."
      };
}

function evalRecordKeeping(ev) {
  return ev.record_keeping.total_events > 0
    ? {
        status: STATUS.SATISFIED,
        detail: `Processing activity is recorded as ${ev.record_keeping.total_events} immutable, timestamped events; exportable as signed audit bundles.`
      }
    : {
        status: STATUS.PARTIAL,
        detail: "No records were found in scope; the immutable event store is present but holds no in-scope activity."
      };
}

/** Build a control descriptor. `evaluate` maps normalized evidence → status. */
function control(id, title, requirement, evaluate) {
  return { id, title, requirement, evaluate };
}

// ---------------------------------------------------------------------------
// Framework templates
// ---------------------------------------------------------------------------

const FRAMEWORKS = {
  soc2: {
    id: "soc2",
    name: "SOC 2 (Trust Services Criteria)",
    version: "2017 (rev. 2022)",
    controls: [
      control("CC6.1", "Logical access controls",
        "Restrict logical access to information assets to authorized users.", evalAccessControl),
      control("CC6.6", "Authentication of access",
        "Implement controls to authenticate users before granting access.", evalAccessControl),
      control("CC7.2", "System monitoring",
        "Monitor system components for anomalies indicative of malicious acts or errors.", evalMonitoring),
      control("CC7.3", "Audit trail of activity",
        "Maintain a record of system activity sufficient to detect and investigate events.", evalAuditTrail),
      control("CC7.1", "Integrity of records",
        "Protect records against unauthorized or undetected alteration.", evalIntegrity),
      control("A1.2", "Data retention",
        "Retain and dispose of data in line with defined retention requirements.", evalRetention)
    ]
  },

  hipaa: {
    id: "hipaa",
    name: "HIPAA Security Rule",
    version: "45 CFR Part 164 Subpart C",
    controls: [
      control("164.312(a)(1)", "Access control",
        "Allow access to ePHI only to persons or software granted access rights.", evalAccessControl),
      control("164.312(d)", "Person or entity authentication",
        "Verify that a person or entity seeking access is the one claimed.", evalAccessControl),
      control("164.312(b)", "Audit controls",
        "Record and examine activity in systems that contain or use ePHI.", evalAuditTrail),
      control("164.312(c)(1)", "Integrity",
        "Protect ePHI from improper alteration or destruction.", evalIntegrity),
      control("164.316(b)(2)(i)", "Retention",
        "Retain required documentation for six years from creation or last effect.", evalRetention)
    ]
  },

  gdpr: {
    id: "gdpr",
    name: "GDPR (EU 2016/679)",
    version: "EU 2016/679",
    controls: [
      control("Art.30", "Records of processing activities",
        "Maintain a record of processing activities under the controller's responsibility.", evalRecordKeeping),
      control("Art.32", "Security of processing",
        "Ensure integrity and confidentiality of personal data via appropriate measures.", evalIntegrity),
      control("Art.32(1)", "Access control of processing",
        "Restrict access to personal data to authorized processing only.", evalAccessControl),
      control("Art.5(1)(e)", "Storage limitation",
        "Keep personal data no longer than necessary for the purposes processed.", evalRetention),
      control("Art.33", "Breach detection",
        "Be able to detect a personal-data breach to enable timely notification.", evalIntegrity),
      control("Art.5(2)", "Accountability",
        "Be able to demonstrate compliance with the processing principles.", evalAuditTrail)
    ]
  },

  eu_ai_act: {
    id: "eu_ai_act",
    name: "EU AI Act (Regulation 2024/1689)",
    version: "Regulation (EU) 2024/1689",
    controls: [
      control("Art.12", "Record-keeping (logging)",
        "Automatically record events ('logs') over the lifetime of the AI system.", evalRecordKeeping),
      control("Art.13", "Transparency and traceability",
        "Enable traceability of the system's functioning and decisions.", evalTransparency),
      control("Art.14", "Human oversight",
        "Enable oversight, including the ability to intervene in or halt the system.", evalEnforcement),
      control("Art.15", "Accuracy, robustness and cybersecurity",
        "Protect the system and its records against integrity-affecting manipulation.", evalIntegrity),
      control("Art.19", "Automatically generated logs retention",
        "Keep automatically generated logs for an appropriate period.", evalRetention)
    ]
  }
};

const FRAMEWORK_IDS = Object.keys(FRAMEWORKS);

/** @param {string} id @returns {boolean} */
function isValidFramework(id) {
  return Object.prototype.hasOwnProperty.call(FRAMEWORKS, id);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/**
 * Generate a compliance report mapping AEP evidence to a framework's controls.
 *
 * @param {string} frameworkId  one of FRAMEWORK_IDS
 * @param {object} evidence     evidence facets assembled from the live system
 *                              (see normalizeEvidence for the shape)
 * @param {{ now?: Date, scope?: object }} [opts]
 * @returns {object} the report
 * @throws {Error} if frameworkId is unknown
 */
function generateComplianceReport(frameworkId, evidence, { now = new Date(), scope = {} } = {}) {
  const fw = FRAMEWORKS[frameworkId];
  if (!fw) {
    throw new Error(`Unknown compliance framework: '${frameworkId}'. Valid: ${FRAMEWORK_IDS.join(", ")}`);
  }

  const ev = normalizeEvidence(evidence);

  const controls = fw.controls.map((c) => {
    const r = c.evaluate(ev);
    return {
      id: c.id,
      title: c.title,
      requirement: c.requirement,
      status: r.status,
      detail: r.detail
    };
  });

  const summary = {
    total_controls: controls.length,
    satisfied: controls.filter((c) => c.status === STATUS.SATISFIED).length,
    partial: controls.filter((c) => c.status === STATUS.PARTIAL).length,
    unmet: controls.filter((c) => c.status === STATUS.UNMET).length,
    not_applicable: controls.filter((c) => c.status === STATUS.NOT_APPLICABLE).length
  };

  return {
    framework: fw.id,
    framework_name: fw.name,
    framework_version: fw.version,
    generated_at: now.toISOString(),
    scope,
    summary,
    controls,
    evidence: ev,
    disclaimer: DISCLAIMER
  };
}

module.exports = {
  generateComplianceReport,
  normalizeEvidence,
  isValidFramework,
  FRAMEWORK_IDS,
  STATUS,
  DISCLAIMER
};
