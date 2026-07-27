"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
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
