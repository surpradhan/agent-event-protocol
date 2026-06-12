#!/usr/bin/env node
"use strict";

/**
 * aep — Agent Event Protocol CLI
 *
 * Commands:
 *   aep emit     — Emit a single event to the ingest server
 *   aep session  — Query events for a session
 *   aep export   — Export session events as JSON or CSV
 *   aep audit    — Build / verify / render a tamper-evident audit bundle
 *   aep workflow — Query a full workflow tree by trace_id
 *   aep analytics — Policy-enforcement & performance analytics
 *   aep compliance — Compliance report templates (SOC2/HIPAA/GDPR/EU AI Act)
 *   aep validate — Validate a local event JSON file (existing)
 *
 * Configuration (in priority order):
 *   1. CLI flags:  --server <url>  --key <api-key>
 *   2. Env vars:   AEP_SERVER      AEP_API_KEY
 *   3. Defaults:   http://localhost:8787  (no key)
 */

const https = require("https");
const http  = require("http");
const { URL } = require("url");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Tiny argument parser (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2); // strip node + script path
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(a);
      i += 1;
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// HTTP helper — wraps Node's http/https with Promise
// ---------------------------------------------------------------------------

function request(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, rawBody: data, headers: res.headers });
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

function ok(label, data) {
  if (data !== undefined) {
    console.log(`\x1b[32m✓\x1b[0m ${label}`);
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`\x1b[32m✓\x1b[0m ${label}`);
  }
}

function printUsage() {
  console.log(`
\x1b[1mAEP CLI — Agent Event Protocol\x1b[0m

Usage:
  aep <command> [flags]

Commands:
  emit       Emit a single event to the ingest server
  session    Query events for a session
  export     Export session events as JSON or CSV
  audit      Build / verify / render a tamper-evident audit bundle
  workflow   Query a full workflow tree by trace_id
  analytics  Policy-enforcement & performance analytics
  compliance Compliance report templates (SOC2/HIPAA/GDPR/EU AI Act)
  validate   Validate a local event JSON file

Global flags:
  --server <url>    AEP server URL  (env: AEP_SERVER, default: http://localhost:8787)
  --key    <token>  API key         (env: AEP_API_KEY)
  --help            Show this help

Run \x1b[1maep <command> --help\x1b[0m for command-specific help.
`);
}

// ---------------------------------------------------------------------------
// Command: emit
// ---------------------------------------------------------------------------

function emitHelp() {
  console.log(`
\x1b[1maep emit\x1b[0m — Emit a single event to the ingest server

Usage:
  aep emit --type <type> --source <source> --session <session_id> --trace <trace_id> [flags]

Required flags:
  --type    <type>       Event type (e.g. task.created)
  --source  <source>    Event source URI (e.g. agent://my-agent)
  --session <id>         session_id
  --trace   <id>         trace_id

Optional flags:
  --id      <id>         Event ID (auto-generated if omitted)
  --time    <iso>        Event timestamp (defaults to now)
  --role    <role>       agent_role: orchestrator | subagent | standalone
  --parent  <id>         parent_session_id
  --subject <subject>    Event subject
  --cause   <id>         causation_id
  --idem    <key>        idempotency_key
  --payload <json>       Payload JSON string (default: {})
  --labels  <json>       Labels JSON object string
`);
}

