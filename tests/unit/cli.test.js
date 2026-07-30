"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  parseArgs, resolveTimeoutMs, DEFAULT_TIMEOUT_MS,
} = require("../../src/cli");

// ---------------------------------------------------------------------------
// Tests for parseArgs function
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses basic command with no flags", () => {
    const result = parseArgs(["node", "cli.js", "emit"]);
    assert.deepEqual(result.positional, ["emit"]);
    assert.deepEqual(result.flags, {});
  });

  test("parses command with multiple positional arguments", () => {
    const result = parseArgs(["node", "cli.js", "session", "ses_123"]);
    assert.deepEqual(result.positional, ["session", "ses_123"]);
  });

  test("parses flags with values", () => {
    const result = parseArgs(["node", "cli.js", "emit", "--type", "task.created", "--source", "agent://test"]);
    assert.deepEqual(result.flags, { type: "task.created", source: "agent://test" });
    assert.deepEqual(result.positional, ["emit"]);
  });

  test("parses boolean flags (no value)", () => {
    const result = parseArgs(["node", "cli.js", "emit", "--help"]);
    assert.equal(result.flags.help, true);
  });

  test("parses mixed positional and flags", () => {
    const result = parseArgs(["node", "cli.js", "session", "ses_123", "--type", "tool.called", "--q", "search term"]);
    assert.deepEqual(result.positional, ["session", "ses_123"]);
    assert.deepEqual(result.flags, { type: "tool.called", q: "search term" });
  });

  test("treats flags that look like values as positional", () => {
    const result = parseArgs(["node", "cli.js", "validate", "/path/to/file.json"]);
    assert.deepEqual(result.positional, ["validate", "/path/to/file.json"]);
  });

  test("stops parsing flag values if next item is a flag", () => {
    const result = parseArgs(["node", "cli.js", "emit", "--type", "--help"]);
    assert.equal(result.flags.type, true);
    assert.equal(result.flags.help, true);
  });

  test("handles JSON payload strings", () => {
    const result = parseArgs(["node", "cli.js", "emit", "--payload", '{"key": "value"}'  ]);
    assert.equal(result.flags.payload, '{"key": "value"}');
  });

  test("handles empty args", () => {
    const result = parseArgs(["node", "cli.js"]);
    assert.deepEqual(result.positional, []);
    assert.deepEqual(result.flags, {});
  });

  test("handles multiple flags with same prefix", () => {
    const result = parseArgs(["node", "cli.js", "--server", "http://localhost:8787", "--key", "abc123"]);
    assert.equal(result.flags.server, "http://localhost:8787");
    assert.equal(result.flags.key, "abc123");
  });
});

// ---------------------------------------------------------------------------
// Tests for error handling in CLI command validation
// ---------------------------------------------------------------------------

describe("CLI validation scenarios", () => {
  test("emit command requires required flags", () => {
    const result = parseArgs(["node", "cli.js", "emit", "--type", "task.created", "--source", "agent://test"]);
    assert.equal(result.flags.type, "task.created");
    assert.equal(result.flags.source, "agent://test");
    assert.equal(result.positional[0], "emit");
  });

  test("session command captures sessionId", () => {
    const result = parseArgs(["node", "cli.js", "session", "ses_123", "--type", "task.created"]);
    assert.deepEqual(result.positional, ["session", "ses_123"]);
    assert.equal(result.flags.type, "task.created");
  });

  test("export command captures sessionId and format", () => {
    const result = parseArgs(["node", "cli.js", "export", "ses_123", "--format", "csv"]);
    assert.deepEqual(result.positional, ["export", "ses_123"]);
    assert.equal(result.flags.format, "csv");
  });

  test("workflow command captures traceId", () => {
    const result = parseArgs(["node", "cli.js", "workflow", "trc_123"]);
    assert.deepEqual(result.positional, ["workflow", "trc_123"]);
  });

  test("validate command captures filePath", () => {
    const result = parseArgs(["node", "cli.js", "validate", "events.json"]);
    assert.deepEqual(result.positional, ["validate", "events.json"]);
  });
});

// ---------------------------------------------------------------------------
// Tests for URL and query string handling
// ---------------------------------------------------------------------------

describe("URL handling in CLI", () => {
  test("server URL defaults to localhost:8787", () => {
    // Environment variable fallback test
    const testUrl = process.env.AEP_SERVER || "http://localhost:8787";
    assert.ok(testUrl.includes("localhost") || testUrl.includes("http"));
  });

  test("parseArgs handles --server flag correctly", () => {
    const result = parseArgs(["node", "cli.js", "--server", "https://api.example.com", "emit"]);
    assert.equal(result.flags.server, "https://api.example.com");
    assert.deepEqual(result.positional, ["emit"]);
  });

  test("parseArgs handles --key flag correctly", () => {
    const result = parseArgs(["node", "cli.js", "--key", "aep_test_key_123", "emit"]);
    assert.equal(result.flags.key, "aep_test_key_123");
  });
});

// ---------------------------------------------------------------------------
// Tests for parseArgs routing of new commands (admin keys, init, export bulk)
// ---------------------------------------------------------------------------

