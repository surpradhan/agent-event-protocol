#!/usr/bin/env node
"use strict";

/**
 * aep — Agent Event Protocol CLI
 *
 * Commands:
 *   aep emit     — Emit a single event to the ingest server
 *   aep session  — Query events for a session
 *   aep export   — Export session events as JSON or CSV
 *   aep workflow — Query a full workflow tree by trace_id
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
  workflow   Query a full workflow tree by trace_id
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
      case "workflow": await cmdWorkflow(positional, flags, serverUrl, apiKey); break;
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

main();
