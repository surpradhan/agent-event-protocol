"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("node:child_process");

/**
 * Integration tests for the `aep` CLI (src/cli.js).
 *
 * These tests spawn the REAL CLI as a subprocess (via execFile) pointed at a
 * mock ingest server, then assert on BOTH:
 *   (a) what the CLI actually put on the wire — method, path, Authorization
 *       header, and request body recorded by the mock server; and
 *   (b) the CLI's own behaviour — exit code and stdout/stderr.
 *
 * The mock server never touches the database, so this file is backend-agnostic
 * and runs unchanged under the Postgres-parity job. Because the CLI is driven
 * end-to-end, these tests would fail if src/cli.js's argument parsing, request
 * construction, or output changed — unlike the earlier version, which issued
 * hand-written http.request calls and never loaded the CLI at all.
 */

const CLI_PATH = path.resolve(__dirname, "..", "..", "src", "cli.js");
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const mockApiKey = "aep_test_key_0123456789abcdef0123456789abcdef";

// Env with any ambient AEP_* stripped, so tests control auth/target explicitly
// and an operator's real environment can't leak into (or mask) a case.
const baseEnv = { ...process.env };
delete baseEnv.AEP_SERVER;
delete baseEnv.AEP_API_KEY;
delete baseEnv.ADMIN_TOKEN;
delete baseEnv.AEP_ADMIN_TOKEN;

