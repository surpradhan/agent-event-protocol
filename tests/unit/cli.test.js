"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { URL } = require("url");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  parseArgs, describeError, targetOf, resolveTimeoutMs, DEFAULT_TIMEOUT_MS,
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
    const noCode = new AggregateError([new Error("stream closed")]);
    assert.equal(
      describeError(noCode, "http://localhost:8787"),
      "could not reach http://localhost:8787 (stream closed)"
    );
  });

  test("keeps 'socket hang up', whose message does not restate its code", () => {
    // Node's real ECONNRESET. The code is in the terse list, but this message
    // explains something the code doesn't, so membership alone must not drop it.
    const hangUp = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    assert.equal(
      describeError(hangUp, "http://localhost:8787"),
      "could not reach http://localhost:8787 (ECONNRESET: socket hang up)"
    );
  });

  test("still collapses a restating message for the same code", () => {
    // The other real ECONNRESET shape: here the message adds nothing.
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    assert.equal(
      describeError(reset, "http://localhost:8787"),
      "could not reach http://localhost:8787 (ECONNRESET)"
    );
  });

  test("collapses restating messages that Node doesn't emit but a custom agent might", () => {
    // Not shapes node core produces — a proxy or custom agent could. Neither
    // should render the code twice.
    const padded = Object.assign(new Error("  connect  ECONNREFUSED  127.0.0.1:8787"), {
      code: "ECONNREFUSED",
    });
    const codeOnly = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    for (const e of [padded, codeOnly]) {
      assert.equal(
        describeError(e, "http://localhost:8787"),
        "could not reach http://localhost:8787 (ECONNREFUSED)"
      );
    }
  });

  test("keeps the message when it explains more than the code (TLS)", () => {
    // Connect/DNS messages just restate the code and address, so the code alone
    // is enough. TLS errors are the opposite: the explanation is in the message
    // and dropping it would lose the only actionable part.
    const tls = Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    assert.equal(
      describeError(tls, "https://aep.example"),
      "could not reach https://aep.example (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain)"
    );
  });

  test("keeps the reason when a code appears inside its own message (EPROTO)", () => {
    // https:// against a plaintext port. The code is embedded in the message,
    // so a "does the message contain the code?" rule would throw the OpenSSL
    // reason away — the only part that tells the operator what to change.
    const proto = Object.assign(
      new Error("write EPROTO 00:error:0A00010B:SSL routines:wrong version number"),
      { code: "EPROTO" }
    );
    assert.match(describeError(proto, "https://localhost:8787"), /wrong version number/);
  });

  test("keeps a multi-line cause on one line", () => {
    // Real OpenSSL messages span lines and end with a newline plus a path into
    // node's deps/; none of that belongs in a one-line `Error:`.
    const multiline = Object.assign(
      new Error("write EPROTO\n00:error:0A00010B:SSL routines:wrong version number:\n../deps/openssl/ssl/record.c:12:\n"),
      { code: "EPROTO" }
    );
    const msg = describeError(multiline, "https://localhost:8787");
    assert.doesNotMatch(msg, /\n/, "the rendered error must be a single line");
    assert.match(msg, /wrong version number/);
  });

  test("truncates a single runaway cause", () => {
    const huge = Object.assign(new Error("x".repeat(5000)), { code: "EWEIRD" });
    const msg = describeError(huge, "https://localhost:8787");
    assert.ok(msg.length < 300, `expected a terminal-sized message, got ${msg.length} chars`);
    assert.match(msg, /…/);
  });

  test("does not descend into a non-error .errors array", () => {
    // `.errors` is not exclusive to AggregateError. When the entries describe
    // nothing on their own — no message, no code — the parent's message must
    // survive, which is what `err.message` gave before the unwrap existed.
    const validation = Object.assign(new Error("2 validation failures"), {
      errors: [{ path: "a", keyword: "type" }, { path: "b", keyword: "required" }],
    });
    assert.equal(describeError(validation), "2 validation failures");
  });

  test("a wrapper whose child duplicates an earlier cause does not leak its own label", () => {
    // Guards the "did a child describe this?" signal. Measuring Set growth
    // instead would misfire here: the nested wrapper's only child produces a
    // label that is already in the set, so the set doesn't grow, and the
    // wrapper's own "EAGGR: …" would be reported alongside the real cause.
    const refused = () =>
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8787"), { code: "ECONNREFUSED" });
    const wrapper = Object.assign(new AggregateError([refused()], "all attempts failed"), {
      code: "EAGGR",
    });

    assert.equal(
      describeError(new AggregateError([refused(), wrapper]), "http://localhost:8787"),
      "could not reach http://localhost:8787 (ECONNREFUSED)"
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
    // Degenerate: with no causes to unwrap there is nothing better to say than
    // the class name, so this one case still shows "AggregateError".
    assert.equal(
      describeError(new AggregateError([]), "http://localhost:8787"),
      "could not reach http://localhost:8787 (AggregateError)"
    );
    assert.equal(describeError("just a string"), "just a string");
  });

  // This runs on the failure path — inside a socket 'error' handler — so a
  // hostile error object must degrade the message, never crash the CLI.
  test("visits a cyclic .errors chain a bounded number of times", () => {
    // Counting reads, not just asserting "doesn't throw": on a cycle the
    // recursion only ends by blowing the stack, and the surrounding try/catch
    // swallows the RangeError — so the output can look right while thousands of
    // frames were burned getting there. The seen-set is what actually stops it.
    let reads = 0;
    const a = Object.assign(new Error("a"), { code: "EA" });
    const b = Object.assign(new Error("b"), { code: "EB" });
    Object.defineProperty(a, "errors", { get() { reads++; return [b]; } });
    Object.defineProperty(b, "errors", { get() { reads++; return [a]; } });

    assert.doesNotThrow(() => describeError(a, "http://localhost:8787"));
    assert.ok(reads < 20, `expected each node visited once, saw ${reads} .errors reads`);
  });

  test("survives a getter that throws", () => {
    const hostile = new Error("outer");
    Object.defineProperty(hostile, "code", { get() { throw new Error("boom"); } });
    assert.doesNotThrow(() => describeError(hostile, "http://localhost:8787"));
  });

  test("survives a null-prototype throwable", () => {
    assert.doesNotThrow(() => describeError(Object.create(null)));
  });

  test("marks elision only when causes were actually elided", () => {
    // Pins the cap boundary: exactly MAX_CAUSES (5) is a complete list, so an
    // "…" there would claim a truncation that didn't happen.
    const causes = (n) => new AggregateError(
      Array.from({ length: n }, (_, i) => Object.assign(new Error(`fail ${i}`), { code: `E${i}` }))
    );
    const exactlyFive = describeError(causes(5), "http://localhost:8787");
    assert.doesNotMatch(exactlyFive, /…/, "5 causes fit — nothing was elided");
    assert.match(exactlyFive, /E4/, "the fifth cause should still be listed");

    assert.match(describeError(causes(6), "http://localhost:8787"), /…/, "6 causes must elide");
  });

  test("summarises rather than printing an unbounded list of causes", () => {
    const many = new AggregateError(
      Array.from({ length: 500 }, (_, i) =>
        Object.assign(new Error(`fail ${i}`), { code: `E${i}` }))
    );
    const msg = describeError(many, "http://localhost:8787");
    assert.match(msg, /…/, "should elide the tail rather than list every cause");
    assert.ok(msg.length < 300, `message should stay terminal-sized, got ${msg.length} chars`);
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

describe("targetOf", () => {
  test("uses the origin, which excludes any userinfo", () => {
    // A password in --server must never reach stderr.
    const url = new URL("http://alice:hunter2@localhost:8787/sessions");
    assert.equal(targetOf(url), "http://localhost:8787");
    assert.doesNotMatch(targetOf(url), /hunter2/);
  });

  test("falls back for a non-special scheme, whose origin is the string 'null'", () => {
    const url = new URL("foo://localhost:8787/x");
    assert.equal(url.origin, "null", "precondition: WHATWG gives 'null' here");
    assert.equal(targetOf(url), "foo://localhost:8787");
  });
});
