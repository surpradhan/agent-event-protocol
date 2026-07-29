#!/usr/bin/env node
"use strict";

/**
 * aep — Agent Event Protocol CLI
 *
 * Commands:
 *   aep emit       — Emit a single event to the ingest server
 *   aep session    — Query events for a session
 *   aep export     — Export session events as JSON or CSV
 *   aep export bulk— Bulk DB export (wraps src/export.js)
 *   aep audit      — Build / verify / render a tamper-evident audit bundle
 *   aep workflow   — Query a full workflow tree by trace_id
 *   aep analytics  — Policy-enforcement, performance, custom & anomaly analytics
 *   aep metrics    — Print server metrics (GET /metrics, JSON) for this tenant
 *   aep webhooks   — Register & manage outbound webhooks
 *   aep compliance — Compliance report templates (SOC2/HIPAA/GDPR/EU AI Act)
 *   aep admin      — Manage API keys (create / list / delete)
 *   aep init       — Guided first-run onboarding wizard
 *   aep validate   — Validate a local event JSON file (existing)
 *
 * Configuration (in priority order):
 *   1. CLI flags:  --server <url>  --key <api-key>  --admin-token <token>  --timeout <secs>
 *   2. Env vars:   AEP_SERVER      AEP_API_KEY        ADMIN_TOKEN / AEP_ADMIN_TOKEN   AEP_TIMEOUT
 *   3. Defaults:   http://localhost:8787  (no key)  30s timeout
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

/** Default socket-inactivity timeout for an outbound request, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30000;

/** Inactivity timeout applied to every outbound request, in milliseconds.
 *
 *  Module state rather than a parameter: request() is called from ~30 sites
 *  that have no business knowing about it, and the value is process-wide —
 *  main() resolves it once from --timeout / AEP_TIMEOUT before dispatching.
 *  0 disables the timeout entirely. */
let requestTimeoutMs = DEFAULT_TIMEOUT_MS;

/** Resolve --timeout / AEP_TIMEOUT into milliseconds.
 *
 *  Seconds on the way in, like curl's --max-time — nobody wants to type a
 *  millisecond count. 0 disables the timer for a legitimately slow transfer.
 *  Note the timer measures *inactivity*, not total duration (see armTimeout),
 *  so a large export that keeps streaming never trips it. */
function resolveTimeoutMs(flags, env = process.env) {
  const fromFlag = flags.timeout !== undefined;
  const raw = fromFlag ? requireFlagValue(flags, "timeout") : env.AEP_TIMEOUT;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    // Name whichever of the two actually supplied the bad value — a bare
    // "--timeout must be…" would send an AEP_TIMEOUT typo hunting the wrong
    // place, since no --timeout was ever passed.
    const source = fromFlag ? "--timeout" : "AEP_TIMEOUT";
    die(`${source} must be a non-negative number of seconds (0 disables), got '${raw}'`);
  }
  if (seconds === 0) return 0;
  // A tiny-but-positive value must not round down to 0, which would read as
  // "disabled" and reintroduce the hang the flag exists to prevent. At the
  // other end, setTimeout's delay is a 32-bit signed int; anything above that
  // overflows and fires a TimeoutOverflowWarning instead of ever timing out —
  // cap it, since a value this large means "effectively never" either way.
  return Math.min(Math.max(1, Math.round(seconds * 1000)), 2 ** 31 - 1);
}

/** Arm the inactivity timeout on a request. Returns a disarm() to call once
 *  the request settles, by whatever path — success, a non-timeout failure, or
 *  the timeout itself.
 *
 *  Node's setTimeout only *notifies* — it does not abort — so the socket has to
 *  be destroyed here, or the CLI goes back to waiting on a server that has
 *  stopped talking. The timer is idle-based: it resets on every byte, which is
 *  what lets a slow-but-progressing export run past it.
 *
 *  Disarming matters because http(s).globalAgent keep-alives by default: a
 *  command that makes several sequential requests to the same host (`aep
 *  init`'s health-check → mint-key → verify-event) can reuse one socket.
 *  socket.setTimeout(ms, cb) *adds* cb as a 'timeout' listener rather than
 *  replacing whatever the previous request on that socket registered — Node
 *  never removes it just because that request finished — so without an
 *  explicit removeListener, every request's callback stays live and a later
 *  idle period fires all of them at once. */
function armTimeout(req, fail, ms = requestTimeoutMs) {
  if (ms <= 0) return () => {};
  const onIdle = () => {
    // Report first, destroy second: destroying emits further events, and the
    // timeout is the cause worth printing, not the cleanup it triggers.
    fail(Object.assign(
      new Error(`no data for ${ms / 1000}s (raise --timeout, or set it to 0 to disable)`),
      { code: "ETIMEDOUT" }
    ));
    req.destroy();
  };
  let armedSocket = null;
  // req.setTimeout() defers arming until a socket is attached, and for a fresh
  // connection that happens on 'connect' — so a plain req.setTimeout() rides
  // Node's own connect timeout (~5s) while the socket is still connecting,
  // ignoring --timeout entirely until after it succeeds. socket.setTimeout()
  // has no such gap: armed the moment the socket exists, whether still
  // connecting or already established, it covers both phases with one timer —
  // using req.setTimeout() as well here would attach a second, independent
  // listener for the same event and fire onIdle twice.
  const onSocket = (socket) => {
    armedSocket = socket;
    socket.setTimeout(ms, onIdle);
  };
  req.on("socket", onSocket);
  return function disarm() {
    req.removeListener("socket", onSocket);
    // Only remove our own listener — not socket.setTimeout(0), which would
    // also cancel whatever timer a *different* request now sharing this
    // (kept-alive) socket has since armed.
    if (armedSocket) armedSocket.removeListener("timeout", onIdle);
  };
}

/** The error a truncated response reports.
 *
 *  'aborted' carries no error object of its own, so synthesise one shaped like
 *  a socket error — code first — so describeError renders it in the same
 *  "could not reach <target> (…)" line as a refused connection. */
function truncatedResponseError() {
  return Object.assign(
    new Error("the server closed the connection before the response was complete"),
    { code: "ECONNRESET" }
  );
}

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

    // A dying connection is chatty: a truncated response emits 'aborted' and
    // then 'error', and a tripped timeout destroys the socket, which emits more
    // still. Only the first of those is the cause; the rest describe the
    // cleanup. Settling once keeps the reported reason the real one.
    let settled = false;
    // Reassigned once armTimeout() runs below; declared first so fail/succeed
    // can close over it regardless of call order.
    let disarm = () => {};
    // Name the server we failed to reach; the raw error doesn't (see describeError).
    const fail = (err) => {
      if (settled) return;
      settled = true;
      disarm();
      reject(new Error(describeError(err, targetOf(url)), { cause: err }));
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      disarm();
      resolve(value);
    };

    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        succeed({ status: res.statusCode, body: parsed, rawBody: data, headers: res.headers });
      });
      // A response can die after its headers arrived. Neither event had a
      // listener, so the promise simply never settled and the CLI hung.
      res.on("aborted", () => fail(truncatedResponseError()));
      res.on("error", fail);
    });

    req.on("error", fail);
    disarm = armTimeout(req, fail);
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

