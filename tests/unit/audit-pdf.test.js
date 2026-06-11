"use strict";

/**
 * Unit tests for the audit bundle PDF renderer (Phase 14 PR-C).
 *
 * The renderer's contracts:
 *   - deterministic: same (bundle, verification, now) → byte-identical PDF
 *   - honest: prints the verification result it was given (VALID / INVALID /
 *     NOT VERIFIED) — never implies validity it wasn't handed
 *   - non-destructive: never mutates the bundle; the bundle still verifies
 *     after a render
 *   - lossy-but-legible: non-ASCII content is replaced with `?`, oversized
 *     payloads truncate with an explicit marker
 *
 * Content assertions go through extractPdfText below: even uncompressed,
 * pdfkit emits text as hex glyph strings inside TJ/Tj kerning arrays (split
 * mid-word by AFM kerning), so a raw byte grep of the PDF finds nothing.  The
 * extractor hex-decodes every text-showing operator and concatenates per
 * operator, which reassembles kern-split words; all renderer marker strings
 * are ASCII-only so this decoding is exact.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { buildAuditBundle, verifyAuditBundle } = require("../../src/audit");
const {
  renderAuditBundlePdf,
  PAYLOAD_CHAR_LIMIT,
  BANNER_VALID,
  BANNER_INVALID,
  BANNER_UNVERIFIED,
} = require("../../src/audit-pdf");

const SECRET = "test-audit-secret-do-not-use-in-prod";
const NOW = new Date("2026-06-11T12:00:00.000Z");

function sampleEvents() {
  return [
    {
      specversion: "0.2.0",
      id: "evt_aaa",
      time: "2026-06-11T10:00:00.000Z",
      source: "agent://orchestrator",
      type: "task.created",
      session_id: "ses_pdf1",
      trace_id: "trc_pdf1",
      tenant: "acme",
      payload: { goal: "research", nested: { deep: true } },
    },
    {
      specversion: "0.2.0",
      id: "evt_bbb",
      time: "2026-06-11T10:00:01.000Z",
      source: "agent://worker",
      type: "task.completed",
      session_id: "ses_pdf1",
      trace_id: "trc_pdf1",
      tenant: "acme",
      agent_role: "worker",
      payload: { ok: true },
      signature: { alg: "hmac-sha256", value: "irrelevant", canon: "v2" },
    },
  ];
}

function sampleBundle(events = sampleEvents()) {
  return buildAuditBundle({
    events,
    meta: { session_id: "ses_pdf1", trace_id: "trc_pdf1", tenant_id: "acme" },
    secret: SECRET,
    now: NOW,
  });
}

function render(bundle, opts = {}) {
  const verification =
    "verification" in opts ? opts.verification : verifyAuditBundle(bundle, SECRET);
  return renderAuditBundlePdf(bundle, { verification, now: NOW });
}

/**
 * Decode every text-showing operator in an (uncompressed) PDF back to a
 * searchable string.  Handles `[<hex> kern <hex> ...] TJ` arrays and bare
 * `<hex> Tj`; hex runs inside one operator are concatenated, which undoes
 * AFM kern-splitting (e.g. `VALID` arriving as `<56> 80 <414c4944>`).
 */
function extractPdfText(pdfBuffer) {
  const raw = pdfBuffer.toString("latin1");
  const chunks = [];
  // NB: `\s` (not `\s+`) inside the alternation — an ambiguous (\s+)+ nesting
  // backtracks catastrophically on long unterminated whitespace runs.
  const tjArray = /\[((?:<[0-9a-fA-F]+>|-?\d+(?:\.\d+)?|\s)+)\]\s*TJ/g;
  let m;
  while ((m = tjArray.exec(raw)) !== null) {
    const hexes = m[1].match(/<[0-9a-fA-F]+>/g) || [];
    chunks.push(hexes.map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1")).join(""));
  }
  const tjSingle = /<([0-9a-fA-F]+)>\s*Tj/g;
  while ((m = tjSingle.exec(raw)) !== null) {
    chunks.push(Buffer.from(m[1], "hex").toString("latin1"));
  }
  return chunks.join("\n");
}

describe("renderAuditBundlePdf — output structure", () => {
  test("produces a PDF: %PDF- magic, %%EOF trailer, non-trivial size", async () => {
    const pdf = await render(sampleBundle());
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.subarray(-32).toString(), /%%EOF\s*$/);
    assert.ok(pdf.length > 1000);
  });

  test("renders manifest fields and events", async () => {
    const bundle = sampleBundle();
    const text = extractPdfText(await render(bundle));
    assert.ok(text.includes(bundle.manifest.content_digest), "content digest in PDF");
    assert.ok(text.includes("ses_pdf1"), "session scope in PDF");
    assert.ok(text.includes("trc_pdf1"), "trace scope in PDF");
    assert.ok(text.includes("task.created"), "event type in PDF");
    assert.ok(text.includes("task.completed"), "event type in PDF");
    assert.ok(text.includes("evt_aaa"), "event id in PDF");
    assert.ok(text.includes("present (canon: v2)"), "transport signature summary in PDF");
    assert.ok(text.includes("aep audit verify"), "verification appendix in PDF");
  });

  test("empty bundle renders the no-events notice", async () => {
    const bundle = buildAuditBundle({
      events: [],
      meta: { session_id: "ses_empty" },
      secret: SECRET,
      now: NOW,
    });
    const text = extractPdfText(await render(bundle));
    assert.ok(text.includes("This bundle contains no events."));
    assert.ok(text.includes("Events (0)"));
  });
});