describe("CLI command integration tests (real subprocess)", () => {
  /** @type {Array<{method:string,url:string,headers:object,body:any}>} */
  const received = [];
  let mockServerUrl;
  let mockServer;

  before(async () => {
    mockServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => (raw += chunk));
      req.on("end", () => {
        let body;
        if (raw) {
          try { body = JSON.parse(raw); } catch (_) { body = raw; }
        }
        received.push({ method: req.method, url: req.url, headers: req.headers, body });

        // Ingest: mimic the real 202 accept, but let a session id prefixed
        // "reject" drive the non-2xx branch so we can prove the CLI's failure
        // exit path without needing a second server.
        if (req.method === "POST" && req.url === "/events") {
          if (body && typeof body.session_id === "string" && body.session_id.startsWith("reject")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "rejected by mock" }));
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true, id: body && body.id }));
          return;
        }

        // Session query
        const sessionMatch = req.method === "GET" && req.url.match(/^\/sessions\/([^/?]+)\/events/);
        if (sessionMatch) {
          const sessionId = decodeURIComponent(sessionMatch[1]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            events: [{
              id: "evt_001",
              type: "task.created",
              time: new Date().toISOString(),
              source: "agent://test",
              session_id: sessionId,
              trace_id: "trc_001",
            }],
          }));
          return;
        }

        // Workflow query
        const workflowMatch = req.method === "GET" && req.url.match(/^\/workflows\/([^/?]+)$/);
        if (workflowMatch) {
          const traceId = decodeURIComponent(workflowMatch[1]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            trace_id: traceId,
            session_count: 1,
            tree: { id: "ses_001", type: "orchestrator", children: [] },
          }));
          return;
        }

        // Metrics (JSON endpoint — not /metrics/prometheus). The body mirrors the
        // real shape from db.getMetrics() + getSignatureMetrics() (src/server.js),
        // so a test asserting on a field name would fail if the CLI ever reshaped
        // the response instead of passing it through. A since/until that isn't
        // ISO-8601 drives the 400 branch, like the real endpoint.
        if (req.method === "GET" && /^\/metrics(\?|$)/.test(req.url)) {
          const params = new URLSearchParams(req.url.split("?")[1] || "");
          const bad = ["since", "until"].some(
            k => params.has(k) && Number.isNaN(Date.parse(params.get(k)))
          );
          if (bad) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid since/until — must be ISO-8601" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            received: 0,
            accepted: 42,
            rejected: 0,
            duplicates: 0,
            byType: { "task.created": 40, "policy.blocked": 2 },
            session_count: 7,
            workflow_count: 4,
            subagent_session_count: 2,
            max_tree_depth: 3,
            signatures: { verifications: [], rejections: [] },
          }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });
    });

    mockServerUrl = await new Promise((resolve) => {
      mockServer.listen(0, () => resolve(`http://localhost:${mockServer.address().port}`));
    });
  });

  after(() => {
    mockServer.close();
  });

  /**
   * Run the real CLI as a subprocess. Always resolves (never rejects) with the
   * exit code and captured streams so tests can assert on failure exits too.
   */
  function runCli(args, { withKey = true, env = {} } = {}) {
    const childEnv = { ...baseEnv, AEP_SERVER: mockServerUrl, ...env };
    if (withKey) childEnv.AEP_API_KEY = mockApiKey;
    return new Promise((resolve) => {
      execFile(process.execPath, [CLI_PATH, ...args],
        { cwd: REPO_ROOT, env: childEnv, timeout: 15000 },
        (error, stdout, stderr) => {
          // A timeout kills the child (error.killed, code null); coercing to a
          // non-zero exit makes a hung CLI fail fast instead of hanging the suite.
          resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
        });
    });
  }

  test("emit drives a POST /events with the event body and Bearer auth", async () => {
    const sessionId = `ses_emit_${Date.now()}`;
    const traceId = "trc_emit_001";
    const { code, stdout } = await runCli([
      "emit",
      "--type", "task.created",
      "--source", "agent://test",
      "--session", sessionId,
      "--trace", traceId,
      "--json",
    ]);

    assert.equal(code, 0, `expected success exit, got ${code}`);

    // (a) what the CLI put on the wire
    const req = received.find(r => r.method === "POST" && r.url === "/events"
      && r.body && r.body.session_id === sessionId);
    assert.ok(req, "mock server never received the emit POST /events");
    assert.equal(req.headers.authorization, `Bearer ${mockApiKey}`);
    assert.equal(req.body.type, "task.created");
    assert.equal(req.body.source, "agent://test");
    assert.equal(req.body.trace_id, traceId);
    assert.equal(req.body.specversion, "0.2.0");
    assert.ok(req.body.id, "CLI should have generated an event id");

    // (b) the CLI's own output (--json echoes the server response)
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.accepted, true);
  });

  test("emit exits non-zero when the server rejects the event", async () => {
    const sessionId = `reject_ses_${Date.now()}`;
    const { code, stdout, stderr } = await runCli([
      "emit",
      "--type", "task.created",
      "--source", "agent://test",
      "--session", sessionId,
      "--trace", "trc_reject_001",
    ]);

    assert.notEqual(code, 0, "CLI should exit non-zero on a non-2xx ingest response");
    const req = received.find(r => r.method === "POST" && r.url === "/events"
      && r.body && r.body.session_id === sessionId);
    assert.ok(req, "CLI should still have attempted the POST before failing");
    assert.match(stdout + stderr, /rejected by mock|Rejected/i);
  });

  test("emit --json prints the raw body and still exits non-zero on rejection", async () => {
    // Distinct exit path from the case above: with --json the CLI echoes the
    // raw server response and then process.exit(1)s on a non-2xx status.
    const sessionId = `reject_json_${Date.now()}`;
    const { code, stdout } = await runCli([
      "emit",
      "--type", "task.created",
      "--source", "agent://test",
      "--session", sessionId,
      "--trace", "trc_reject_json_001",
      "--json",
    ]);

    assert.notEqual(code, 0, "--json must preserve the failure exit code on a non-2xx response");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.error, "rejected by mock");
  });

  test("session drives a GET /sessions/:id/events with Bearer auth", async () => {
    const sessionId = `ses_query_${Date.now()}`;
    const { code, stdout } = await runCli(["session", sessionId, "--json"]);

    assert.equal(code, 0, `expected success exit, got ${code}`);
    // The CLI interpolates the session id UNENCODED (src/cli.js) — assert the
    // raw path to mirror real behaviour. (workflow, below, DOES encode.)
    const req = received.find(r => r.method === "GET"
      && r.url === `/sessions/${sessionId}/events`);
    assert.ok(req, "mock server never received the session GET");
    assert.equal(req.headers.authorization, `Bearer ${mockApiKey}`);

    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.events));
    assert.equal(parsed.events[0].type, "task.created");
  });

  test("workflow drives a GET /workflows/:traceId with Bearer auth", async () => {
    const traceId = `trc_wf_${Date.now()}`;
    const { code, stdout } = await runCli(["workflow", traceId]);

    assert.equal(code, 0, `expected success exit, got ${code}`);
    // workflow encodes the trace id (src/cli.js), unlike session above.
    const req = received.find(r => r.method === "GET"
      && r.url === `/workflows/${encodeURIComponent(traceId)}`);
    assert.ok(req, "mock server never received the workflow GET");
    assert.equal(req.headers.authorization, `Bearer ${mockApiKey}`);
    assert.ok(stdout.includes(traceId), "workflow output should echo the trace id");
  });

  test("metrics drives a GET /metrics with Bearer auth and prints the JSON body", async () => {
    const { code, stdout } = await runCli(["metrics"]);

    assert.equal(code, 0, `expected success exit, got ${code}`);
    // (a) what the CLI put on the wire — the JSON endpoint, not /metrics/prometheus
    const req = received.find(r => r.method === "GET" && r.url === "/metrics");
    assert.ok(req, "mock server never received the metrics GET");
    assert.equal(req.headers.authorization, `Bearer ${mockApiKey}`);

    // (b) stdout is the server's body, passed through unchanged and parseable
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.accepted, 42);
    assert.equal(parsed.session_count, 7);
    assert.equal(parsed.workflow_count, 4);
    assert.equal(parsed.byType["policy.blocked"], 2);
    assert.deepEqual(parsed.signatures, { verifications: [], rejections: [] });
  });

  test("metrics forwards --since/--until as query params", async () => {
    // Literal expected path, not rebuilt with URLSearchParams (which would just
    // mirror the implementation). The '+' in the UTC offset must survive as %2B,
    // since a raw '+' would decode server-side as a space.
    const { code, stdout } = await runCli([
      "metrics", "--since", "2026-07-01T00:00:00Z", "--until", "2026-07-02T05:30:00+05:30",
    ]);

    assert.equal(code, 0, `expected success exit, got ${code}`);
    const req = received.find(r => r.method === "GET" && r.url ===
      "/metrics?since=2026-07-01T00%3A00%3A00Z&until=2026-07-02T05%3A30%3A00%2B05%3A30");
    assert.ok(req, "mock server never received the windowed metrics GET");
    // The windowed path must still print the body, not just issue the request.
    assert.equal(JSON.parse(stdout).accepted, 42);
  });

  test("metrics exits non-zero and reports the body when the server returns non-2xx", async () => {
    const { code, stderr } = await runCli(["metrics", "--since", "not-a-timestamp"]);

    assert.notEqual(code, 0, "CLI should exit non-zero on a non-2xx metrics response");
    assert.match(stderr, /HTTP 400/);
    assert.match(stderr, /must be ISO-8601/);
  });

  test("metrics rejects a bare --since before contacting the server", async () => {
    const before = received.length;
    const { code, stderr } = await runCli(["metrics", "--since"]);

    assert.notEqual(code, 0, "a value-less --since should not reach the wire as 'true'");
    assert.match(stderr, /--since requires a value/i);
    const contacted = received.slice(before).some(r => r.url.startsWith("/metrics"));
    assert.equal(contacted, false, "CLI must not request when a flag value is missing");
  });

  test("metrics rejects a subcommand instead of silently printing JSON", async () => {
    // `aep metrics prometheus` is the likeliest wrong guess for this command;
    // it must fail loudly rather than return the JSON endpoint's body.
    const before = received.length;
    const { code, stderr } = await runCli(["metrics", "prometheus"]);

    assert.notEqual(code, 0, "CLI should reject an unexpected metrics subcommand");
    assert.match(stderr, /takes no subcommand/i);
    assert.match(stderr, /metrics\/prometheus/, "error should point at the scrape endpoint");
    const contacted = received.slice(before).some(r => r.url.startsWith("/metrics"));
    assert.equal(contacted, false, "CLI must not request when the invocation is invalid");

    // An empty-string argument is still an argument — a truthiness check would
    // let it through and print metrics as if it were a bare `aep metrics`.
    const empty = await runCli(["metrics", ""]);
    assert.notEqual(empty.code, 0, "an empty subcommand should be rejected too");
    assert.match(empty.stderr, /takes no subcommand/i);
  });

  test("metrics --help documents the command without a key or a request", async () => {
    const before = received.length;
    const { code, stdout } = await runCli(["metrics", "--help"], { withKey: false });

    assert.equal(code, 0, "--help should exit 0 even with no API key");
    assert.match(stdout, /aep metrics/);
    assert.match(stdout, /--since/);
    assert.match(stdout, /--until/);
    assert.match(stdout, /NOT the Prometheus scrape endpoint/);
    const contacted = received.slice(before).some(r => r.url.startsWith("/metrics"));
    assert.equal(contacted, false, "--help must not contact the server");
  });

  test("metrics with no API key exits non-zero and never contacts the server", async () => {
    const before = received.length;
    const { code, stderr } = await runCli(["metrics"], { withKey: false });

    assert.notEqual(code, 0, "CLI should refuse to run without an API key");
    assert.match(stderr, /API key required/i);
    const contacted = received.slice(before).some(r => r.url.startsWith("/metrics"));
    assert.equal(contacted, false, "CLI must not contact the server when the key is missing");
  });

  test("commands with no API key exit non-zero and never contact the server", async () => {
    const sessionId = `ses_noauth_${Date.now()}`;
    const before = received.length;
    const { code, stderr } = await runCli(["session", sessionId], { withKey: false });

    assert.notEqual(code, 0, "CLI should refuse to run without an API key");
    assert.match(stderr, /API key required/i);
    // The key check happens before any request is constructed.
    const contacted = received.slice(before).some(r => r.url.includes(sessionId));
    assert.equal(contacted, false, "CLI must not contact the server when the key is missing");
  });

  /**
   * Reserve a port by listening on :0, then close it — the port is free, so a
   * connect there fails with ECONNREFUSED. (Binding first, rather than picking
   * a number, is what makes the port reliably unused.)
   */
  async function closedPort() {
    const probe = http.createServer();
    const port = await new Promise((resolve) => {
      probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
    });
    await new Promise((resolve) => probe.close(resolve));
    return port;
  }

  test("an unreachable server names the target and the cause (issue #173)", async () => {
    // Regression test: this printed a bare "Error: AggregateError" — Node dials
    // every resolved address and, when all fail, rejects with an AggregateError
    // whose own .message is empty.
    const port = await closedPort();
    const { code, stderr } = await runCli(["session", "ses_1"], {
      env: { AEP_SERVER: `http://localhost:${port}` },
    });

    assert.notEqual(code, 0, "CLI should exit non-zero when the server is unreachable");
    assert.match(stderr, new RegExp(`could not reach http://localhost:${port}`));
    assert.match(stderr, /ECONNREFUSED/);
    assert.doesNotMatch(stderr, /AggregateError/, "the raw AggregateError must not surface");
  });

  test("the unreachable-server message covers the streaming export path too", async () => {
    // `export` builds its own request instead of going through request(), so it
    // is the one path a fix applied only to request() would miss.
    const port = await closedPort();
    const { code, stderr } = await runCli(["export", "ses_1"], {
      env: { AEP_SERVER: `http://localhost:${port}` },
    });

    assert.notEqual(code, 0, "export should exit non-zero when the server is unreachable");
    assert.match(stderr, new RegExp(`could not reach http://localhost:${port}`));
    assert.match(stderr, /ECONNREFUSED/);
    assert.doesNotMatch(stderr, /AggregateError/);
  });

  test("the message names the target for a non-aggregate connection error too", async () => {
    // An IP literal skips the happy-eyeballs dialer, so this failure arrives as
    // a single plain Error rather than an AggregateError — the other branch of
    // describeError, exercised end-to-end without depending on DNS. (An
    // unresolvable-hostname test would be at the mercy of resolvers that hijack
    // NXDOMAIN, which is why this uses a closed port instead.)
    const port = await closedPort();
    const { code, stderr } = await runCli(["session", "ses_1"], {
      env: { AEP_SERVER: `http://127.0.0.1:${port}` },
    });

    assert.notEqual(code, 0, "CLI should exit non-zero when the server is unreachable");
    assert.match(stderr, new RegExp(`could not reach http://127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)`));
  });

  test("a server URL carrying credentials does not echo them in the error", async () => {
    const port = await closedPort();
    const { code, stderr } = await runCli(["session", "ses_1"], {
      env: { AEP_SERVER: `http://alice:hunter2@127.0.0.1:${port}` },
    });

    assert.notEqual(code, 0);
    assert.doesNotMatch(stderr, /hunter2/, "the password must not reach stderr");
    assert.match(stderr, new RegExp(`could not reach http://127\\.0\\.0\\.1:${port}`));
  });

  test("emit with a missing required flag exits non-zero without contacting the server", async () => {
    const sessionId = `ses_missing_${Date.now()}`;
    const before = received.length;
    // Omit --type; the CLI validates required flags before sending.
    const { code, stderr } = await runCli([
      "emit",
      "--source", "agent://test",
      "--session", sessionId,
      "--trace", "trc_missing_001",
    ]);

    assert.notEqual(code, 0, "CLI should reject an emit missing a required flag");
    assert.match(stderr, /--type is required/i);
    const contacted = received.slice(before).some(r => r.method === "POST" && r.url === "/events"
      && r.body && r.body.session_id === sessionId);
    assert.equal(contacted, false, "CLI must not POST when required flags are missing");
  });
});