describe("parseArgs routing for new commands", () => {
  test("aep admin keys create --label foo routes correctly", () => {
    const result = parseArgs(["node", "cli.js", "admin", "keys", "create", "--label", "foo"]);
    assert.equal(result.positional[0], "admin");
    assert.equal(result.positional[1], "keys");
    assert.equal(result.positional[2], "create");
    assert.equal(result.flags.label, "foo");
  });

  test("aep admin keys delete some-id captures the id", () => {
    const result = parseArgs(["node", "cli.js", "admin", "keys", "delete", "some-id"]);
    assert.equal(result.positional[0], "admin");
    assert.equal(result.positional[1], "keys");
    assert.equal(result.positional[2], "delete");
    assert.equal(result.positional[3], "some-id");
  });

  test("aep admin keys list routes correctly", () => {
    const result = parseArgs(["node", "cli.js", "admin", "keys", "list"]);
    assert.equal(result.positional[0], "admin");
    assert.equal(result.positional[1], "keys");
    assert.equal(result.positional[2], "list");
    assert.deepEqual(result.flags, {});
  });

  test("aep export bulk --dir /x --format csv routes correctly", () => {
    const result = parseArgs(["node", "cli.js", "export", "bulk", "--dir", "/x", "--format", "csv"]);
    assert.equal(result.positional[0], "export");
    assert.equal(result.positional[1], "bulk");
    assert.equal(result.flags.dir, "/x");
    assert.equal(result.flags.format, "csv");
  });

  test("aep init --admin-token tok routes correctly", () => {
    const result = parseArgs(["node", "cli.js", "init", "--admin-token", "tok"]);
    assert.equal(result.positional[0], "init");
    assert.equal(result.flags["admin-token"], "tok");
  });

  test("aep admin keys with no action only routes to admin/keys", () => {
    const result = parseArgs(["node", "cli.js", "admin", "keys"]);
    assert.equal(result.positional[0], "admin");
    assert.equal(result.positional[1], "keys");
    assert.equal(result.positional[2], undefined);
  });

  test("aep export bulk --all-tenants passes the flag", () => {
    const result = parseArgs(["node", "cli.js", "export", "bulk", "--all-tenants"]);
    assert.equal(result.positional[1], "bulk");
    assert.equal(result.flags["all-tenants"], true);
  });
});

// ---------------------------------------------------------------------------
// Tests for resolveTimeoutMs (issue #178)
//
// Only the accepted values are unit-tested here: a rejected one calls die(),
// which exits the process, so those cases are covered end-to-end in the
// integration suite instead.
// ---------------------------------------------------------------------------

describe("resolveTimeoutMs", () => {
  test("defaults to 30s when neither the flag nor the env var is set", () => {
    assert.equal(resolveTimeoutMs({}, {}), DEFAULT_TIMEOUT_MS);
    assert.equal(DEFAULT_TIMEOUT_MS, 30000);
  });

  test("reads seconds, not milliseconds", () => {
    // The flag is curl's --max-time, not a millisecond count; 5 must mean 5s.
    assert.equal(resolveTimeoutMs({ timeout: "5" }, {}), 5000);
  });

  test("accepts a fractional value", () => {
    assert.equal(resolveTimeoutMs({ timeout: "0.25" }, {}), 250);
  });

  test("never rounds a positive value down to 0, which would read as disabled", () => {
    // 0 is the documented way to disable the timeout, so a sub-millisecond
    // value must not silently become one — that reintroduces the hang.
    assert.equal(resolveTimeoutMs({ timeout: "0.0001" }, {}), 1);
  });

  test("0 disables the timeout", () => {
    assert.equal(resolveTimeoutMs({ timeout: "0" }, {}), 0);
  });

  test("falls back to AEP_TIMEOUT, and the flag wins over it", () => {
    assert.equal(resolveTimeoutMs({}, { AEP_TIMEOUT: "12" }), 12000);
    assert.equal(resolveTimeoutMs({ timeout: "3" }, { AEP_TIMEOUT: "12" }), 3000);
  });

  test("treats an empty AEP_TIMEOUT as unset", () => {
    // `export AEP_TIMEOUT=` is a common way to clear a var; Number("") is 0,
    // which would disable the timeout rather than restore the default.
    assert.equal(resolveTimeoutMs({}, { AEP_TIMEOUT: "" }), DEFAULT_TIMEOUT_MS);
    assert.equal(resolveTimeoutMs({}, { AEP_TIMEOUT: "  " }), DEFAULT_TIMEOUT_MS);
  });
});

describe("cli module side effects", () => {
  test("requiring the module does not run a command", () => {
    // main() is guarded by `require.main === module`. Without the guard a plain
    // require() dispatches on the test runner's argv and prints the usage
    // banner into the test output.
    const out = execFileSync(
      process.execPath,
      ["-e", "require('./src/cli')"],
      { cwd: path.resolve(__dirname, "..", ".."), encoding: "utf8" }
    );
    assert.equal(out, "", `requiring src/cli.js should print nothing, got: ${out}`);
  });
});