async function cmdEmit(flags, serverUrl, apiKey) {
  if (flags.help) { emitHelp(); return; }

  if (!flags.type)    die("--type is required");
  if (!flags.source)  die("--source is required");
  if (!flags.session) die("--session is required");
  if (!flags.trace)   die("--trace is required");
  if (!apiKey)        die("API key required. Set --key or AEP_API_KEY env var.");

  let payload = {};
  if (flags.payload) {
    try { payload = JSON.parse(flags.payload); }
    catch (_) { die("--payload must be valid JSON"); }
  }

  let labels;
  if (flags.labels) {
    try { labels = JSON.parse(flags.labels); }
    catch (_) { die("--labels must be a valid JSON object"); }
  }

  const event = {
    specversion: "0.2.0",
    id: flags.id || `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    time: flags.time || new Date().toISOString(),
    source: flags.source,
    type: flags.type,
    session_id: flags.session,
    trace_id: flags.trace,
    payload,
    ...(flags.role     ? { agent_role: flags.role }             : {}),
    ...(flags.parent   ? { parent_session_id: flags.parent }    : {}),
    ...(flags.subject  ? { subject: flags.subject }             : {}),
    ...(flags.cause    ? { causation_id: flags.cause }          : {}),
    ...(flags.idem     ? { idempotency_key: flags.idem }        : {}),
    ...(labels         ? { labels }                             : {}),
  };

  const res = await request("POST", `${serverUrl}/events`, event, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (res.status === 202) {
    ok("Event accepted", res.body);
  } else if (res.status === 200 && res.body?.duplicate) {
    console.log(`\x1b[33m⚡ Duplicate\x1b[0m Event already ingested (id: ${res.body.id})`);
  } else {
    console.error(`\x1b[31mRejected (HTTP ${res.status})\x1b[0m`);
    console.error(JSON.stringify(res.body, null, 2));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command: session
// ---------------------------------------------------------------------------

function sessionHelp() {
  console.log(`
\x1b[1maep session\x1b[0m — Query events for a session

Usage:
  aep session <session_id> [flags]

Flags:
  --type <type>   Filter to a specific event type (e.g. tool.called)
  --q    <text>   Full-text search query
`);
}

async function cmdSession(positional, flags, serverUrl, apiKey) {
  if (flags.help) { sessionHelp(); return; }

  const sessionId = positional[1];
  if (!sessionId) die("Usage: aep session <session_id> [--type filter] [--q search]");
  if (!apiKey)    die("API key required. Set --key or AEP_API_KEY env var.");

  const qs = new URLSearchParams();
  if (flags.type) qs.set("type", flags.type);
  if (flags.q)    qs.set("q", flags.q);
  const query = qs.toString() ? `?${qs}` : "";

  const res = await request("GET", `${serverUrl}/sessions/${sessionId}/events${query}`, null, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (res.status !== 200) {
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const { events } = res.body;
  console.log(`Session: \x1b[1m${sessionId}\x1b[0m  (${events.length} event${events.length !== 1 ? "s" : ""})`);
  if (events.length === 0) {
    console.log("  (no events)");
    return;
  }
  for (const evt of events) {
    const ts = new Date(evt.time).toISOString().replace("T", " ").replace("Z", "");
    console.log(`  \x1b[36m${ts}\x1b[0m  \x1b[33m${evt.type}\x1b[0m  ${evt.id}`);
  }
}

// ---------------------------------------------------------------------------
// Command: export
// ---------------------------------------------------------------------------

function exportHelp() {
  console.log(`
\x1b[1maep export\x1b[0m — Export session events as JSON or CSV

Usage:
  aep export <session_id> [flags]

Flags:
  --format json|csv   Output format (default: json)
  --type   <type>     Filter to a specific event type
  --q      <text>     Full-text search query
  --out    <file>     Write output to a file (default: stdout)
`);
}

async function cmdExport(positional, flags, serverUrl, apiKey) {
  if (flags.help) { exportHelp(); return; }

  const sessionId = positional[1];
  if (!sessionId) die("Usage: aep export <session_id> [--format json|csv] [--out file]");
  if (!apiKey)    die("API key required. Set --key or AEP_API_KEY env var.");

  const format = flags.format || "json";
  if (!["json", "csv"].includes(format)) die("--format must be 'json' or 'csv'");

  const qs = new URLSearchParams({ format });
  if (flags.type) qs.set("type", flags.type);
  if (flags.q)    qs.set("q", flags.q);

  // For CSV we need the raw text, not parsed JSON
  return new Promise((resolve, reject) => {
    const url = new URL(`${serverUrl}/sessions/${sessionId}/export?${qs}`);
    const lib = url.protocol === "https:" ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "*/*" },
    };

    const req = lib.request(opts, (res) => {
      if (res.statusCode !== 200) {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => { die(`Server returned HTTP ${res.statusCode}: ${data}`); });
        return;
      }
      if (flags.out) {
        const fs = require("fs");
        const ws = fs.createWriteStream(flags.out);
        res.pipe(ws);
        ws.on("finish", () => {
          console.log(`\x1b[32m✓\x1b[0m Exported to ${flags.out}`);
          resolve();
        });
        ws.on("error", reject);
      } else {
        res.pipe(process.stdout);
        res.on("end", resolve);
      }
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Command: audit  (Phase 14 PR-A — tamper-evident audit bundles)
// ---------------------------------------------------------------------------

function auditHelp() {
  console.log(`
\x1b[1maep audit\x1b[0m — Build / verify / render a tamper-evident, HMAC-signed audit bundle

Usage:
  aep audit export <session_id> [--out bundle.json] [flags]
  aep audit verify <bundle.json> [--json]
  aep audit render <bundle.json> [--out report.pdf] [--force]

export — fetch a session's events (via the read API), package them into a
         signed bundle and write it out. Requires AUDIT_SIGNING_SECRET to be set
         (the server-side audit signing key, distinct from per-API-key secrets).

  --out         <file>   Write the bundle to a file (default: stdout)
  --type        <type>   Filter to a specific event type
  --q           <text>   Full-text search query
  --allow-empty          Export even when the session has 0 matching events
                         (otherwise export fails — guards against signing a
                         misleading empty bundle for a missing session)
  --pdf         [file]   Also write a human-readable PDF report alongside the
                         JSON bundle. Filename derived from --out (bundle.json
                         → bundle.pdf) unless given explicitly. Place --pdf
                         AFTER the session id, or give it an explicit value —
                         in "aep audit export --pdf ses_1", ses_1 is read as
                         the PDF filename, not the session id.

verify — recompute the content digest and manifest signature of a bundle file
         offline and report whether it is intact. Requires AUDIT_SIGNING_SECRET.
         Exit code 0 = valid, 1 = invalid/tampered.

  --json          Emit the machine-readable verification result as JSON

render — verify a bundle file, then render it as a human-readable PDF report
         for compliance review. The PDF is a rendering only — the JSON bundle
         remains the tamper-evident artifact. Requires AUDIT_SIGNING_SECRET.

  --out  <file>   PDF output path (default: bundle path with a .pdf extension)
  --force         Render even when verification fails (the report then shows
                  INVALID - TAMPERING DETECTED prominently)

Environment:
  AUDIT_SIGNING_SECRET   HMAC secret used to sign / verify audit bundles (required)
`);
}

function readAuditSecret() {
  const secret = process.env.AUDIT_SIGNING_SECRET;
  if (!secret) {
    die(
      "AUDIT_SIGNING_SECRET is not set. Audit export/verify needs a server-side " +
      "signing secret (distinct from per-API-key HMAC secrets). " +
      "Set it, e.g. export AUDIT_SIGNING_SECRET=$(openssl rand -hex 32)"
    );
  }
  return secret;
}

async function cmdAuditExport(positional, flags, serverUrl, apiKey) {
  // positional: ["audit", "export", "<session_id>"]
  const sessionId = positional[2];
  if (!sessionId) die("Usage: aep audit export <session_id> [--out bundle.json]");
  if (!apiKey)    die("API key required. Set --key or AEP_API_KEY env var.");

  const secret = readAuditSecret();
  const { buildAuditBundle } = require("./audit");

  const qs = new URLSearchParams({ format: "json" });
  if (flags.type) qs.set("type", flags.type);
  if (flags.q)    qs.set("q", flags.q);

  const res = await request("GET", `${serverUrl}/sessions/${sessionId}/export?${qs}`, null, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (res.status !== 200) {
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const events = (res.body && res.body.events) || [];

  if (events.length === 0 && !flags["allow-empty"]) {
    die(
      `No events found for session '${sessionId}'. The session may not exist, ` +
      "belong to another tenant, or have no events matching the filters. " +
      "Pass --allow-empty to export an empty (but still signed) bundle anyway."
    );
  }

  // Derive scope metadata from the returned events. trace_id / tenant_id are
  // only recorded when the session has exactly one distinct value; tell the user
  // when we omit one so an absent scope field isn't mistaken for missing data.
  const traceIds = new Set(events.map(e => e.trace_id).filter(Boolean));
  const tenants  = new Set(events.map(e => e.tenant).filter(Boolean));
  if (traceIds.size > 1) {
    console.error(`\x1b[33m!\x1b[0m Session spans ${traceIds.size} trace_ids — omitting trace_id from the bundle scope.`);
  }
  if (tenants.size > 1) {
    console.error(`\x1b[33m!\x1b[0m Session spans ${tenants.size} tenants — omitting tenant_id from the bundle scope.`);
  }
  const meta = {
    session_id: sessionId,
    ...(traceIds.size === 1 ? { trace_id: [...traceIds][0] } : {}),
    ...(tenants.size === 1  ? { tenant_id: [...tenants][0] } : {}),
  };

  const bundle = buildAuditBundle({ events, meta, secret, now: new Date() });

  const out = JSON.stringify(bundle, null, 2);
  if (flags.out) {
    require("fs").writeFileSync(flags.out, out + "\n");
    console.log(`\x1b[32m✓\x1b[0m Audit bundle written to ${flags.out}`);
    console.log(
      `  ${bundle.manifest.event_count} event(s), content_digest=${bundle.manifest.content_digest.slice(0, 16)}…`
    );
  } else {
    process.stdout.write(out + "\n");
  }

  // --pdf: write a human-readable PDF report ALONGSIDE the JSON bundle (never
  // instead of it — the JSON is the verifiable artifact). parseArgs is greedy:
  // `--pdf report.pdf` gives a string, bare `--pdf` gives true.
  if (flags.pdf !== undefined) {
    const pdfPath =
      typeof flags.pdf === "string" ? flags.pdf
        : typeof flags.out === "string" ? derivePdfPath(flags.out)
          : null;
    if (!pdfPath) {
      die(
        "--pdf needs an explicit filename when the JSON bundle goes to stdout " +
        "(e.g. --pdf report.pdf), or pass --out so the name can be derived."
      );
    }
    const fs = require("fs");
    const path = require("path");
    if (typeof flags.out === "string" && path.resolve(pdfPath) === path.resolve(flags.out)) {
      die(`--pdf would overwrite the JSON bundle at '${flags.out}' — give the PDF a different name.`);
    }
    const { verifyAuditBundle } = require("./audit");
    const { renderAuditBundlePdf } = require("./audit-pdf");
    // Freshly built, so expected valid — but verify for real rather than assert.
    // One clock read shared by both, so rendered_at matches the verify instant.
    const now = new Date();
    const verification = verifyAuditBundle(bundle, secret, { now });
    const pdf = await renderAuditBundlePdf(bundle, { verification, now });
    fs.writeFileSync(pdfPath, pdf);
    // When the JSON bundle went to stdout, this message MUST go to stderr —
    // appending it to stdout would corrupt the piped artifact (`> bundle.json`).
    const note = flags.out ? console.log : console.error;
    note(`\x1b[32m✓\x1b[0m PDF report written to ${pdfPath}`);
  }
}

/** bundle.json → bundle.pdf; a path without an extension just gains .pdf.
 * The `(.)` guard keeps an extension-only basename like `.json` intact (it
 * becomes `.json.pdf`, not the hidden file `.pdf`). */
function derivePdfPath(p) {
  return p.replace(/(.)\.[a-zA-Z0-9]+$/, "$1") + ".pdf";
}

async function cmdAuditRender(positional, flags) {
  // positional: ["audit", "render", "<bundle.json>"]
  const filePath = positional[2];
  if (!filePath) die("Usage: aep audit render <bundle.json> [--out report.pdf] [--force]");

  const secret = readAuditSecret();
  const { verifyAuditBundle } = require("./audit");
  const { renderAuditBundlePdf } = require("./audit-pdf");

  const fs = require("fs");
  const path = require("path");
  const fullPath = path.resolve(filePath);

  let bundle;
  try {
    const raw = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
    bundle = JSON.parse(raw);
  } catch (e) {
    die(`Could not read/parse '${fullPath}': ${e.message}`);
  }

  // One clock read shared by verify + render, so rendered_at matches the
  // verify instant (same pattern as cmdAuditExport and sendAuditBundle).
  const now = new Date();
  const verification = verifyAuditBundle(bundle, secret, { now });

  if (!verification.valid && !flags.force) {
    console.error(`\x1b[31m✗ INVALID / TAMPERED\x1b[0m  ${fullPath}`);
    verification.errors.forEach(e => console.error(`  - ${e}`));
    die(
      "Refusing to render an unverifiable bundle. Pass --force to render anyway " +
      "(the report will state INVALID - TAMPERING DETECTED prominently)."
    );
  }

  const outPath = typeof flags.out === "string" ? flags.out : derivePdfPath(fullPath);
  if (path.resolve(outPath) === fullPath) {
    die(`Output '${outPath}' would overwrite the bundle itself — give the PDF a different name.`);
  }

  const pdf = await renderAuditBundlePdf(bundle, { verification, now });
  fs.writeFileSync(outPath, pdf);
  console.log(
    `\x1b[32m✓\x1b[0m PDF report written to ${outPath} ` +
    `(verification: ${verification.valid ? "VALID" : "\x1b[31mINVALID\x1b[0m"})`
  );
  if (!verification.valid) process.exitCode = 1;
}

async function cmdAuditVerify(positional, flags) {
  // positional: ["audit", "verify", "<bundle.json>"]
  const filePath = positional[2];
  if (!filePath) die("Usage: aep audit verify <bundle.json> [--json]");

  const secret = readAuditSecret();
  const { verifyAuditBundle } = require("./audit");

  const fs = require("fs");
  const path = require("path");
  const fullPath = path.resolve(filePath);

  let bundle;
  try {
    const raw = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
    bundle = JSON.parse(raw);
  } catch (e) {
    die(`Could not read/parse '${fullPath}': ${e.message}`);
  }

  const result = verifyAuditBundle(bundle, secret, { now: new Date() });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.valid) {
    console.log(`\x1b[32m✓ VALID\x1b[0m  ${fullPath}`);
    console.log(`  content_digest_match:     ${result.content_digest_match}`);
    console.log(`  manifest_signature_valid: ${result.manifest_signature_valid}`);
    console.log(`  events:                   ${result.per_event.length}`);
  } else {
    console.error(`\x1b[31m✗ INVALID / TAMPERED\x1b[0m  ${fullPath}`);
    console.error(`  content_digest_match:     ${result.content_digest_match}`);
    console.error(`  manifest_signature_valid: ${result.manifest_signature_valid}`);
    result.errors.forEach(e => console.error(`  - ${e}`));
  }

  process.exit(result.valid ? 0 : 1);
}

async function cmdAudit(positional, flags, serverUrl, apiKey) {
  if (flags.help) { auditHelp(); return; }

  const sub = positional[1];
  switch (sub) {
    case "export": return cmdAuditExport(positional, flags, serverUrl, apiKey);
    case "verify": return cmdAuditVerify(positional, flags);
    case "render": return cmdAuditRender(positional, flags);
    default:
      auditHelp();
      die("Usage: aep audit <export|verify|render> ...");
  }
}

// ---------------------------------------------------------------------------
// Command: workflow
// ---------------------------------------------------------------------------

function workflowHelp() {
  console.log(`
\x1b[1maep workflow\x1b[0m — Query a full workflow tree by trace_id

Usage:
  aep workflow <trace_id>
`);
}

async function cmdWorkflow(positional, flags, serverUrl, apiKey) {
  if (flags.help) { workflowHelp(); return; }

  const traceId = positional[1];
  if (!traceId) die("Usage: aep workflow <trace_id>");
  if (!apiKey)  die("API key required. Set --key or AEP_API_KEY env var.");

  const res = await request("GET", `${serverUrl}/workflows/${traceId}`, null, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (res.status === 404) {
    die(`Workflow '${traceId}' not found`);
  }
  if (res.status !== 200) {
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const wf = res.body;
  console.log(`Workflow: \x1b[1m${wf.trace_id}\x1b[0m  (${wf.session_count} session${wf.session_count !== 1 ? "s" : ""})`);
  console.log(JSON.stringify(wf.tree, null, 2));
}

// ---------------------------------------------------------------------------
// Command: analytics (Phase 14 PR-D)
// ---------------------------------------------------------------------------

function analyticsHelp() {
  console.log(`
\x1b[1maep analytics\x1b[0m — Policy-enforcement & performance analytics

Usage:
  aep analytics policy-blocked [flags]
  aep analytics performance    [flags]

Subcommands:
  policy-blocked   Aggregate policy.blocked events (what the agent refused, and when)
  performance      Latency profiling: p50/p95/p99 per tool / agent / session / operation

Flags:
  --since  <iso>    Inclusive lower bound on event time (ISO-8601)
  --until  <iso>    Exclusive upper bound on event time (ISO-8601)
  --limit  <n>      Max entries in the recent / slowest list (1-1000, default 20)
  --json            Print the raw JSON response instead of a summary
`);
}

async function cmdAnalyticsPolicyBlocked(flags, serverUrl, apiKey) {
  if (!apiKey) die("API key required. Set --key or AEP_API_KEY env var.");

  const qs = new URLSearchParams();
  if (flags.since) qs.set("since", flags.since);
  if (flags.until) qs.set("until", flags.until);
  if (flags.limit) qs.set("limit", flags.limit);
  const query = qs.toString() ? `?${qs}` : "";

  const res = await request("GET", `${serverUrl}/analytics/policy-blocked${query}`, null, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (res.status !== 200) {
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  if (flags.json) {
    console.log(JSON.stringify(res.body, null, 2));
    return;
  }

  const a = res.body;
  const win = a.window && (a.window.since || a.window.until)
    ? `  (since=${a.window.since || "—"}, until=${a.window.until || "—"})`
    : "";
  console.log(`Policy-blocked events: \x1b[1m${a.total}\x1b[0m${win}`);
  if (a.total === 0) {
    console.log("  (none)");
    return;
  }

  const printBreakdown = (label, rows) => {
    console.log(`\n\x1b[1m${label}\x1b[0m`);
    for (const r of rows) console.log(`  ${String(r.count).padStart(5)}  ${r.key}`);
  };
  printBreakdown("By policy", a.by_policy);
  printBreakdown("By blocked action", a.by_action);

  console.log("\n\x1b[1mBy day\x1b[0m");
  for (const d of a.by_day) console.log(`  ${d.date}  ${d.count}`);

  console.log("\n\x1b[1mMost recent\x1b[0m");
  for (const r of a.recent) {
    // Guard against a missing/malformed time (new Date(bad).toISOString() throws).
    const d = r.time ? new Date(r.time) : null;
    const ts = d && !Number.isNaN(d.getTime())
      ? d.toISOString().replace("T", " ").replace("Z", "")
      : "—";
    console.log(`  \x1b[36m${ts}\x1b[0m  \x1b[33m${r.policy ?? "—"}\x1b[0m  ${r.action_blocked ?? "—"}`);
  }
}

async function cmdAnalyticsPerformance(flags, serverUrl, apiKey) {
  if (!apiKey) die("API key required. Set --key or AEP_API_KEY env var.");

  const qs = new URLSearchParams();
  if (flags.since) qs.set("since", flags.since);
  if (flags.until) qs.set("until", flags.until);
  if (flags.limit) qs.set("limit", flags.limit);
  const query = qs.toString() ? `?${qs}` : "";

  const res = await request("GET", `${serverUrl}/analytics/performance${query}`, null, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (res.status !== 200) {
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  if (flags.json) {
    console.log(JSON.stringify(res.body, null, 2));
    return;
  }

  const a = res.body;
  const win = a.window && (a.window.since || a.window.until)
    ? `  (since=${a.window.since || "—"}, until=${a.window.until || "—"})`
    : "";
  console.log(`Operations: \x1b[1m${a.total_operations}\x1b[0m${win}`);
  if (a.unmatched_ends) console.log(`  (${a.unmatched_ends} unmatched end event(s) skipped)`);
  if (a.total_operations === 0) {
    console.log("  (no completed operations in window)");
    return;
  }

  const o = a.overall;
  console.log(
    `\n\x1b[1mOverall latency (ms)\x1b[0m  p50=${o.p50}  p95=${o.p95}  p99=${o.p99}  ` +
    `min=${o.min}  max=${o.max}  mean=${o.mean}`
  );

  // ms columns: count / p50 / p95 / p99, label last.
  const printStats = (label, rows) => {
    if (!rows.length) return;
    console.log(`\n\x1b[1m${label}\x1b[0m`);
    console.log(`  ${"n".padStart(5)}  ${"p50".padStart(8)}  ${"p95".padStart(8)}  ${"p99".padStart(8)}  key`);
    for (const r of rows) {
      console.log(
        `  ${String(r.count).padStart(5)}  ${String(r.p50).padStart(8)}  ` +
        `${String(r.p95).padStart(8)}  ${String(r.p99).padStart(8)}  ${r.key}`
      );
    }
  };
  // by_session is intentionally omitted from the terminal summary for brevity
  // (it's in the JSON response / `--json` for API consumers that want it).
  printStats("By tool", a.by_tool);
  printStats("By agent", a.by_agent);
  printStats("By operation", a.by_operation);

  console.log("\n\x1b[1mSlowest operations\x1b[0m");
  for (const s of a.slowest) {
    const what = s.name ? `${s.op_type} (${s.name})` : s.op_type;
    console.log(`  \x1b[33m${String(s.duration_ms).padStart(8)}ms\x1b[0m  ${what}  \x1b[36m${s.source}\x1b[0m`);
  }
}

async function cmdAnalytics(positional, flags, serverUrl, apiKey) {
  // `--help` prints usage for the group OR any subcommand (e.g.
  // `analytics performance --help`) before the per-subcommand key check.
  if (flags.help) { analyticsHelp(); return; }

  const sub = positional[1];
  switch (sub) {
    case "policy-blocked": return cmdAnalyticsPolicyBlocked(flags, serverUrl, apiKey);
    case "performance": return cmdAnalyticsPerformance(flags, serverUrl, apiKey);
    default:
      analyticsHelp();
      if (sub) die(`Unknown analytics subcommand: '${sub}'`);
  }
}

// ---------------------------------------------------------------------------
// Command: compliance (Phase 14 PR-F)
// ---------------------------------------------------------------------------

function complianceHelp() {
  console.log(`
\x1b[1maep compliance\x1b[0m — Pre-built compliance report templates

Usage:
  aep compliance report --framework <id> [flags]

Frameworks (--framework):
  soc2 | hipaa | gdpr | eu_ai_act

Flags:
  --framework <id>   REQUIRED: which framework to report against
  --session   <id>   Add an integrity proof-point: verify a bundle for this session
  --trace     <id>   Add an integrity proof-point: verify a bundle for this trace
  --since     <iso>  ISO-8601 lower bound for the policy-enforcement evidence
  --until     <iso>  ISO-8601 upper bound for the policy-enforcement evidence
  --json             Print the raw JSON report
  --out       <file> Write the JSON report to a file
  --pdf       <file> Render a human-readable PDF report to a file
`);
}

const STATUS_MARK = {
  satisfied: "\x1b[32m✓\x1b[0m",
  partial: "\x1b[33m~\x1b[0m",
  unmet: "\x1b[31m✗\x1b[0m",
  not_applicable: "\x1b[90m-\x1b[0m"
};

async function cmdComplianceReport(flags, serverUrl, apiKey) {
  if (!apiKey) die("API key required. Set --key or AEP_API_KEY env var.");
  const framework = flags.framework;
  if (!framework || flags.framework === true) {
    die("Usage: aep compliance report --framework <soc2|hipaa|gdpr|eu_ai_act> [--session id | --trace id] [--pdf out.pdf | --out file.json]");
  }

  const qs = new URLSearchParams({ framework });
  if (flags.session) qs.set("session", flags.session);
  if (flags.trace)   qs.set("trace", flags.trace);
  if (flags.since)   qs.set("since", flags.since);
  if (flags.until)   qs.set("until", flags.until);

  const res = await request("GET", `${serverUrl}/compliance/report?${qs}`, null, {
    Authorization: `Bearer ${apiKey}`,
  });
  if (res.status !== 200) {
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const report = res.body;

  // --pdf: render the JSON report locally (the same renderer the server uses).
  if (flags.pdf !== undefined) {
    const pdfPath = typeof flags.pdf === "string" ? flags.pdf : null;
    if (!pdfPath) die("--pdf needs a filename, e.g. --pdf report.pdf");
    const { renderComplianceReportPdf } = require("./compliance-pdf");
    // Pin `now` to the report's own timestamp so the PDF metadata matches it.
    const pdf = await renderComplianceReportPdf(report, { now: new Date(report.generated_at) });
    require("fs").writeFileSync(pdfPath, pdf);
    console.log(`\x1b[32m✓\x1b[0m Compliance PDF written to ${pdfPath}`);
    return;
  }

  if (flags.out) {
    require("fs").writeFileSync(flags.out, JSON.stringify(report, null, 2) + "\n");
    console.log(`\x1b[32m✓\x1b[0m Compliance report written to ${flags.out}`);
    return;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  // Default: a human-readable summary.
  const s = report.summary;
  console.log(`\x1b[1m${report.framework_name}\x1b[0m  (${report.framework_version})`);
  console.log(`  ${s.satisfied} satisfied · ${s.partial} partial · ${s.unmet} unmet  (of ${s.total_controls})\n`);
  for (const c of report.controls) {
    const mark = STATUS_MARK[c.status] || STATUS_MARK.not_applicable;
    console.log(`  ${mark} \x1b[1m${c.id}\x1b[0m  ${c.title}`);
    console.log(`      ${c.detail}`);
  }
  console.log(`\n\x1b[90m${report.disclaimer}\x1b[0m`);
}

async function cmdCompliance(positional, flags, serverUrl, apiKey) {
  if (flags.help && !positional[1]) { complianceHelp(); return; }

  const sub = positional[1];
  switch (sub) {
    case "report": return cmdComplianceReport(flags, serverUrl, apiKey);
    default:
      complianceHelp();
      if (sub) die(`Unknown compliance subcommand: '${sub}'`);
  }
}

// ---------------------------------------------------------------------------
// Command: validate (thin wrapper around existing cli-validate.js logic)
// ---------------------------------------------------------------------------

function validateHelp() {
  console.log(`
\x1b[1maep validate\x1b[0m — Validate a local event JSON file against the AEP schema

Usage:
  aep validate <path-to-json>
`);
}

async function cmdValidate(positional, flags) {
  if (flags.help) { validateHelp(); return; }

  const filePath = positional[1];
  if (!filePath) die("Usage: aep validate <path-to-json>");

  const fs = require("fs");
  const path = require("path");
  const { validateEvent } = require("./validator");

  const fullPath = path.resolve(filePath);
  let parsed;
  try {
    const raw = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
    parsed = JSON.parse(raw);
  } catch (e) {
    die(`Could not read/parse '${fullPath}': ${e.message}`);
  }

  const events = Array.isArray(parsed) ? parsed : [parsed];
  let failures = 0;

  for (let i = 0; i < events.length; i++) {
    const result = validateEvent(events[i]);
    if (!result.valid) {
      failures++;
      console.error(`\x1b[31mEvent[${i}] INVALID\x1b[0m`);
      result.errors.forEach(e => console.error(`  - ${e}`));
    } else {
      console.log(`\x1b[32mEvent[${i}] VALID\x1b[0m  (${events[i].type} / ${events[i].id})`);
    }
  }

  if (failures > 0) process.exit(2);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main() {
  const { flags, positional } = parseArgs(process.argv);

  const serverUrl = (flags.server || process.env.AEP_SERVER || "http://localhost:8787").replace(/\/$/, "");
  const apiKey    = flags.key || process.env.AEP_API_KEY || null;

  const command = positional[0];

  if (!command) {
    printUsage();
    return;
  }

  try {
    switch (command) {
      case "emit":     await cmdEmit(flags, serverUrl, apiKey); break;
      case "session":  await cmdSession(positional, flags, serverUrl, apiKey); break;
      case "export":   await cmdExport(positional, flags, serverUrl, apiKey); break;
      case "audit":    await cmdAudit(positional, flags, serverUrl, apiKey); break;
      case "workflow": await cmdWorkflow(positional, flags, serverUrl, apiKey); break;
      case "analytics": await cmdAnalytics(positional, flags, serverUrl, apiKey); break;
      case "compliance": await cmdCompliance(positional, flags, serverUrl, apiKey); break;
      case "validate": await cmdValidate(positional, flags); break;
      default:
        console.error(`Unknown command: '${command}'\n`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    die(err.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

module.exports = { parseArgs };

main();
