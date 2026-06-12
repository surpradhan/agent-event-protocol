"use strict";

/**
 * src/compliance-pdf.js — human-readable PDF rendering of a compliance report
 * (Phase 14 PR-F)
 *
 * Renders the object produced by `generateComplianceReport` (src/compliance.js)
 * into a PDF for a compliance reviewer. Like src/audit-pdf.js, this is a
 * *rendering* of an already-computed report, not a source of truth: the JSON
 * report (and the signed audit bundles it references) carry the verifiable
 * evidence.
 *
 * Determinism: callers inject `now` (pdfkit's default CreationDate is a clock
 * read; pinning it makes the same (report, now) render byte-identical). Text-only
 * with built-in Helvetica — no font files, no subsetting.
 */

const PDFDocument = require("pdfkit");

// Status → display label + colour (mirrors the report's STATUS values).
const STATUS_STYLE = {
  satisfied: { label: "SATISFIED", color: "#15803d" },
  partial: { label: "PARTIAL", color: "#b45309" },
  unmet: { label: "UNMET", color: "#b91c1c" },
  not_applicable: { label: "N/A", color: "#6b7280" }
};

/** Replace anything outside printable ASCII (plus \n, \t) with `?` for legibility. */
function sanitizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[^\n\t\x20-\x7e]/g, "?");
}

/** Render a "Label:  value" line. */
function kvLine(doc, label, value) {
  doc
    .font("Helvetica-Bold").fontSize(9).fillColor("black").text(`${sanitizeText(label)}:  `, { continued: true })
    .font("Helvetica").fontSize(9).text(sanitizeText(value));
}

/** Render a section heading with a rule underneath. */
function heading(doc, text) {
  doc.moveDown(1);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("black").text(sanitizeText(text));
  const y = doc.y + 2;
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.5);
}

/**
 * Render a compliance report to a PDF.
 *
 * @param {object} report  a report from generateComplianceReport.
 * @param {{ now: Date|string|number }} options  injected render timestamp.
 * @returns {Promise<Buffer>} the PDF bytes.
 */
function renderComplianceReportPdf(report, { now } = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("renderComplianceReportPdf: `report` must be an object");
  }
  if (!Array.isArray(report.controls)) {
    throw new Error("renderComplianceReportPdf: report `controls` must be an array");
  }
  if (now === undefined || now === null) {
    throw new Error("renderComplianceReportPdf: `now` must be injected (deterministic render)");
  }
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error("renderComplianceReportPdf: `now` is not a valid date");
  }

  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    compress: false,
    info: {
      Title: `AEP Compliance Report — ${sanitizeText(report.framework_name || report.framework)}`,
      Producer: "agent-event-protocol",
      Creator: "aep compliance report",
      CreationDate: nowDate
    }
  });

  const done = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const scope = report.scope || {};
  const summary = report.summary || {};

  // --- Title ---------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(18).text("AEP Compliance Report");
  doc.font("Helvetica").fontSize(11).fillColor("#333333")
    .text(sanitizeText(`${report.framework_name || report.framework}  (${report.framework_version || ""})`));
  doc.font("Helvetica").fontSize(9).fillColor("#555555")
    .text("Technical-evidence mapping rendered for compliance review");
  doc.fillColor("black");

  // --- Scope ---------------------------------------------------------------
  heading(doc, "Scope");
  kvLine(doc, "tenant_id", scope.tenant_id === null || scope.tenant_id === undefined ? "(all tenants)" : scope.tenant_id);
  if (scope.session_id) kvLine(doc, "session_id", scope.session_id);
  if (scope.trace_id) kvLine(doc, "trace_id", scope.trace_id);
  kvLine(doc, "time_window", (scope.since || scope.until)
    ? `${scope.since || "(open)"}  to  ${scope.until || "(open)"}`
    : "(all time)");
  kvLine(doc, "generated_at", report.generated_at);

  // --- Summary -------------------------------------------------------------
  heading(doc, "Summary");
  kvLine(doc, "total_controls", String(summary.total_controls ?? "?"));
  kvLine(doc, "satisfied", String(summary.satisfied ?? "?"));
  kvLine(doc, "partial", String(summary.partial ?? "?"));
  kvLine(doc, "unmet", String(summary.unmet ?? "?"));

  // --- Controls ------------------------------------------------------------
  heading(doc, `Controls (${report.controls.length})`);
  for (const c of report.controls) {
    const style = STATUS_STYLE[c.status] || STATUS_STYLE.not_applicable;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("black")
      .text(`${sanitizeText(c.id)}  ${sanitizeText(c.title)}`, { continued: true });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(style.color).text(`   [${style.label}]`);
    doc.fillColor("black");
    doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#444444").text(sanitizeText(c.requirement));
    doc.font("Helvetica").fontSize(9).fillColor("black").text(sanitizeText(c.detail));
    doc.moveDown(0.6);
  }

  // --- Disclaimer ----------------------------------------------------------
  heading(doc, "Disclaimer");
  doc.font("Helvetica").fontSize(8.5).fillColor("#333333").text(sanitizeText(report.disclaimer || ""));
  doc.fillColor("black");

  doc.end();
  return done;
}

module.exports = { renderComplianceReportPdf, STATUS_STYLE };