describe("renderAuditBundlePdf — verification honesty", () => {
  test("valid verification → VALID banner, no INVALID/UNVERIFIED", async () => {
    const text = extractPdfText(await render(sampleBundle()));
    assert.ok(text.includes(BANNER_VALID));
    assert.ok(!text.includes(BANNER_INVALID));
    assert.ok(!text.includes(BANNER_UNVERIFIED));
  });

  test("tampered bundle's verification → INVALID banner + errors, no VALID", async () => {
    const bundle = sampleBundle();
    bundle.events[0].payload.goal = "tampered";
    const verification = verifyAuditBundle(bundle, SECRET);
    assert.equal(verification.valid, false);
    const text = extractPdfText(await render(bundle, { verification }));
    assert.ok(text.includes(BANNER_INVALID));
    assert.ok(!text.includes(BANNER_VALID));
    assert.ok(text.includes("content_digest_match"), "verification fields printed");
  });

  test("no verification supplied → NOT VERIFIED banner", async () => {
    const text = extractPdfText(await render(sampleBundle(), { verification: undefined }));
    assert.ok(text.includes(BANNER_UNVERIFIED));
    assert.ok(!text.includes(BANNER_VALID));
    assert.ok(!text.includes(BANNER_INVALID));
  });
});

describe("renderAuditBundlePdf — payload handling", () => {
  test("oversized payload truncates with an explicit marker", async () => {
    const events = sampleEvents();
    events[0].payload = { big: "x".repeat(PAYLOAD_CHAR_LIMIT * 2) };
    const text = extractPdfText(await render(sampleBundle(events)));
    assert.match(text, /\.\.\. \(truncated; \d+ of \d+ chars - full payload in the JSON bundle\)/);
  });

  test("small payload renders in full, no truncation marker", async () => {
    const text = extractPdfText(await render(sampleBundle()));
    assert.ok(text.includes('{"goal":"research","nested":{"deep":true}}'));
    assert.ok(!text.includes("(truncated;"));
  });

  test("non-ASCII payload content is replaced with ? for legibility", async () => {
    const events = sampleEvents();
    events[0].payload = { msg: "ascii-ok 你好" };
    const text = extractPdfText(await render(sampleBundle(events)));
    assert.ok(text.includes('"msg":"ascii-ok ??"'));
  });

  test("malformed (non-object) events render a notice instead of crashing", async () => {
    // A bundle whose events were nulled by tampering still has to render under
    // --force; buildAuditBundle also signs whatever JSON values it's given, so
    // even a VALID bundle can hold non-object entries.
    const bundle = buildAuditBundle({
      events: [null, "not-an-event", 42, ["array"]],
      meta: { session_id: "ses_malformed" },
      secret: SECRET,
      now: NOW,
    });
    const verification = verifyAuditBundle(bundle, SECRET);
    assert.equal(verification.valid, true);
    const text = extractPdfText(await renderAuditBundlePdf(bundle, { verification, now: NOW }));
    assert.ok(text.includes("(malformed event - not an object)"));
    assert.ok(text.includes("Events (4)"));
  });
});

describe("renderAuditBundlePdf — determinism & purity", () => {
  test("same inputs render byte-identical PDFs", async () => {
    const bundle = sampleBundle();
    const verification = verifyAuditBundle(bundle, SECRET);
    const a = await renderAuditBundlePdf(bundle, { verification, now: NOW });
    const b = await renderAuditBundlePdf(bundle, { verification, now: NOW });
    assert.ok(a.equals(b));
  });

  test("rendering does not mutate the bundle; it still verifies afterwards", async () => {
    const bundle = sampleBundle();
    const before = JSON.stringify(bundle);
    await render(bundle);
    assert.equal(JSON.stringify(bundle), before);
    assert.equal(verifyAuditBundle(bundle, SECRET).valid, true);
  });
});

describe("renderAuditBundlePdf — input validation", () => {
  test("rejects a non-object bundle", async () => {
    assert.throws(() => renderAuditBundlePdf(null, { now: NOW }), /`bundle` must be an object/);
    assert.throws(() => renderAuditBundlePdf([], { now: NOW }), /`bundle` must be an object/);
  });

  test("rejects a bundle without a manifest", async () => {
    assert.throws(
      () => renderAuditBundlePdf({ events: [] }, { now: NOW }),
      /no `manifest`/
    );
  });

  test("rejects a bundle whose events is not an array", async () => {
    assert.throws(
      () => renderAuditBundlePdf({ manifest: {}, events: {} }, { now: NOW }),
      /`events` must be an array/
    );
  });

  test("requires an injected `now` (deterministic render)", async () => {
    const bundle = sampleBundle();
    assert.throws(() => renderAuditBundlePdf(bundle, {}), /`now` must be injected/);
    assert.throws(
      () => renderAuditBundlePdf(bundle, { now: "not-a-date" }),
      /not a valid date/
    );
  });
});
