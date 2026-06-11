"use strict";

/**
 * src/audit-pdf.js — human-readable PDF rendering of audit bundles (Phase 14 PR-C)
 *
 * Renders a bundle produced by `buildAuditBundle` (src/audit.js) into a PDF
 * report for legal / compliance review.  The PDF is a *rendering*, not the
 * tamper-evident artifact: only the JSON bundle can be verified offline with
 * `verifyAuditBundle` / `aep audit verify`.  To keep that distinction honest,
 * the report prints the bundle's content digest and manifest signature so a
 * reviewer can tie the document back to a verified JSON bundle, and it states
 * the verification result it was rendered with (or that it was rendered
 * unverified).
 *
 * Determinism
 * -----------
 * Like src/audit.js, this module never reads the clock: callers inject `now`.
 * That is load-bearing, not cosmetic — pdfkit derives the PDF trailer /ID from
 * the info dictionary, and its default CreationDate is a clock read that
 * differs between renders even within the same second.  With `now` pinned, the
 * same (bundle, verification, now) input renders a byte-identical PDF.
 *
 * Verification is an input
 * ------------------------
 * The renderer takes the result object of `verifyAuditBundle` instead of the
 * signing secret, so this module never handles key material.  Callers decide
 * whether (and when) to verify; the report faithfully prints what it was given.
 *
 * Encoding
 * --------
 * Output is text-only using the built-in Helvetica faces (no font files, no
 * subsetting — another determinism ingredient).  pdfkit never throws on exotic
 * content (it silently emits unencodable code units as garbage glyphs), so
 * non-printable / non-ASCII characters are replaced with `?` purely for
 * legibility.  Lossy is fine here: the PDF is a rendering, the JSON bundle is
 * the record.
 */

const PDFDocument = require("pdfkit");
const { stableStringify } = require("./_canonical");

// Payloads above this many serialized characters are truncated in the PDF (the
// full payload is always in the JSON bundle, which the report says explicitly).
const PAYLOAD_CHAR_LIMIT = 2000;

// Verification banner texts.  Deliberately distinct, ASCII-only strings so
// tests (and humans skimming) cannot confuse one for a substring of another.
const BANNER_VALID = "VERIFICATION: VALID";
const BANNER_INVALID = "VERIFICATION: INVALID - TAMPERING DETECTED";
const BANNER_UNVERIFIED = "NOT VERIFIED AT RENDER TIME";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Replace anything outside printable ASCII (plus \n and \t) with `?`.
 * Negated-class form rather than a control-character class — see the encoding
 * note above; this is a legibility filter, not a security boundary.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[^\n\t\x20-\x7e]/g, "?");
}

/** Render one "Label:  value" line in the two-tone style used throughout. */
function kvLine(doc, label, value) {
  doc
    .font("Helvetica-Bold").fontSize(9).text(`${sanitizeText(label)}:  `, { continued: true })
    .font("Helvetica").fontSize(9).text(sanitizeText(value));
}

/** Render a section heading with a rule underneath. */
function heading(doc, text) {
  doc.moveDown(1);
  doc.font("Helvetica-Bold").fontSize(13).text(sanitizeText(text));
  const y = doc.y + 2;
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.5);
}

/**
 * Serialize a payload for display: deep-stable form (the same key ordering the
 * bundle digest uses), truncated with an explicit marker when oversized.
 *
 * @param {unknown} payload
 * @returns {string}
 */
function formatPayload(payload) {
  if (payload === undefined) return "(no payload)";
  const full = stableStringify(payload);
  if (full.length <= PAYLOAD_CHAR_LIMIT) return full;
  return (
    full.slice(0, PAYLOAD_CHAR_LIMIT) +
    `\n... (truncated; ${PAYLOAD_CHAR_LIMIT} of ${full.length} chars - full payload in the JSON bundle)`
  );
}

/** Render the verification-status section. */
function renderVerification(doc, verification) {
  heading(doc, "Verification status");

  if (verification === undefined || verification === null) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#b45309").text(BANNER_UNVERIFIED);
    doc.fillColor("black").font("Helvetica").fontSize(9).moveDown(0.3);
    doc.text(
      "This report was rendered without running verification. Do not rely on it: " +
      "verify the JSON bundle with `aep audit verify <bundle.json>` and compare " +
      "the content digest printed above."
    );
    return;
  }

  if (verification.valid) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#15803d").text(BANNER_VALID);
  } else {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#b91c1c").text(BANNER_INVALID);
  }
  doc.fillColor("black").moveDown(0.3);

  kvLine(doc, "content_digest_match", String(verification.content_digest_match));
  kvLine(doc, "manifest_signature_valid", String(verification.manifest_signature_valid));
  const errors = Array.isArray(verification.errors) ? verification.errors : [];
  if (errors.length > 0) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Errors:");
    doc.font("Helvetica").fontSize(9);
    for (const err of errors) {
      doc.text(`- ${sanitizeText(err)}`);
    }
  }
}

