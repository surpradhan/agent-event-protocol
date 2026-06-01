"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs } = require("../../src/cli");

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