/**
 * Issue #178 — a request that starts fine and then stalls.
 *
 * Every case here would have hung the CLI indefinitely before the fix: nothing
 * listened for a dead response and no timeout was armed, so the promise behind
 * the command simply never settled. Each test therefore asserts on the message
 * AND on the CLI having exited on its own — a subprocess killed by execFile's
 * own timeout would otherwise look like a pass.
 */
describe("CLI stalled-connection handling (issue #178)", () => {
  let hostileUrl;
  let hostileServer;
  /** Sockets parked by the never-responds route, closed in after(). */
  const parked = [];

  before(async () => {
    hostileServer = http.createServer((req, res) => {
      // Never respond: accept the request and hold the socket open. This is the
      // "server is up but wedged" case — no error ever arrives to unstick us.
      if (req.url.startsWith("/sessions/hang/")) {
        parked.push(res.socket);
        return;
      }
      // Truncate: promise more body than we send, then kill the socket. The
      // response emits 'aborted' — the event nobody used to listen for.
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
      res.write('{"events":[{"id":"evt_1"');
      setTimeout(() => res.socket.destroy(), 20);
    });
    await new Promise((resolve) => {
      hostileServer.listen(0, "127.0.0.1", () => {
        hostileUrl = `http://127.0.0.1:${hostileServer.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    for (const socket of parked) socket.destroy();
    await new Promise((resolve) => hostileServer.close(resolve));
  });

  /** Like the suite's runCli, but pointed at the hostile server and reporting
   *  whether the CLI exited by itself or had to be killed. */
  function runCli(args, { env = {} } = {}) {
    const childEnv = { ...baseEnv, AEP_SERVER: hostileUrl, AEP_API_KEY: mockApiKey, ...env };
    return new Promise((resolve) => {
      execFile(process.execPath, [CLI_PATH, ...args],
        { cwd: REPO_ROOT, env: childEnv, timeout: 20000 },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (error.code ?? 1) : 0,
            killed: Boolean(error && error.killed),
            stdout,
            stderr,
          });
        });
    });
  }

  test("a server that accepts and never responds trips the timeout", async () => {
    const { code, killed, stderr } = await runCli(["session", "hang", "--timeout", "1"]);

    assert.equal(killed, false, "the CLI must give up on its own, not be killed by the test");
    assert.notEqual(code, 0, "a timed-out request should exit non-zero");
    assert.match(stderr, new RegExp(`could not reach ${hostileUrl.replace(/\./g, "\\.")}`));
    assert.match(stderr, /ETIMEDOUT/);
    assert.match(stderr, /--timeout/, "the message should say which knob to turn");
  });

  test("the timeout covers the streaming export path too", async () => {
    // export builds its own request rather than going through request(), so it
    // is the path a fix applied only to the shared helper would miss.
    const { code, killed, stderr } = await runCli(["export", "hang", "--timeout", "1"]);

    assert.equal(killed, false, "the CLI must give up on its own");
    assert.notEqual(code, 0);
    assert.match(stderr, /ETIMEDOUT/);
  });

  test("a response truncated mid-body is reported, not waited on", async () => {
    const { code, killed, stderr } = await runCli(["session", "ses_1"]);

    assert.equal(killed, false, "a truncated response must settle the command");
    assert.notEqual(code, 0, "a truncated response is a failure, not a partial success");
    assert.match(stderr, /ECONNRESET/);
    assert.match(stderr, /before the response was complete/);
  });

  test("a truncated export to a file fails instead of reporting success", async () => {
    const out = path.join(os.tmpdir(), `aep-export-${process.pid}-${Date.now()}.json`);
    try {
      const { code, killed, stdout, stderr } = await runCli(["export", "ses_1", "--out", out]);

      assert.equal(killed, false);
      assert.notEqual(code, 0, "a half-written export must not exit 0");
      assert.doesNotMatch(stdout, /Exported to/, "success must not be claimed for a partial file");
      assert.match(stderr, /Incomplete export left in/);
      assert.match(stderr, new RegExp(out.replace(/[.\\/]/g, "\\$&")),
        "the message should name the partial file so it isn't mistaken for a good export");
    } finally {
      fs.rmSync(out, { force: true });
    }
  });

  test("a truncated export to stdout says the output is incomplete", async () => {
    const { code, killed, stderr } = await runCli(["export", "ses_1"]);

    assert.equal(killed, false);
    assert.notEqual(code, 0);
    assert.match(stderr, /The export above is incomplete/);
  });

  test("an unparseable --timeout is rejected locally, without contacting the server", async () => {
    const { code, killed, stderr } = await runCli(["session", "hang", "--timeout", "soon"]);

    assert.equal(killed, false, "a bad flag must fail immediately, not hang on the server");
    assert.notEqual(code, 0);
    assert.match(stderr, /--timeout must be a non-negative number of seconds/);
  });

  test("a negative --timeout is rejected", async () => {
    const { code, killed, stderr } = await runCli(["session", "hang", "--timeout", "-5"]);

    assert.equal(killed, false);
    assert.notEqual(code, 0);
    assert.match(stderr, /--timeout must be a non-negative number of seconds/);
  });

  test("a value-less --timeout is rejected rather than read as 'true'", async () => {
    const { code, killed, stderr } = await runCli(["session", "hang", "--timeout"]);

    assert.equal(killed, false);
    assert.notEqual(code, 0);
    assert.match(stderr, /--timeout requires a value/);
  });

  test("AEP_TIMEOUT applies when no flag is given", async () => {
    const { code, killed, stderr } = await runCli(["session", "hang"], { env: { AEP_TIMEOUT: "1" } });

    assert.equal(killed, false, "the env var must arm the timeout on its own");
    assert.notEqual(code, 0);
    assert.match(stderr, /ETIMEDOUT/);
  });
});
