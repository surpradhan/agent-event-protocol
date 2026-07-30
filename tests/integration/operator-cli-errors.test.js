"use strict";

/**
 * Integration tests for the operator CLIs (src/prune.js, src/export.js)
 * reporting a reachable-network failure (issue #176).
 *
 * Both CLIs call `await db.init()` before anything else, so pointing
 * STORAGE_BACKEND=postgres + DATABASE_URL at a closed local port reliably
 * reproduces the exact bug: Node's happy-eyeballs dialer resolves "localhost"
 * to both ::1 and 127.0.0.1, and — when both are refused — `pg` rejects with
 * an AggregateError whose own .message is empty. Before this fix, both CLIs'
 * `err.message || String(err)` printed a bare "Error: AggregateError"; this
 * verifies they now go through describeError() (src/errors.js) like
 * src/cli.js already did as of #175.
 *
 * This never touches a real Postgres server — the port is reserved and
 * immediately closed, so the connection is refused before any query runs.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const { execFile } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PRUNE_PATH = path.join(REPO_ROOT, "src", "prune.js");
const EXPORT_PATH = path.join(REPO_ROOT, "src", "export.js");

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

/** Run an operator CLI as a real subprocess against an unreachable Postgres. */
function runAgainstUnreachablePostgres(scriptPath, port) {
  const env = {
    ...process.env,
    STORAGE_BACKEND: "postgres",
    DATABASE_URL: `postgres://user:pass@localhost:${port}/db`,
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, "--dry-run"],
      { cwd: REPO_ROOT, env, timeout: 15000 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      });
  });
}

describe("operator CLI unreachable-database errors (issue #176)", () => {
  test("prune names the cause instead of printing a bare AggregateError", async () => {
    const port = await closedPort();
    const { code, stderr } = await runAgainstUnreachablePostgres(PRUNE_PATH, port);

    assert.notEqual(code, 0, "prune should exit non-zero when Postgres is unreachable");
    assert.match(stderr, /ECONNREFUSED/);
    assert.doesNotMatch(stderr, /Error:\s*AggregateError\s*$/m, "the raw AggregateError must not surface bare");
  });

  test("export names the cause instead of printing a bare AggregateError", async () => {
    const port = await closedPort();
    const { code, stderr } = await runAgainstUnreachablePostgres(EXPORT_PATH, port);

    assert.notEqual(code, 0, "export should exit non-zero when Postgres is unreachable");
    assert.match(stderr, /ECONNREFUSED/);
    assert.doesNotMatch(stderr, /Error:\s*AggregateError\s*$/m, "the raw AggregateError must not surface bare");
  });
});
