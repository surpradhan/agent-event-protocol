"use strict";

/**
 * Unit tests for the webhook SSRF guard (src/ssrf.js) — pure, no DNS / I/O.
 * Covers scheme/credential rejection, the full set of blocked IPv4/IPv6 ranges
 * (loopback, RFC1918, CGNAT, link-local incl. the cloud metadata endpoint, ULA,
 * reserved), inherently-local hostnames, the allowlist bypass, and the
 * delivery-time DNS-rebind re-check (assertResolvedIpAllowed).
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateWebhookUrl,
  assertResolvedIpAllowed,
  isBlockedIPv4,
  isBlockedIPv6,
  isBlockedHost,
  normalizeAllowlist,
  matchesAllowlist
} = require("../../src/ssrf");

describe("validateWebhookUrl — scheme & shape", () => {
  test("accepts a public https URL", () => {
    const r = validateWebhookUrl("https://hooks.example.com/aep");
    assert.equal(r.ok, true);
    assert.equal(r.host, "hooks.example.com");
  });

  test("accepts a public http URL", () => {
    assert.equal(validateWebhookUrl("http://example.com/x").ok, true);
  });

  test("rejects non-http(s) schemes", () => {
    for (const u of [
      "file:///etc/passwd",
      "gopher://example.com",
      "ftp://example.com/x",
      "data:text/plain,hi",
      "ws://example.com"
    ]) {
      assert.equal(validateWebhookUrl(u).ok, false, u);
    }
  });

  test("rejects embedded credentials", () => {
    const r = validateWebhookUrl("https://user:pass@example.com/x");
    assert.equal(r.ok, false);
    assert.match(r.reason, /credentials/);
  });

  test("rejects empty / non-string / unparseable input", () => {
    assert.equal(validateWebhookUrl("").ok, false);
    assert.equal(validateWebhookUrl(undefined).ok, false);
    assert.equal(validateWebhookUrl(42).ok, false);
    assert.equal(validateWebhookUrl("not a url").ok, false);
  });
});

describe("validateWebhookUrl — SSRF-blocked hosts", () => {
  const blocked = [
    "http://localhost/x",
    "http://LOCALHOST/x",
    "http://foo.localhost/x",
    "http://service.internal/x",
    "http://printer.local/x",
    "http://x.home.arpa/x",
    "http://127.0.0.1/x",
    "http://127.5.5.5/x",
    "http://0.0.0.0/x",
    "http://10.0.0.5/x",
    "http://172.16.9.9/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://100.64.1.1/x", // CGNAT
    "http://198.18.0.1/x", // benchmarking
    "http://[::1]/x", // IPv6 loopback
    "http://[fe80::1]/x", // IPv6 link-local
    "http://[fc00::1]/x", // IPv6 ULA
    "http://[::ffff:127.0.0.1]/x" // IPv4-mapped loopback
  ];
  for (const u of blocked) {
    test(`blocks ${u}`, () => {
      const r = validateWebhookUrl(u);
      assert.equal(r.ok, false, u);
      assert.match(r.reason, /SSRF/);
    });
  }

  test("allows a public IP literal", () => {
    assert.equal(validateWebhookUrl("https://8.8.8.8/x").ok, true);
    assert.equal(validateWebhookUrl("https://[2606:4700:4700::1111]/x").ok, true);
  });
});

describe("isBlockedIPv4 ranges", () => {
  test("private/loopback/link-local are blocked", () => {
    for (const ip of ["0.0.0.0", "10.255.0.1", "127.0.0.1", "169.254.169.254", "172.31.255.1", "192.168.0.1", "100.127.0.1", "255.255.255.255", "240.0.0.1"]) {
      assert.equal(isBlockedIPv4(ip), true, ip);
    }
  });
  test("public addresses are not blocked", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "172.32.0.1", "192.167.255.255"]) {
      assert.equal(isBlockedIPv4(ip), false, ip);
    }
  });
  test("unparseable fails closed (blocked)", () => {
    assert.equal(isBlockedIPv4("999.1.1.1"), true);
    assert.equal(isBlockedIPv4("nope"), true);
  });
});

describe("isBlockedIPv6", () => {
  test("loopback / unspecified / ULA / link-local blocked", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::abcd", "fd12:3456::1", "fec0::1"]) {
      assert.equal(isBlockedIPv6(ip), true, ip);
    }
  });
  test("IPv4-mapped defers to the embedded v4 verdict", () => {
    assert.equal(isBlockedIPv6("::ffff:127.0.0.1"), true);
    assert.equal(isBlockedIPv6("::ffff:8.8.8.8"), false);
  });
  test("public IPv6 not blocked", () => {
    assert.equal(isBlockedIPv6("2606:4700:4700::1111"), false);
  });
});

describe("allowlist", () => {
  test("normalizeAllowlist accepts string or array, lower-cases, trims, drops blanks", () => {
    assert.deepEqual(normalizeAllowlist("A.com, b.com:80 , "), ["a.com", "b.com:80"]);
    assert.deepEqual(normalizeAllowlist(["X:9 ", ""]), ["x:9"]);
    assert.deepEqual(normalizeAllowlist(undefined), []);
  });

  test("matchesAllowlist matches host or host:port", () => {
    assert.equal(matchesAllowlist("127.0.0.1", "9099", ["127.0.0.1:9099"]), true);
    assert.equal(matchesAllowlist("127.0.0.1", "9099", ["127.0.0.1"]), true);
    assert.equal(matchesAllowlist("127.0.0.1", "9099", ["127.0.0.1:9098"]), false);
    assert.equal(matchesAllowlist("127.0.0.1", "", []), false);
  });

  test("an allowlisted private target is accepted by validateWebhookUrl", () => {
    const r = validateWebhookUrl("http://127.0.0.1:9099/hook", { allowlist: "127.0.0.1:9099" });
    assert.equal(r.ok, true);
  });

  test("a private target NOT on the allowlist is still rejected", () => {
    const r = validateWebhookUrl("http://127.0.0.1:9099/hook", { allowlist: "127.0.0.1:9098" });
    assert.equal(r.ok, false);
  });

  test("allowlist never relaxes the scheme/credential rules", () => {
    assert.equal(validateWebhookUrl("file://127.0.0.1/x", { allowlist: "127.0.0.1" }).ok, false);
    assert.equal(validateWebhookUrl("http://u:p@127.0.0.1/x", { allowlist: "127.0.0.1" }).ok, false);
  });
});

describe("assertResolvedIpAllowed (delivery-time DNS-rebind check)", () => {
  test("rejects when any resolved IP is private", () => {
    const r = assertResolvedIpAllowed("evil.example.com", ["8.8.8.8", "127.0.0.1"]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /blocked address/);
  });
  test("accepts when all resolved IPs are public", () => {
    assert.equal(assertResolvedIpAllowed("good.example.com", ["8.8.8.8"]).ok, true);
  });
  test("rejects when nothing resolved", () => {
    assert.equal(assertResolvedIpAllowed("x.example.com", []).ok, false);
  });
  test("an allowlisted host is trusted even if it resolves privately", () => {
    const r = assertResolvedIpAllowed("localhost", ["127.0.0.1"], { allowlist: "localhost" });
    assert.equal(r.ok, true);
  });
});

describe("isBlockedHost dispatch", () => {
  test("routes IP literals and DNS names correctly", () => {
    assert.equal(isBlockedHost("127.0.0.1"), true);
    assert.equal(isBlockedHost("8.8.8.8"), false);
    assert.equal(isBlockedHost("localhost"), true);
    assert.equal(isBlockedHost("example.com"), false);
  });
});