/** The origin of a URL, for use in an error message.
 *
 *  Prefer `origin` — unlike `href` it drops any userinfo, so a server URL of
 *  the form http://user:pass@host can't put a password on stderr. WHATWG
 *  returns the *string* "null" for a non-special scheme (a typo'd
 *  `--server foo://…`), which would read as "could not reach null". */
function targetOf(url) {
  return url.origin && url.origin !== "null" ? url.origin : `${url.protocol}//${url.host}`;
}

/** How many distinct causes to name before summarising the rest. */
const MAX_CAUSES = 5;

/** Squash an error string onto one terminal line.
 *
 *  OpenSSL-backed messages arrive multi-line and carry a trailing newline plus
 *  a path into node's deps/, none of which belongs in a one-line `Error:`. */
function oneLine(text, max = 160) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Connection codes whose message is typically just "<syscall> <code> <address>".
 *
 *  Membership alone isn't enough to drop the message — the same code can arrive
 *  with a message that explains something (ECONNRESET's is "socket hang up",
 *  which restates neither the syscall nor the code). See restatesCode. */
const TERSE_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
]);

/** Does this message merely restate the code, i.e. "connect ECONNREFUSED <addr>"?
 *
 *  Node puts the syscall first and the code second. Checking the position (not
 *  just "contains") matters: an EPROTO message embeds "EPROTO" mid-string and
 *  then explains the actual TLS problem, which must survive. Anything after the
 *  code is an address — sometimes with a local-address suffix on Windows — and
 *  the error line already names the target. */
function restatesCode(message, code) {
  // Normalise first: the raw message may carry leading or doubled whitespace,
  // and oneLine() only flattens it later, after this decision has been made.
  const words = String(message).trim().split(/\s+/);
  return words[1] === code || (words.length === 1 && words[0] === code);
}

/** Render a thrown/rejected error as one line of terminal detail.
 *
 *  Node dials every address a host resolves to (happy eyeballs) and, when they
 *  all fail, rejects with an AggregateError whose own `.message` is empty — so
 *  the obvious `err.message || String(err)` prints a bare "AggregateError" and
 *  throws away every useful cause. The causes live in `.errors[]`, one per
 *  address tried, so unwrap them (recursively — an AggregateError may nest).
 *
 *  Pass `target` at a call site that knows what it was talking to. That form
 *  leads with the error code, dropping the message only for the codes whose
 *  message restates it (see TERSE_ERROR_CODES) — which is what collapses the
 *  IPv6/IPv4 attempts into a single ECONNREFUSED, while leaving a TLS failure's
 *  reason intact. Without a target the message is the more informative half —
 *  compare "ENOENT" with "ENOENT: no such file or directory, open 'x.json'" —
 *  so the preference flips.
 *
 *  This runs on the failure path, including inside a socket 'error' handler, so
 *  it must not throw: a hostile or exotic error object (throwing getter, cyclic
 *  `.errors`, null prototype) has to degrade to a worse message, never to a
 *  crash. */
function describeError(err, target = null) {
  const label = target
    ? (e) => {
      if (!e.code) return e.message;
      if (!e.message) return e.code;
      // Drop the message only when it says nothing the code and the target
      // don't. That collapses happy eyeballs' per-address attempts into one
      // cause, while keeping "socket hang up" and every TLS reason.
      if (TERSE_ERROR_CODES.has(e.code) && restatesCode(e.message, e.code)) return e.code;
      return `${e.code}: ${e.message}`;
    }
    : (e) => e.message || e.code;

  const causes = new Set();
  const seen = new Set();

  /** Collect this node's cause, or its children's. Returns whether anything
   *  described it — which is the signal to stop, not the size of `causes`, since
   *  a child whose label duplicates a sibling's adds nothing to the Set. */
  const collect = (e) => {
    if (!e || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e); // cyclic .errors would otherwise recurse until the stack blows
    try {
      // Descend only when the children actually describe something. `.errors`
      // is not exclusive to AggregateError — a validation error may hang plain
      // objects there that carry neither message nor code, and losing the
      // parent's own message to them would regress what `err.message` gave.
      if (Array.isArray(e.errors) && e.errors.length > 0) {
        let described = false;
        for (const child of e.errors) {
          if (collect(child)) described = true;
        }
        if (described) return true;
      }
      const text = label(e);
      if (!text) return false;
      // Keep one past the cap so the caller can tell "exactly MAX" from "more".
      if (causes.size <= MAX_CAUSES) causes.add(oneLine(text));
      return true;
    } catch (_) {
      // A getter threw. Skip this node rather than lose the whole report.
      return false;
    }
  };
  collect(err);

  const listed = [...causes];
  let detail = listed.slice(0, MAX_CAUSES).join(", ");
  if (listed.length > MAX_CAUSES) detail += ", …";
  if (!detail) {
    try { detail = String(err); } catch (_) { detail = "unknown error"; }
  }
  return target ? `could not reach ${target} (${detail})` : detail;
}

function ok(label, data) {
  if (data !== undefined) {
    console.log(`\x1b[32m✓\x1b[0m ${label}`);
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`\x1b[32m✓\x1b[0m ${label}`);
  }
}

/** Read a flag that must carry a value.
 *
 *  parseArgs turns a bare `--since` (no value, or followed by another flag)
 *  into boolean `true`; forwarding that verbatim sends `?since=true` and costs
 *  an authenticated round-trip to learn about a local typo. Returns undefined
 *  when the flag is absent, so callers can distinguish "not given" from "empty".
 *
 *  Used by `--timeout` (all commands), `metrics`, `analytics
 *  policy-blocked`/`performance`/`anomalies`, `webhooks deliveries`,
 *  `compliance report`, `session`, `export`, `audit export`, and
 *  `export bulk` for their since/until/limit/threshold/session/trace/type/q
 *  and export-option filters. */
function requireFlagValue(flags, name) {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (raw === true || String(raw).trim() === "") die(`--${name} requires a value`);
  return String(raw);
}

/** Format an ISO-8601 timestamp for human-readable CLI list output:
 *  "2026-06-12T14:32:01.000Z" → "2026-06-12 14:32:01Z" (UTC, millis dropped).
 *  Returns the raw value unchanged if it isn't a parseable date. */
