"use strict";

/**
 * Integration tests for the operator CLIs (src/prune.js, src/export.js)
 * reporting a reachable-network failure (issue #176) — and, per issue #186,
 * doing it with the same "could not reach <target>" framing src/cli.js's own
 * unreachable-server errors already have.
 *
 * Both CLIs call `await db.init()` before anything else, so pointing
 * STORAGE_BACKEND=postgres + DATABASE_URL at a closed local port reliably
 * reproduces the exact bug: Node's happy-eyeballs dialer resolves "localhost"
 * to both ::1 and 127.0.0.1, and — when both are refused — `pg` rejects with
 * an AggregateError whose own .message is empty. Before #176, both CLIs'
 * `err.message || String(err)` printed a bare "Error: AggregateError"; #176
 * routed that through describeError() (src/errors.js) but without a target,
 * so it printed both per-address attempts in full rather than collapsing them
 * behind a named target the way src/cli.js does (#175). #186 closes that gap
 * by deriving the target from DATABASE_URL (src/errors.js's databaseTarget())
 * and wrapping the dial failure with it (withTarget()) before db.init() even
 * throws.
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

describe("operator CLI unreachable-database target framing (issue #186)", () => {
  test("prune collapses the per-address attempts behind a named target", async () => {
    const port = await closedPort();
    const { code, stderr } = await runAgainstUnreachablePostgres(PRUNE_PATH, port);

    assert.notEqual(code, 0, "prune should exit non-zero when Postgres is unreachable");
    assert.match(
      stderr,
      new RegExp(`could not reach postgres://localhost:${port} \\(ECONNREFUSED\\)`),
      "should name the target the way src/cli.js's own unreachable-server errors do"
    );
    // Collapsed to one cause — not one line per dialed address (::1 and 127.0.0.1).
    assert.equal((stderr.match(/ECONNREFUSED/g) || []).length, 1);
  });

  test("export collapses the per-address attempts behind a named target", async () => {
    const port = await closedPort();
    const { code, stderr } = await runAgainstUnreachablePostgres(EXPORT_PATH, port);

    assert.notEqual(code, 0, "export should exit non-zero when Postgres is unreachable");
    assert.match(
      stderr,
      new RegExp(`could not reach postgres://localhost:${port} \\(ECONNREFUSED\\)`)
    );
    assert.equal((stderr.match(/ECONNREFUSED/g) || []).length, 1);
  });

  test("does not leak the DATABASE_URL's credentials into the error line", async () => {
    const port = await closedPort();
    const { stderr } = await runAgainstUnreachablePostgres(PRUNE_PATH, port);

    assert.doesNotMatch(stderr, /user/, "the DATABASE_URL userinfo must not reach stderr");
    assert.doesNotMatch(stderr, /pass/, "the DATABASE_URL password must not reach stderr");
  });
});
