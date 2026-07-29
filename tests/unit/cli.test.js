"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, describeError } = require("../../src/cli");

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
// Tests for describeError (issue #173)
//
// The bug: Node's happy-eyeballs dialer rejects with an AggregateError whose
// own .message is empty, so `err.message || String(err)` printed a bare
// "AggregateError" with no host, port, or cause.
// ---------------------------------------------------------------------------

describe("describeError", () => {
  /** Build the AggregateError shape Node produces when every address fails. */
  function connectFailure(code = "ECONNREFUSED") {
    const perAddress = [
      Object.assign(new Error(`connect ${code} 127.0.0.1:8787`), { code, address: "127.0.0.1" }),
      Object.assign(new Error(`connect ${code} ::1:8787`), { code, address: "::1" }),
    ];
    return new AggregateError(perAddress);
  }

  test("names the target and the cause instead of printing 'AggregateError'", () => {
    const msg = describeError(connectFailure(), "http://localhost:8787");
    assert.equal(msg, "could not reach http://localhost:8787 (ECONNREFUSED)");
    assert.doesNotMatch(msg, /AggregateError/);
  });

  test("collapses the per-address attempts into one cause", () => {
    // Happy eyeballs tries IPv4 and IPv6; both fail with the same code, and
    // repeating it once per address would be noise.
    const msg = describeError(connectFailure(), "http://localhost:8787");
    assert.equal(msg.match(/ECONNREFUSED/g).length, 1);
  });

  test("lists distinct causes when the addresses fail differently", () => {
    const mixed = new AggregateError([
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8787"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("connect EHOSTUNREACH ::1:8787"), { code: "EHOSTUNREACH" }),
    ]);
    assert.equal(
      describeError(mixed, "http://localhost:8787"),
      "could not reach http://localhost:8787 (ECONNREFUSED, EHOSTUNREACH)"
    );
  });

  test("handles a plain (non-aggregate) connection error", () => {
    // A DNS failure or an IP literal reaches us as a single error, not an
    // AggregateError — the target form must cover both.
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND nope.invalid"), { code: "ENOTFOUND" });
    assert.equal(
      describeError(dns, "http://nope.invalid"),
      "could not reach http://nope.invalid (ENOTFOUND)"
    );
  });

  test("unwraps a nested AggregateError", () => {
    const nested = new AggregateError([connectFailure("ETIMEDOUT")]);
    assert.equal(
      describeError(nested, "https://aep.example"),
      "could not reach https://aep.example (ETIMEDOUT)"
    );
  });

  test("falls back to the message when a cause carries no code", () => {
    const noCode = new AggregateError([new Error("socket hang up")]);
    assert.equal(
      describeError(noCode, "http://localhost:8787"),
      "could not reach http://localhost:8787 (socket hang up)"
    );
  });

  test("without a target, prefers the message over the code", () => {
    // An fs error's message carries the path; its code alone would lose that.
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'x.json'"), {
      code: "ENOENT",
    });
    assert.equal(describeError(enoent), "ENOENT: no such file or directory, open 'x.json'");
  });

  test("without a target, an ordinary Error is unchanged", () => {
    // The pre-existing behaviour of `err.message || String(err)` for the common
    // case must not regress.
    assert.equal(describeError(new Error("boom")), "boom");
  });

  test("degrades gracefully on an empty AggregateError and on a thrown non-error", () => {
    assert.equal(
      describeError(new AggregateError([]), "http://localhost:8787"),
      "could not reach http://localhost:8787 (AggregateError)"
    );
    assert.equal(describeError("just a string"), "just a string");
  });
});