function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function printUsage() {
  console.log(`
\x1b[1mAEP CLI — Agent Event Protocol\x1b[0m

Usage:
  aep <command> [flags]

Commands:
  init        Guided first-run onboarding wizard
  emit        Emit a single event to the ingest server
  session     Query events for a session
  export      Export session events as JSON or CSV
  export bulk Bulk DB export to local filesystem or S3
  audit       Build / verify / render a tamper-evident audit bundle
  workflow    Query a full workflow tree by trace_id
  analytics   Policy-enforcement, performance, custom & anomaly analytics
  metrics     Print this tenant's server metrics (GET /metrics) as JSON
  webhooks    Register & manage outbound webhooks
  compliance  Compliance report templates (SOC2/HIPAA/GDPR/EU AI Act)
  admin       Manage API keys (create / list / delete)
  validate    Validate a local event JSON file

Global flags:
  --server      <url>    AEP server URL  (env: AEP_SERVER, default: http://localhost:8787)
  --key         <token>  API key         (env: AEP_API_KEY)
  --admin-token <token>  Admin token     (env: ADMIN_TOKEN or AEP_ADMIN_TOKEN)
  --timeout     <secs>   Give up after <secs> with no data from the server
                         (env: AEP_TIMEOUT, default: 30, 0 disables)
  --help                 Show this help

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
  --json                 Print the raw server response as JSON (for scripting)
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

  if (flags.json) {
    // Machine-readable: emit the raw server response, preserve the failure exit
    // code so scripts can branch on $? as well as on the JSON body.
    console.log(JSON.stringify(res.body, null, 2));
    const okStatus = res.status === 202 || (res.status === 200 && res.body && res.body.duplicate);
    if (!okStatus) process.exit(1);
    return;
  }

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
  --json          Print the raw server response as JSON (for scripting)
`);
}