/** Render one event block. */
function renderEvent(doc, event, index) {
  const sig = event && typeof event === "object" ? event.signature : undefined;
  const sigSummary = sig && typeof sig === "object"
    ? `present (canon: ${sig.canon || "unmarked"})`
    : "absent";

  doc.font("Helvetica-Bold").fontSize(10).text(`#${index}  ${sanitizeText(event.type)}`);
  kvLine(doc, "id", event.id);
  kvLine(doc, "time", event.time);
  if (event.agent_role) kvLine(doc, "agent_role", event.agent_role);
  if (event.source) kvLine(doc, "source", event.source);
  kvLine(doc, "session_id", event.session_id);
  kvLine(doc, "transport signature", sigSummary);
  doc.font("Helvetica-Bold").fontSize(9).text("payload:");
  doc.font("Courier").fontSize(7.5).text(sanitizeText(formatPayload(event.payload)));
  doc.font("Helvetica").fontSize(9).moveDown(0.8);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render an audit bundle to a PDF report.
 *
 * @param {object} bundle  a bundle produced by buildAuditBundle:
 *                         { aep_audit_version, manifest, events, signature }.
 * @param {object} [options]
 * @param {object} [options.verification]  the result of verifyAuditBundle for
 *                         this bundle.  Omit only when verification genuinely
 *                         was not run — the report then says so prominently.
 * @param {Date|string|number} options.now  injected render timestamp
 *                         (deterministic output; never read the clock here).
 * @returns {Promise<Buffer>} the PDF bytes.
 */
function renderAuditBundlePdf(bundle, { verification, now } = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("renderAuditBundlePdf: `bundle` must be an object");
  }
  const { manifest, events } = bundle;
  if (!manifest || typeof manifest !== "object") {
    throw new Error("renderAuditBundlePdf: bundle has no `manifest`");
  }
  if (!Array.isArray(events)) {
    throw new Error("renderAuditBundlePdf: bundle `events` must be an array");
  }
  if (now === undefined || now === null) {
    throw new Error("renderAuditBundlePdf: `now` must be injected (deterministic render)");
  }
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error("renderAuditBundlePdf: `now` is not a valid date");
  }

  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    // Uncompressed content streams: trivially diffable / inspectable, and the
    // size cost is irrelevant for a text-only compliance artifact.
    compress: false,
    info: {
      Title: "AEP Audit Bundle Report",
      Producer: "agent-event-protocol",
      Creator: "aep audit render",
      // Pinned from the injected `now` — pdfkit's default is a clock read,
      // which would make output nondeterministic (see module note).
      CreationDate: nowDate,
    },
  });

  const done = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const scope = manifest.scope || {};
  const timeRange = manifest.time_range || {};
  const perEventSigs = manifest.per_event_signatures || {};

  // --- Title ---------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(18).text("AEP Audit Bundle Report");
  doc.font("Helvetica").fontSize(9).fillColor("#555555")
    .text("Tamper-evident agent event export - rendered for compliance review");
  doc.fillColor("black");

  // --- Manifest ------------------------------------------------------------
  heading(doc, "Manifest");
  kvLine(doc, "aep_audit_version", manifest.aep_audit_version);
  if (scope.session_id) kvLine(doc, "scope.session_id", scope.session_id);
  if (scope.trace_id) kvLine(doc, "scope.trace_id", scope.trace_id);
  kvLine(doc, "tenant_id", manifest.tenant_id === null ? "(null)" : manifest.tenant_id);
  kvLine(doc, "event_count", String(manifest.event_count));
  kvLine(doc, "time_range", timeRange.first || timeRange.last
    ? `${timeRange.first || "?"}  to  ${timeRange.last || "?"}`
    : "(empty)");
  kvLine(doc, "content_digest", `${manifest.content_digest_alg || "?"}:${manifest.content_digest}`);
  kvLine(doc, "manifest signature", bundle.signature && typeof bundle.signature === "object"
    ? `${bundle.signature.alg}:${bundle.signature.value}`
    : "(missing)");
  kvLine(doc, "exported_at", manifest.exported_at);
  kvLine(doc, "per-event transport signatures",
    `${perEventSigs.present ?? "?"} of ${perEventSigs.total ?? "?"} events signed in transit`);
  kvLine(doc, "rendered_at", nowDate.toISOString());

  // --- Verification ----------------------------------------------------------
  renderVerification(doc, verification);

  // --- Events ----------------------------------------------------------------
  heading(doc, `Events (${events.length})`);
  if (events.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).text("This bundle contains no events.");
  }
  events.forEach((event, index) => renderEvent(doc, event, index));

  // --- Appendix ---------------------------------------------------------------
  heading(doc, "Appendix: how to verify");
  doc.font("Helvetica").fontSize(9).text(
    "This PDF is a human-readable rendering, NOT the tamper-evident artifact. " +
    "Integrity guarantees attach to the JSON audit bundle only. To verify: run " +
    "`aep audit verify <bundle.json>` (requires AUDIT_SIGNING_SECRET) and check " +
    "that the reported content digest matches the one printed in the Manifest " +
    "section above. Any mismatch means this report does not describe the " +
    "verified bundle."
  );

  doc.end();
  return done;
}

module.exports = {
  renderAuditBundlePdf,
  // exported for tests / reuse
  PAYLOAD_CHAR_LIMIT,
  BANNER_VALID,
  BANNER_INVALID,
  BANNER_UNVERIFIED,
};