async function cmdSession(positional, flags, serverUrl, apiKey) {
  if (flags.help) { sessionHelp(); return; }

  const sessionId = positional[1];
  if (!sessionId) die("Usage: aep session <session_id> [--type filter] [--q search]");
  if (!apiKey)    die("API key required. Set --key or AEP_API_KEY env var.");

  const type = requireFlagValue(flags, "type");
  const q    = requireFlagValue(flags, "q");

  const qs = new URLSearchParams();
  if (type !== undefined) qs.set("type", type);
  if (q    !== undefined) qs.set("q", q);
  const query = qs.toString() ? `?${qs}` : "";

  const res = await request("GET", `${serverUrl}/sessions/${sessionId}/events${query}`, null, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (res.status !== 200) {
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  if (flags.json) {
    console.log(JSON.stringify(res.body, null, 2));
    return;
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

  const type = requireFlagValue(flags, "type");
  const q    = requireFlagValue(flags, "q");

  const qs = new URLSearchParams({ format });
  if (type !== undefined) qs.set("type", type);
  if (q    !== undefined) qs.set("q", q);

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

    let settled = false;
    let sink = null;      // write stream for --out, once bytes may have reached it
    let streaming = false; // response body started flowing (to stdout or a file)
    // Reassigned once armTimeout() runs below; declared first so rejectOnce/
    // succeed can close over it regardless of call order.
    let disarm = () => {};

    // This command streams the response, so it builds its own request rather
    // than going through request() — it needs the same settle-once handling and
    // error context, plus a word about the half-written export, which a bare
    // connection error would leave the caller to find in a truncated file.
    const rejectOnce = (message, err) => {
      if (settled) return;
      settled = true;
      disarm();
      reject(new Error(message, { cause: err }));
    };
    const fail = (err) => {
      if (settled) return;
      // Say what happened to the half-written export on its own line: the
      // error line is capped to terminal width (see oneLine), and a long
      // --out path is exactly what would be clipped off the end of it.
      if (sink) {
        // pipe() only calls end() on the response's 'end', so 'finish' can
        // never fire here — close it explicitly rather than leaking the fd.
        sink.destroy();
        console.error(`\x1b[33m!\x1b[0m Incomplete export left in ${flags.out}`);
      } else if (streaming) {
        console.error("\x1b[33m!\x1b[0m The export above is incomplete");
      }
      rejectOnce(describeError(err, targetOf(url)), err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      disarm();
      resolve();
    };

    const req = lib.request(opts, (res) => {
      if (res.statusCode !== 200) {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => { die(`Server returned HTTP ${res.statusCode}: ${data}`); });
        res.on("aborted", () => fail(truncatedResponseError()));
        res.on("error", fail);
        return;
      }
      // Same hang as request(): with nothing listening for a dead response, a
      // server that quit mid-body left this promise pending forever.
      res.on("aborted", () => fail(truncatedResponseError()));
      res.on("error", fail);
      if (flags.out) {
        const fs = require("fs");
        const ws = fs.createWriteStream(flags.out);
        sink = ws;
        res.pipe(ws);
        ws.on("finish", () => {
          console.log(`\x1b[32m✓\x1b[0m Exported to ${flags.out}`);
          succeed();
        });
        // A write failure is local — an unwritable path, a full disk. Blaming
        // the server ("could not reach …") would send the reader the wrong way.
        ws.on("error", (err) => {
          sink = null; // errored streams self-destruct; nothing left to close
          // An fs error's message already repeats the path (e.g. "ENOENT: no
          // such file or directory, open '<path>'"), so pairing it with
          // describeError(err) here would print the path twice — and on a long
          // one, oneLine's 160-char cap would clip the copy that still carried
          // the reason. err.code alone says enough next to the path we already
          // printed; fall back to describeError only when there's no code.
          //
          // main()'s catch still runs this whole string through describeError,
          // which applies the same 160-char cap to it as one line — so a
          // pathological --out (over ~140 chars) can still lose the code off
          // the end. Not chased further: that cap is a deliberate, existing
          // guard applied uniformly to every error this CLI prints (it exists
          // to keep terminal output readable), and special-casing this one
          // call site around it would fight the guard rather than respect it.
          rejectOnce(`could not write ${flags.out}: ${err.code || describeError(err)}`, err);
        });
      } else {
        // Only claim something printed once a byte actually reached stdout —
        // a die-before-first-chunk failure (e.g. the response aborts right
        // after headers) must not print "the export above is incomplete"
        // above nothing.
        res.once("data", () => { streaming = true; });
        res.pipe(process.stdout);
        res.on("end", succeed);
      }
    });
    req.on("error", fail);
    disarm = armTimeout(req, fail);
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

  // Cheap local checks before the AUDIT_SIGNING_SECRET requirement, so a typo'd
  // flag is reported on its own terms rather than behind an unrelated env-var error.
  const type = requireFlagValue(flags, "type");
  const q    = requireFlagValue(flags, "q");

  const secret = readAuditSecret();
  const { buildAuditBundle } = require("./audit");

  const qs = new URLSearchParams({ format: "json" });
  if (type !== undefined) qs.set("type", type);
  if (q    !== undefined) qs.set("q", q);

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
  aep workflow <trace_id> [flags]

Flags:
  --graph   Fetch the cross-session causation graph (nodes + edges) instead of
            the session tree; cross-session causation edges are flagged.
  --json    With --graph, print the raw JSON graph (default prints a summary)
`);
}

async function cmdWorkflow(positional, flags, serverUrl, apiKey) {
  if (flags.help) { workflowHelp(); return; }

  const traceId = positional[1];
  if (!traceId) die("Usage: aep workflow <trace_id> [--graph]");
  if (!apiKey)  die("API key required. Set --key or AEP_API_KEY env var.");

  if (flags.graph) {
    const res = await request("GET", `${serverUrl}/workflows/${encodeURIComponent(traceId)}/graph`, null, {
      Authorization: `Bearer ${apiKey}`,
    });
    if (res.status === 404) die(`Workflow '${traceId}' not found`);
    if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);

    const g = res.body;
    if (flags.json) { console.log(JSON.stringify(g, null, 2)); return; }
    console.log(`Workflow graph: \x1b[1m${g.trace_id}\x1b[0m`);
    console.log(`  ${g.event_count} event(s) across ${g.session_count} session(s)`);
    console.log(`  ${g.edge_count} causation edge(s), \x1b[35m${g.cross_session_edge_count} cross-session\x1b[0m`);
    console.log("\n\x1b[1mSessions\x1b[0m");
    for (const s of g.sessions) {
      const role = s.agent_role ? ` \x1b[36m[${s.agent_role}]\x1b[0m` : "";
      console.log(`  ${String(s.event_count).padStart(4)}  ${s.session_id}${role}`);
    }
    return;
  }

  const res = await request("GET", `${serverUrl}/workflows/${encodeURIComponent(traceId)}`, null, {
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
\x1b[1maep analytics\x1b[0m — Policy-enforcement, performance, custom & anomaly analytics

Usage:
  aep analytics policy-blocked [flags]
  aep analytics performance    [flags]
  aep analytics query          [flags]
  aep analytics anomalies      [flags]

Subcommands:
  policy-blocked   Aggregate policy.blocked events (what the agent refused, and when)
  performance      Latency profiling: p50/p95/p99 per tool / agent / session / operation
  query            Run / save / list user-defined custom-analytics queries (safe, structured)
  anomalies        Flag workflows that deviate from baseline (error-rate / policy.blocked / latency)

Flags (policy-blocked / performance):
  --since  <iso>    Inclusive lower bound on event time (ISO-8601)
  --until  <iso>    Exclusive upper bound on event time (ISO-8601)
  --limit  <n>      Max entries in the recent / slowest list (1-1000, default 20)
  --json            Print the raw JSON response instead of a summary

Flags (anomalies):
  --since <iso>     Inclusive lower bound on event time (ISO-8601)
  --until <iso>     Exclusive upper bound on event time (ISO-8601)
  --threshold <n>   Modified-z cutoff (>0, default 3.5; smaller = more sensitive)
  --limit <n>       Max anomalies returned (1-1000, default 50)
  --json            Print the raw JSON response instead of a summary

Flags (query):
  --file <path>     Read a JSON query spec from a file (use '-' for stdin)
  --spec <json>     Inline JSON query spec (alternative to --file)
  --save <name>     Save the --file/--spec query to the tenant library (needs a write key)
  --list            List saved queries for the tenant
  --run  <id>       Run a saved query by id
  --delete <id>     Delete a saved query by id (needs a write key)
  --json            Print the raw JSON response
`);
}

async function cmdAnalyticsPolicyBlocked(flags, serverUrl, apiKey) {
  if (!apiKey) die("API key required. Set --key or AEP_API_KEY env var.");

  const qs = new URLSearchParams();
  const since = requireFlagValue(flags, "since");
  const until = requireFlagValue(flags, "until");
  const limit = requireFlagValue(flags, "limit");
  if (since !== undefined) qs.set("since", since);
  if (until !== undefined) qs.set("until", until);
  if (limit !== undefined) qs.set("limit", limit);
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
  const since = requireFlagValue(flags, "since");
  const until = requireFlagValue(flags, "until");
  const limit = requireFlagValue(flags, "limit");
  if (since !== undefined) qs.set("since", since);
  if (until !== undefined) qs.set("until", until);
  if (limit !== undefined) qs.set("limit", limit);
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

/** Load a JSON query spec from --file (path or '-' for stdin) or --spec (inline). */
function loadQuerySpec(flags) {
  let raw;
  if (flags.spec) {
    raw = String(flags.spec);
  } else if (flags.file) {
    const fs = require("fs");
    raw =
      flags.file === "-"
        ? fs.readFileSync(0, "utf8")
        : fs.readFileSync(require("path").resolve(String(flags.file)), "utf8");
    raw = raw.replace(/^\uFEFF/, "");
  } else {
    die("Provide a query spec with --file <path> or --spec '<json>'.");
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`Could not parse query spec JSON: ${e.message}`);
  }
}

async function cmdAnalyticsQuery(flags, serverUrl, apiKey) {
  if (!apiKey) die("API key required. Set --key or AEP_API_KEY env var.");
  const auth = { Authorization: `Bearer ${apiKey}` };
  const show = (body) => console.log(JSON.stringify(body, null, 2));

  // --list / --run / --delete operate on the saved-query library.
  if (flags.list) {
    const res = await request("GET", `${serverUrl}/analytics/saved-queries`, null, auth);
    if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    const rows = res.body.saved_queries || [];
    if (flags.json) return show(res.body);
    if (rows.length === 0) { console.log("(no saved queries)"); return; }
    for (const q of rows) console.log(`  \x1b[36m${q.id}\x1b[0m  \x1b[1m${q.name}\x1b[0m  (${fmtTs(q.created_at)})`);
    return;
  }

  if (flags.run) {
    const res = await request("POST", `${serverUrl}/analytics/saved-queries/${encodeURIComponent(flags.run)}/run`, {}, auth);
    if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    return show(res.body);
  }

  if (flags.delete) {
    const res = await request("DELETE", `${serverUrl}/analytics/saved-queries/${encodeURIComponent(flags.delete)}`, null, auth);
    if (res.status === 204) { console.log("Deleted."); return; }
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  // Otherwise we need a spec (from --file/--spec): either save it or run it ad-hoc.
  const spec = loadQuerySpec(flags);

  if (flags.save) {
    const res = await request("POST", `${serverUrl}/analytics/saved-queries`, { name: String(flags.save), spec }, auth);
    if (res.status !== 201) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    console.log(`Saved query \x1b[1m${res.body.name}\x1b[0m as \x1b[36m${res.body.id}\x1b[0m`);
    return;
  }

  const res = await request("POST", `${serverUrl}/analytics/query`, spec, auth);
  if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  show(res.body);
}

async function cmdAnalyticsAnomalies(flags, serverUrl, apiKey) {
  if (!apiKey) die("API key required. Set --key or AEP_API_KEY env var.");

  const qs = new URLSearchParams();
  const since = requireFlagValue(flags, "since");
  const until = requireFlagValue(flags, "until");
  const threshold = requireFlagValue(flags, "threshold");
  const limit = requireFlagValue(flags, "limit");
  if (since !== undefined) qs.set("since", since);
  if (until !== undefined) qs.set("until", until);
  if (threshold !== undefined) qs.set("threshold", threshold);
  if (limit !== undefined) qs.set("limit", limit);
  const query = qs.toString() ? `?${qs}` : "";

  const res = await request("GET", `${serverUrl}/analytics/anomalies${query}`, null, {
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
  console.log(`Anomalies: \x1b[1m${a.anomaly_count}\x1b[0m across ${a.trace_count} workflow(s)  (threshold=${a.threshold} modified-z)`);
  if (a.anomaly_count === 0) {
    console.log("  (no workflows deviate from the baseline)");
    return;
  }
  const sevColor = { critical: "\x1b[31m", high: "\x1b[33m", medium: "\x1b[36m", low: "\x1b[90m" };
  for (const an of a.anomalies) {
    const col = sevColor[an.severity] || "";
    console.log(`\n  ${col}${an.severity.toUpperCase()}\x1b[0m  \x1b[1m${an.trace_id}\x1b[0m  (max score ${an.max_score.toFixed(1)})`);
    for (const f of an.flags) {
      console.log(`    ${f.metric} = ${typeof f.value === "number" ? f.value.toFixed(2).replace(/\.00$/, "") : f.value}  (baseline≈${f.baseline_median.toFixed(2)}, score ${f.score.toFixed(1)})`);
    }
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
    case "query": return cmdAnalyticsQuery(flags, serverUrl, apiKey);
    case "anomalies": return cmdAnalyticsAnomalies(flags, serverUrl, apiKey);
    default:
      analyticsHelp();
      if (sub) die(`Unknown analytics subcommand: '${sub}'`);
  }
}

// ---------------------------------------------------------------------------
// Command: metrics (issue #112)
// ---------------------------------------------------------------------------

function metricsHelp() {
  console.log(`
\x1b[1maep metrics\x1b[0m — Print this tenant's server metrics as JSON

Usage:
  aep metrics [--since <iso>] [--until <iso>]

Flags:
  --since <iso>   Only count events/sessions at or after this ISO-8601 timestamp
  --until <iso>   Only count events/sessions before this ISO-8601 timestamp

Fetches GET /metrics — the JSON endpoint, NOT the Prometheus scrape endpoint at
/metrics/prometheus — and prints the response body. Requires a read-scoped API key.

Response fields: accepted, byType, session_count, workflow_count,
subagent_session_count, max_tree_depth, signatures. The counters received,
rejected and duplicates are process-wide rather than per-tenant, so a
tenant-scoped request — any read-scoped API key — reports them as 0. A caller
the server treats as full-read (dev-mode open reads, or a DASHBOARD_TOKEN
passed as --key) sees the real lifetime totals instead.

--since/--until window the event and session counts only; signatures is
process-wide telemetry, and max_tree_depth is reported as 0 (a depth over an
arbitrary window isn't meaningful). A windowed response echoes the window back
as a "windowed" field.

Output is always JSON, so there is no --json flag.
`);
}

async function cmdMetrics(positional, flags, serverUrl, apiKey) {
  if (flags.help) { metricsHelp(); return; }
  // 'metrics' takes no subcommand. Without this guard a plausible typo like
  // `aep metrics prometheus` would silently print the JSON metrics instead.
  // Length, not truthiness — `aep metrics ""` is still a subcommand that isn't one.
  if (positional.length > 1) {
    die(`'aep metrics' takes no subcommand (got '${positional[1]}'). For the Prometheus scrape endpoint, GET ${serverUrl}/metrics/prometheus directly.`);
  }
  if (!apiKey) die("API key required. Set --key or AEP_API_KEY env var.");

  const qs = new URLSearchParams();
  const since = requireFlagValue(flags, "since");
  const until = requireFlagValue(flags, "until");
  if (since !== undefined) qs.set("since", since);
  if (until !== undefined) qs.set("until", until);
  const query = qs.toString() ? `?${qs}` : "";

  const res = await request("GET", `${serverUrl}/metrics${query}`, null, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (res.status !== 200) {
    die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  console.log(JSON.stringify(res.body, null, 2));
}

// ---------------------------------------------------------------------------
// Command: webhooks (Phase 16-A)
// ---------------------------------------------------------------------------

function webhooksHelp() {
  console.log(`
\x1b[1maep webhooks\x1b[0m — Register & manage outbound webhooks

Usage:
  aep webhooks list
  aep webhooks get    <id>
  aep webhooks create --url <target> [--events <list>] [--disabled]
  aep webhooks update <id> [--url <target>] [--events <list>] [--enable | --disable]
  aep webhooks delete <id>
  aep webhooks deliveries <id> [--since iso] [--until iso] [--limit n]

Flags:
  --url     <target>   Target URL (http/https; SSRF-guarded — no private/loopback hosts)
  --events  <list>     Comma-separated event types, or '*' for all (default: '*')
                       e.g. --events error.raised,task.failed
  --disabled           Create the webhook disabled (no deliveries until enabled)
  --enable | --disable Toggle the enabled flag on update
  --since/--until/--limit  Filter delivery history (deliveries subcommand)
  --json               Print the raw JSON response

Note: 'create' returns a one-time signing_secret (shown only once) — store it.
Deliveries carry an X-AEP-Signature: hmac-sha256=<base64> header (verify over the raw body).
`);
}

/** Parse --events into the array the API expects (["*"] or a list of types). */
function parseEventTypesFlag(raw) {
  if (raw === undefined) return undefined;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function printWebhook(w) {
  const state = w.enabled ? "\x1b[32menabled\x1b[0m" : "\x1b[90mdisabled\x1b[0m";
  console.log(`  \x1b[36m${w.id}\x1b[0m  ${state}  ${w.target_url}`);
  console.log(`    events: ${w.event_types.join(", ")}  (created ${fmtTs(w.created_at)})`);
}

async function cmdWebhooks(positional, flags, serverUrl, apiKey) {
  if (flags.help) { webhooksHelp(); return; }
  if (!apiKey) die("API key required. Set --key or AEP_API_KEY env var.");
  const auth = { Authorization: `Bearer ${apiKey}` };
  const sub = positional[1];
  const id = positional[2];
  const show = (body) => console.log(JSON.stringify(body, null, 2));

  switch (sub) {
    case "list": {
      const res = await request("GET", `${serverUrl}/webhooks`, null, auth);
      if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      if (flags.json) return show(res.body);
      const rows = res.body.webhooks || [];
      if (rows.length === 0) { console.log("(no webhooks)"); return; }
      rows.forEach(printWebhook);
      return;
    }
    case "get": {
      if (!id) die("Usage: aep webhooks get <id>");
      const res = await request("GET", `${serverUrl}/webhooks/${encodeURIComponent(id)}`, null, auth);
      if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      return show(res.body);
    }
    case "create": {
      if (!flags.url || flags.url === true) die("Usage: aep webhooks create --url <target> [--events <list>] [--disabled]");
      const body = { target_url: String(flags.url) };
      const events = parseEventTypesFlag(flags.events);
      if (events) body.event_types = events;
      if (flags.disabled) body.enabled = false;
      const res = await request("POST", `${serverUrl}/webhooks`, body, auth);
      if (res.status !== 201) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      console.log(`Created webhook \x1b[36m${res.body.id}\x1b[0m → ${res.body.target_url}`);
      if (flags.json) show(res.body);
      return;
    }
    case "update": {
      if (!id) die("Usage: aep webhooks update <id> [--url <target>] [--events <list>] [--enable | --disable]");
      if (flags.enable && flags.disable) die("--enable and --disable are mutually exclusive");
      const body = {};
      if (flags.url && flags.url !== true) body.target_url = String(flags.url);
      const events = parseEventTypesFlag(flags.events);
      if (events) body.event_types = events;
      if (flags.enable) body.enabled = true;
      if (flags.disable) body.enabled = false;
      const res = await request("PATCH", `${serverUrl}/webhooks/${encodeURIComponent(id)}`, body, auth);
      if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      console.log(`Updated webhook \x1b[36m${res.body.id}\x1b[0m`);
      if (flags.json) show(res.body);
      return;
    }
    case "delete": {
      if (!id) die("Usage: aep webhooks delete <id>");
      const res = await request("DELETE", `${serverUrl}/webhooks/${encodeURIComponent(id)}`, null, auth);
      if (res.status === 204) { console.log("Deleted."); return; }
      die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      return;
    }
    case "deliveries": {
      if (!id) die("Usage: aep webhooks deliveries <id> [--since iso] [--until iso] [--limit n]");
      const qs = new URLSearchParams();
      const since = requireFlagValue(flags, "since");
      const until = requireFlagValue(flags, "until");
      const limit = requireFlagValue(flags, "limit");
      if (since !== undefined) qs.set("since", since);
      if (until !== undefined) qs.set("until", until);
      if (limit !== undefined) qs.set("limit", limit);
      const query = qs.toString() ? `?${qs}` : "";
      const res = await request("GET", `${serverUrl}/webhooks/${encodeURIComponent(id)}/deliveries${query}`, null, auth);
      if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      if (flags.json) return show(res.body);
      const rows = res.body.deliveries || [];
      if (rows.length === 0) { console.log("(no deliveries)"); return; }
      const sevColor = { success: "\x1b[32m", failed: "\x1b[31m", pending: "\x1b[33m" };
      for (const d of rows) {
        const col = sevColor[d.status] || "";
        console.log(`  ${col}${d.status}\x1b[0m  ${d.event_type}  attempts=${d.attempts}  code=${d.last_status_code ?? "-"}  ${fmtTs(d.created_at)}`);
        if (d.last_error) console.log(`    error: ${d.last_error}`);
      }
      return;
    }
    default:
      webhooksHelp();
      if (sub) die(`Unknown webhooks subcommand: '${sub}'`);
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

  const session = requireFlagValue(flags, "session");
  const trace   = requireFlagValue(flags, "trace");
  const since   = requireFlagValue(flags, "since");
  const until   = requireFlagValue(flags, "until");

  const qs = new URLSearchParams({ framework });
  if (session !== undefined) qs.set("session", session);
  if (trace   !== undefined) qs.set("trace", trace);
  if (since   !== undefined) qs.set("since", since);
  if (until   !== undefined) qs.set("until", until);

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
// Command: admin keys  (Finding #10)
// ---------------------------------------------------------------------------

function adminHelp() {
  console.log(`
\x1b[1maep admin\x1b[0m — Manage API keys

Usage:
  aep admin keys create --label <label> [--scopes <scopes>] [--tenant-id <tenantId>] [--json]
  aep admin keys list   [--json]
  aep admin keys delete <id>

Subcommands:
  keys create   Mint a new API key (needs ADMIN_TOKEN or AEP_ADMIN_TOKEN)
  keys list     List all API keys  (needs ADMIN_TOKEN or AEP_ADMIN_TOKEN)
  keys delete   Delete an API key  (needs ADMIN_TOKEN or AEP_ADMIN_TOKEN)

Flags (create):
  --label     <label>    Human-readable label for the key (required)
  --scopes    <list>     Comma-separated scopes: read,write (default: read,write)
  --tenant-id <id>       Tenant the key is bound to (default: default)
  --json                 Print the full JSON response (the signing_secret is in it)

Environment:
  ADMIN_TOKEN or AEP_ADMIN_TOKEN   Admin bearer token (required for all admin commands)
`);
}

function resolveAdminToken(flags) {
  const tok = flags["admin-token"]
    || process.env.ADMIN_TOKEN
    || process.env.AEP_ADMIN_TOKEN
    || null;
  if (!tok) {
    die(
      "Admin token required. Set the ADMIN_TOKEN environment variable (or AEP_ADMIN_TOKEN), " +
      "or pass --admin-token <token>."
    );
  }
  return tok;
}

async function cmdAdmin(positional, flags, serverUrl) {
  if (flags.help) { adminHelp(); return; }

  const sub = positional[1]; // "keys"
  const action = positional[2]; // "create" | "list" | "delete"

  if (sub !== "keys") {
    adminHelp();
    if (sub) die(`Unknown admin subcommand: '${sub}'. Try: aep admin keys create|list|delete`);
    return;
  }

  // Invariant: resolveAdminToken is never called on the bare help path.
  if (!action) { adminHelp(); return; }
  const adminToken = resolveAdminToken(flags);
  const auth = { Authorization: `Bearer ${adminToken}` };

  switch (action) {
    case "create": {
      const label = flags.label;
      if (!label || label === true) die("--label is required: aep admin keys create --label <label>");
      const rawScopes = flags.scopes || flags.scope || "read,write";
      const scopes = String(rawScopes).split(",").map(s => s.trim()).filter(Boolean);
      const tenantId = flags["tenant-id"] || flags["tenantId"] || "default";
      const body = { label: String(label), scopes, tenantId };
      const res = await request("POST", `${serverUrl}/admin/keys`, body, auth);
      if (res.status === 401) die("Unauthorized — check your ADMIN_TOKEN.");
      if (res.status !== 201) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      if (flags.json) {
        console.log(JSON.stringify(res.body, null, 2));
        return;
      }
      const k = res.body;
      if (!k || !k.key) die("Server returned 201 but response body is missing 'key'.");
      console.log(`\x1b[32m✓\x1b[0m API key created`);
      console.log(`  key: \x1b[1m${k.key}\x1b[0m`);
      console.log(`  id:  ${k.id}`);
      console.log(`  label: ${k.label}  scopes: ${(k.scopes || []).join(",")}`);
      return;
    }

    case "list": {
      const res = await request("GET", `${serverUrl}/admin/keys`, null, auth);
      if (res.status === 401) die("Unauthorized — check your ADMIN_TOKEN.");
      if (res.status !== 200) die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      if (flags.json) {
        console.log(JSON.stringify(res.body, null, 2));
        return;
      }
      const keys = res.body.keys || res.body || [];
      const rows = Array.isArray(keys) ? keys : [];
      if (rows.length === 0) { console.log("(no API keys)"); return; }
      for (const k of rows) {
        const scopes = (k.scopes || []).join(",");
        console.log(
          `  \x1b[36m${k.id}\x1b[0m  \x1b[1m${k.label}\x1b[0m  ` +
          `scopes=${scopes}  tenant=${k.tenant_id || "—"}  created=${fmtTs(k.created_at)}`
        );
      }
      return;
    }

    case "delete": {
      const id = positional[3];
      if (!id) die("Usage: aep admin keys delete <id>");
      const res = await request("DELETE", `${serverUrl}/admin/keys/${encodeURIComponent(id)}`, null, auth);
      if (res.status === 401) die("Unauthorized — check your ADMIN_TOKEN.");
      if (res.status === 404) die(`Key '${id}' not found.`);
      if (res.status === 204 || res.status === 200) { console.log("Deleted."); return; }
      die(`Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      return;
    }

    default:
      adminHelp();
      if (action) die(`Unknown admin keys action: '${action}'. Try: create | list | delete`);
  }
}

// ---------------------------------------------------------------------------
// Command: init  (Finding #23)
// ---------------------------------------------------------------------------

function initHelp() {
  console.log(`
\x1b[1maep init\x1b[0m — Guided first-run onboarding wizard

Checks that the AEP server is reachable, mints an API key using the admin
token, and prints the export command ready to copy into your shell profile.

Usage:
  aep init [flags]

Flags:
  --server <url>         AEP server URL (env: AEP_SERVER, default: http://localhost:8787)
  --admin-token <token>  Admin bearer token (env: ADMIN_TOKEN or AEP_ADMIN_TOKEN)

Environment:
  AEP_SERVER            Server URL
  ADMIN_TOKEN           Admin token to mint API keys
  AEP_ADMIN_TOKEN       Alternative env name for the admin token
`);
}

async function cmdInit(flags, serverUrl) {
  if (flags.help) { initHelp(); return; }

  const host = serverUrl;

  // Step 1: health check
  console.log(`\x1b[1m[1/4]\x1b[0m Checking server health at ${host}/health …`);
  let healthOk = false;
  try {
    const res = await request("GET", `${host}/health`, null, {});
    healthOk = res.status === 200;
  } catch (_) {
    healthOk = false;
  }

  if (!healthOk) {
    console.error(`\x1b[31m✗\x1b[0m Server not reachable at ${host}`);
    console.error("");
    console.error("Start the server first:");
    console.error("  ADMIN_TOKEN=dev-admin npm run ingest");
    console.error("");
    console.error("Then re-run: aep init");
    process.exit(1);
  }
  console.log(`\x1b[32m✓\x1b[0m Server is up.`);

  // Step 2: resolve admin token
  console.log(`\x1b[1m[2/4]\x1b[0m Checking admin token …`);
  const adminToken = flags["admin-token"]
    || process.env.ADMIN_TOKEN
    || process.env.AEP_ADMIN_TOKEN
    || null;

  if (!adminToken) {
    console.error(`\x1b[31m✗\x1b[0m ADMIN_TOKEN is not set.`);
    console.error("");
    console.error("Set it and re-run:");
    console.error("  export ADMIN_TOKEN=<your-admin-token>");
    console.error("  aep init");
    process.exit(1);
  }
  console.log(`\x1b[32m✓\x1b[0m Admin token found.`);

  // Step 3: mint a write+read API key
  console.log(`\x1b[1m[3/4]\x1b[0m Minting API key (label: aep-cli-init) …`);
  const body = { label: "aep-cli-init", scopes: ["read", "write"], tenantId: "default" };
  const auth = { Authorization: `Bearer ${adminToken}` };
  let apiKey;
  try {
    const res = await request("POST", `${host}/admin/keys`, body, auth);
    if (res.status === 401) {
      console.error(`\x1b[31m✗\x1b[0m Admin token was rejected (401 Unauthorized).`);
      console.error("Make sure ADMIN_TOKEN matches the value the server was started with.");
      process.exit(1);
    }
    if (res.status !== 201) {
      console.error(`\x1b[31m✗\x1b[0m Could not create API key (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
      process.exit(1);
    }
    apiKey = res.body.key;
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Request failed: ${err.message}`);
    process.exit(1);
  }
  console.log(`\x1b[32m✓\x1b[0m API key minted.`);

  // Step 4: verify the key works by emitting a test event
  console.log(`\x1b[1m[4/4]\x1b[0m Verifying key with a test event …`);
  const testEvent = {
    specversion: "0.2.0",
    id: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    time: new Date().toISOString(),
    source: "agent://aep-cli-init",
    type: "task.created",
    session_id: `ses_init_${Date.now()}`,
    trace_id: `trc_init_${Date.now()}`,
    payload: { message: "aep init test event" },
  };
  let verified = false;
  let verifyStatus = null;
  let verifyBody = null;
  try {
    const res = await request("POST", `${host}/events`, testEvent, {
      Authorization: `Bearer ${apiKey}`,
    });
    verifyStatus = res.status;
    verifyBody = res.body;
    verified = res.status === 202 || (res.status === 200 && res.body && res.body.duplicate);
  } catch (_) {
    verified = false;
  }
  if (!verified) {
    console.error(`\x1b[31m✗\x1b[0m Test event was not accepted (HTTP ${verifyStatus || "network error"}).`);
    if (verifyBody) console.error(JSON.stringify(verifyBody));
    process.exit(1);
  }
  console.log(`\x1b[32m✓\x1b[0m Test event accepted.`);

  // Done — print instructions
  const urlObj = new URL(host);
  const dashboardUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? `:${urlObj.port}` : ""}/dashboard`;

  console.log("");
  console.log("\x1b[1mSetup complete!\x1b[0m  Add to your shell profile:");
  console.log("");
  console.log(`  export AEP_API_KEY="${apiKey}"`);
  console.log("");
  console.log(`Dashboard: \x1b[36m${dashboardUrl}\x1b[0m`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Command: export bulk  (Finding #4) — wraps src/export.js
// ---------------------------------------------------------------------------

function exportBulkHelp() {
  // Mirror src/export.js's printHelp but formatted as aep sub-subcommand.
  console.log(`
\x1b[1maep export bulk\x1b[0m — Bulk DB export to local filesystem or S3

Streams each tenant's event log to a sink as JSON Lines (gzip default).
This is an operator job — wire it to cron / a k8s CronJob in production.

Usage:
  aep export bulk [flags]

Flags:
  --tenant      <id>       Export only one tenant (default: all tenants with a project row)
  --all-tenants            Also export tenants with events but no project row
  --sink        local|s3   Destination sink (default: local; env EXPORT_SINK)
  --dir         <path>     Local sink directory (default: ./exports)
  --bucket      <name>     S3 bucket name (sink=s3; env EXPORT_S3_BUCKET)
  --region      <r>        S3 region (env EXPORT_S3_REGION / AWS_REGION)
  --endpoint    <url>      S3-compatible endpoint URL (env EXPORT_S3_ENDPOINT)
  --prefix      <key>      Object key prefix within the sink
  --since       <iso>      Only events with time >= since
  --until       <iso>      Only events with time <  until
  --format      jsonl|csv|parquet   Output format (default: jsonl)
  --compression none|gzip|brotli   Compression (default: gzip; parquet is self-compressed)
  --dry-run                Report what WOULD be written without writing
  --json                   Print a machine-readable JSON summary to stdout

Note: npm run export (src/export.js) is an alias for the same functionality
and continues to work unchanged.

S3 credentials are resolved from the standard AWS credential chain — never
passed as flags and never logged.
`);
}

async function cmdExportBulk(positional, flags) {
  if (flags.help) { exportBulkHelp(); return; }

  // Re-assemble an argv-like array that src/export.js's parseArgs() understands.
  // We translate the CLI flags we accepted into the flag names export.js expects.
  // (Both CLIs use --flag value style so this is mostly pass-through.)
  const fwdArgv = ["node", "export.js"];

  // Every value passed in here already went through requireFlagValue() below,
  // so it's always a string or undefined — never the bare-flag `true` a raw
  // `flags.x` read would give.
  const add = (name, val) => {
    if (val !== undefined) fwdArgv.push(`--${name}`, val);
  };

  // Validate every value-taking flag up front so a bare `--since` (etc.) dies
  // here with a clear error instead of being forwarded as a value-less token
  // that export.js's own parser would then misinterpret (see issue #181).
  const tenant      = requireFlagValue(flags, "tenant");
  // Named sinkKind, not sink — a `const sink` (the constructed Sink object)
  // is already declared later in this same function.
  const sinkKind    = requireFlagValue(flags, "sink");
  const dir         = requireFlagValue(flags, "dir");
  const out         = requireFlagValue(flags, "out");
  const bucket      = requireFlagValue(flags, "bucket");
  const region      = requireFlagValue(flags, "region");
  const endpoint    = requireFlagValue(flags, "endpoint");
  const prefix      = requireFlagValue(flags, "prefix");
  const since       = requireFlagValue(flags, "since");
  const until       = requireFlagValue(flags, "until");
  const format      = requireFlagValue(flags, "format");
  const compression = requireFlagValue(flags, "compression");

  add("tenant", tenant);
  add("sink", sinkKind);
  // export.js uses --out for the local dir; we expose it as --dir in aep export bulk
  add("out", dir || out);
  add("bucket", bucket);
  add("region", region);
  add("endpoint", endpoint);
  add("prefix", prefix);
  add("since", since);
  add("until", until);
  add("format", format);
  add("compression", compression);
  if (flags["all-tenants"]) fwdArgv.push("--all-tenants");
  if (flags["dry-run"])     fwdArgv.push("--dry-run");
  if (flags.json)           fwdArgv.push("--json");

  // Delegate to the standalone export.js module. It handles its own main()
  // guard (require.main === module) so requiring it doesn't auto-run, but its
  // logic lives in the functions it exports.  We replicate the same flow here.
  const path = require("path");
  const exportModule = require(path.join(__dirname, "export.js"));
  const db = require(path.join(__dirname, "db"));
  const { runExport } = require(path.join(__dirname, "export/index"));
  const { createSink } = require(path.join(__dirname, "export/sink"));
  const { isSelfCompressed } = require(path.join(__dirname, "export/formats"));

  const opts = exportModule.parseArgs(fwdArgv);

  const explicitCompression = fwdArgv.some(
    (a) => a === "--compression" || a.startsWith("--compression=")
  );
  if (explicitCompression && isSelfCompressed(opts.format) && opts.compression !== "none") {
    console.error(
      `Note: --format ${opts.format} is self-compressed; --compression ${opts.compression} is ignored.`
    );
  }

  const sinkConfig = exportModule.resolveSinkConfig(opts);
  const sink = opts.dryRun ? null : createSink(sinkConfig);
  const allTenants = opts.allTenants || process.env.EXPORT_ALL_TENANTS === "1";

  await db.init();
  try {
    const summary = await runExport({
      tenantId: opts.tenantId,
      since: opts.since,
      until: opts.until,
      format: opts.format,
      compression: opts.compression,
      prefix: opts.prefix,
      sink,
      dryRun: opts.dryRun,
      allTenants,
    });

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const destLabel = exportModule.destinationLabel(sinkConfig);
      const verb = summary.dryRun ? "Would export" : "Exported";
      console.log(
        `${summary.dryRun ? "[dry-run] " : ""}Scanned ${summary.tenants_scanned} tenant(s); ` +
        `${verb.toLowerCase()} ${summary.events_exported} event(s) ` +
        `across ${summary.tenants_exported} tenant(s)` +
        `${summary.dryRun ? "" : ` into ${summary.objects_written} object(s)`} ` +
        `(${summary.format}, ${summary.compression}${summary.dryRun ? "" : `, ${destLabel}`}).`
      );
      for (const d of summary.details || []) {
        if (d.skipped) continue;
        if (summary.dryRun) {
          console.log(`  - tenant ${d.tenant_id}: would write ${d.events} event(s) → ${d.key}`);
        } else {
          console.log(`  - tenant ${d.tenant_id}: ${d.events} event(s), ${d.bytes} byte(s) → ${d.location}`);
        }
      }
      const orphans = summary.orphan_tenants || [];
      if (orphans.length > 0 && !summary.allTenants) {
        console.error(
          `⚠️  ${orphans.length} tenant(s) have events but no project and were NOT exported: ` +
          `${orphans.join(", ")}. Pass --all-tenants (or EXPORT_ALL_TENANTS=1) to include them, ` +
          `or --tenant <id> to export one.`
        );
      }
    }
  } finally {
    await db.closeDb();
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
  // admin token — resolved lazily per-command (not required for non-admin commands)
  // Skip resolution (and its die() on a bad value) for --help, no command at
  // all (bare `aep` prints usage), and commands that never call request(): a
  // stray `--timeout junk` alongside one of these shouldn't stop it from
  // running. `audit verify`/`audit render` check a local bundle file;
  // `export bulk` and `validate` are both local-filesystem tools.
  const isLocalOnly = !positional[0]
    || positional[0] === "validate"
    || (positional[0] === "export" && positional[1] === "bulk")
    || (positional[0] === "audit" && (positional[1] === "verify" || positional[1] === "render"));
  requestTimeoutMs = (flags.help || isLocalOnly) ? DEFAULT_TIMEOUT_MS : resolveTimeoutMs(flags);

  const command = positional[0];

  if (!command) {
    printUsage();
    return;
  }

  try {
    switch (command) {
      case "emit":     await cmdEmit(flags, serverUrl, apiKey); break;
      case "session":  await cmdSession(positional, flags, serverUrl, apiKey); break;
      case "export": {
        // "aep export bulk" dispatches to the bulk DB export; anything else is
        // the session-events export (original behaviour, preserved for compat).
        // "bulk" is intercepted here before cmdExport sees positional[1]
        if (positional[1] === "bulk") {
          await cmdExportBulk(positional, flags);
        } else {
          await cmdExport(positional, flags, serverUrl, apiKey);
        }
        break;
      }
      case "audit":    await cmdAudit(positional, flags, serverUrl, apiKey); break;
      case "workflow": await cmdWorkflow(positional, flags, serverUrl, apiKey); break;
      case "analytics": await cmdAnalytics(positional, flags, serverUrl, apiKey); break;
      case "metrics":  await cmdMetrics(positional, flags, serverUrl, apiKey); break;
      case "webhooks": await cmdWebhooks(positional, flags, serverUrl, apiKey); break;
      case "compliance": await cmdCompliance(positional, flags, serverUrl, apiKey); break;
      case "admin":    await cmdAdmin(positional, flags, serverUrl); break;
      case "init":     await cmdInit(flags, serverUrl); break;
      case "validate": await cmdValidate(positional, flags); break;
      default:
        console.error(`Unknown command: '${command}'\n`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    // Both request paths already name their target; describeError still unwraps
    // anything else that reaches here with an empty message.
    die(describeError(err));
  }
}

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

module.exports = {
  parseArgs, describeError, targetOf, resolveTimeoutMs, DEFAULT_TIMEOUT_MS, armTimeout,
};

// `aep` runs this file directly (package.json bin). The guard keeps a plain
// require() — as the unit tests do — from executing a command and printing the
// usage banner into the test output.
if (require.main === module) main();
