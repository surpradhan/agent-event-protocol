"use strict";

/**
 * SSRF guard for outbound webhook targets (Phase 16).
 *
 * This is the project's FIRST feature that makes outbound network calls, so the
 * target URL a tenant registers is attacker-controlled and must be treated as
 * hostile. This module is the single, pure, well-tested gate that decides whether
 * a URL may ever be contacted. It is applied BOTH at registration time
 * (POST /webhooks, 16-A) and again at delivery time (16-B) — because DNS can be
 * rebound between the two, the delivery-time check additionally re-validates the
 * resolved IP literals (see assertResolvedIpAllowed).
 *
 * Default-deny posture for anything that could reach the host's own network:
 *   • non-http(s) schemes (file:, gopher:, data:, ftp:, …)
 *   • embedded credentials (user:pass@host) — credential leakage / smuggling
 *   • loopback (127.0.0.0/8, ::1) and the unspecified address (0.0.0.0, ::)
 *   • RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
 *   • CGNAT (100.64/10), link-local (169.254/16 — incl. the 169.254.169.254
 *     cloud metadata endpoint), IPv6 ULA (fc00::/7) and link-local (fe80::/10)
 *   • other reserved/non-routable ranges (0/8, 192.0.0/24, 198.18/15, 240/4,
 *     the v4 broadcast address, and IPv4-mapped IPv6 that embeds any of the above)
 *   • hostnames that are inherently local: localhost (and *.localhost), and the
 *     .internal / .local / .localhost / .home.arpa suffixes
 *
 * Self-hosters who legitimately need a private target (an internal alerting
 * service, or a localhost listener in tests) pass an explicit allowlist of
 * `host` or `host:port` entries; an allowlisted host bypasses the private-range
 * block but still must use http/https and still cannot carry credentials.
 *
 * Everything here is pure and synchronous (no DNS, no I/O) so it is trivially
 * unit-testable; the only async helper, assertResolvedIpAllowed, is given the
 * already-resolved addresses by the caller.
 */

const net = require("net");
const { URL } = require("url");

/** Convert a dotted-quad IPv4 string to a 32-bit unsigned integer. */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** True if `n` (a 32-bit int) is inside the CIDR block base/prefix. */
function inV4Cidr(n, baseIp, prefix) {
  const base = ipv4ToInt(baseIp);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (n & mask) === (base & mask);
}

/**
 * Is this IPv4 literal a private / loopback / link-local / otherwise
 * non-publicly-routable address that an SSRF target should never reach?
 */
function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → fail closed
  return (
    inV4Cidr(n, "0.0.0.0", 8) ||        // "this" network / 0.0.0.0
    inV4Cidr(n, "10.0.0.0", 8) ||       // RFC1918 private
    inV4Cidr(n, "100.64.0.0", 10) ||    // CGNAT (RFC6598)
    inV4Cidr(n, "127.0.0.0", 8) ||      // loopback
    inV4Cidr(n, "169.254.0.0", 16) ||   // link-local (incl. 169.254.169.254 metadata)
    inV4Cidr(n, "172.16.0.0", 12) ||    // RFC1918 private
    inV4Cidr(n, "192.0.0.0", 24) ||     // IETF protocol assignments
    inV4Cidr(n, "192.168.0.0", 16) ||   // RFC1918 private
    inV4Cidr(n, "198.18.0.0", 15) ||    // benchmarking (RFC2544)
    inV4Cidr(n, "240.0.0.0", 4) ||      // reserved / future use (incl. 255.255.255.255)
    n === 0xffffffff                    // limited broadcast
  );
}

/**
 * Expand an IPv6 literal to its 8 hextets (array of 8 ints), or null if it cannot
 * be parsed. Handles "::" compression and a trailing embedded IPv4 dotted-quad
 * (e.g. ::ffff:127.0.0.1), so the verdict does not depend on how the WHATWG URL
 * parser chose to print the address.
 */
function expandIPv6(ip) {
  let s = ip.toLowerCase();

  // Convert a trailing embedded IPv4 (::ffff:a.b.c.d / ::a.b.c.d) into two hextets.
  const v4 = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const n = ipv4ToInt(v4[2]);
    if (n === null) return null;
    s = v4[1] + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null; // no "::" → must be fully specified
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/**
 * Is this IPv6 literal a loopback / unspecified / ULA / link-local address, or an
 * IPv4-mapped address that embeds a blocked IPv4? Operates on the fully-expanded
 * form so abbreviated/compressed inputs (fe80::1, ::ffff:7f00:1) are all caught.
 */
function isBlockedIPv6(ip) {
  const g = expandIPv6(ip);
  if (g === null) return true; // unparseable → fail closed

  // Unspecified (::) and loopback (::1).
  if (g.every((h) => h === 0)) return true;
  if (g.slice(0, 7).every((h) => h === 0) && g[7] === 1) return true;

  // Addresses that embed an IPv4 in their low 32 bits — defer to the embedded
  // IPv4 verdict so e.g. ::ffff:127.0.0.1 is blocked:
  //   • ::ffff:0:0/96  IPv4-mapped
  //   • ::/96          IPv4-compatible (deprecated)
  //   • 64:ff9b::/96   NAT64 well-known prefix (RFC 6052) — a literal here is
  //     translated by a NAT64 gateway to the embedded v4, so it's a real SSRF
  //     vector when one is present; decode it and block private embeddings.
  const firstFiveZero = g.slice(0, 5).every((h) => h === 0);
  const isMappedOrCompat = firstFiveZero && (g[5] === 0xffff || g[5] === 0);
  const isNat64 = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (isMappedOrCompat || isNat64) {
    const embedded = `${(g[6] >>> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >>> 8) & 0xff}.${g[7] & 0xff}`;
    return isBlockedIPv4(embedded);
  }

  // fc00::/7 (unique-local fc00–fdff), fe80::/10 (link-local fe80–febf),
  // fec0::/10 (deprecated site-local fec0–feff).
  const h0 = g[0];
  if (h0 >= 0xfc00 && h0 <= 0xfdff) return true;
  if (h0 >= 0xfe80 && h0 <= 0xfebf) return true;
  if (h0 >= 0xfec0 && h0 <= 0xfeff) return true;
  return false;
}

/**
 * Lower-cased hostname with any IPv6 brackets stripped and a single trailing
 * dot removed. The WHATWG URL parser keeps a trailing-dot FQDN (e.g. `localhost.`,
 * which still resolves to 127.0.0.1) verbatim, so canonicalizing it here is what
 * lets the inherently-local suffix check below actually catch it.
 */
function normalizeHost(hostname) {
  let h = (hostname || "").toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Hostnames that are inherently local/internal regardless of DNS. We block the
 * bare name and any subdomain of these suffixes.
 */
function isBlockedHostname(host) {
  if (!host) return true;
  if (host === "localhost") return true;
  const suffixes = [".localhost", ".local", ".internal", ".home.arpa"];
  return suffixes.some((s) => host.endsWith(s));
}

/**
 * Decide whether a literal host (IP or DNS name) is blocked by default policy.
 * Pure: no DNS. For DNS names this only catches inherently-local names; a name
 * that resolves to a private IP is caught at delivery time by
 * assertResolvedIpAllowed.
 */
function isBlockedHost(host) {
  const kind = net.isIP(host);
  if (kind === 4) return isBlockedIPv4(host);
  if (kind === 6) return isBlockedIPv6(host);
  return isBlockedHostname(host);
}

/**
 * Build a normalized allowlist match-set from raw entries (e.g. from the
 * WEBHOOK_TARGET_ALLOWLIST env var). Each entry is `host` or `host:port`,
 * lower-cased and trimmed; blanks dropped.
 */
function normalizeAllowlist(entries) {
  const list = Array.isArray(entries)
    ? entries
    : typeof entries === "string"
      ? entries.split(",")
      : [];
  return list.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

/** Does this host[:port] match an allowlist entry (host or host:port)? */
function matchesAllowlist(host, port, allowlist) {
  if (!allowlist || allowlist.length === 0) return false;
  const hostOnly = host;
  const hostPort = port ? `${host}:${port}` : null;
  return allowlist.some((e) => e === hostOnly || (hostPort && e === hostPort));
}

/**
 * Validate a webhook target URL. Pure (no DNS).
 *
 * @param {string} rawUrl
 * @param {{ allowlist?: string[]|string }} [opts]
 * @returns {{ ok: true, url: string, host: string, port: string }
 *          | { ok: false, reason: string }}
 */
function validateWebhookUrl(rawUrl, { allowlist } = {}) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { ok: false, reason: "target_url must be a non-empty string" };
  }
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "target_url is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "target_url must use http or https" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "target_url must not contain embedded credentials" };
  }
  const host = normalizeHost(url.hostname);
  if (!host) {
    return { ok: false, reason: "target_url must include a host" };
  }

  const allow = normalizeAllowlist(allowlist);
  if (matchesAllowlist(host, url.port, allow)) {
    return { ok: true, url: url.toString(), host, port: url.port };
  }

  if (isBlockedHost(host)) {
    return {
      ok: false,
      reason:
        "target_url host is a loopback, private, link-local, or otherwise " +
        "non-public address (blocked to prevent SSRF)"
    };
  }
  return { ok: true, url: url.toString(), host, port: url.port };
}

/**
 * Delivery-time guard against DNS rebinding: given the IP literals a host
 * resolved to, reject if ANY of them is a blocked address (unless the host was
 * explicitly allowlisted). Pure — the caller performs the DNS lookup.
 *
 * @param {string} host           the (already allowlist-checked) host
 * @param {string[]} resolvedIps  IP literals from DNS resolution
 * @param {{ allowlist?: string[]|string }} [opts]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function assertResolvedIpAllowed(host, resolvedIps, { allowlist } = {}) {
  const allow = normalizeAllowlist(allowlist);
  // An allowlisted host is trusted even if it resolves privately (that is the
  // whole point of the allowlist — e.g. a localhost test listener).
  if (matchesAllowlist(normalizeHost(host), null, allow)) return { ok: true };

  if (!Array.isArray(resolvedIps) || resolvedIps.length === 0) {
    return { ok: false, reason: "host did not resolve to any address" };
  }
  for (const ip of resolvedIps) {
    if (isBlockedHost(ip)) {
      return {
        ok: false,
        reason: `host resolved to a blocked address (${ip})`
      };
    }
  }
  return { ok: true };
}

module.exports = {
  validateWebhookUrl,
  assertResolvedIpAllowed,
  // exported for unit tests
  isBlockedIPv4,
  isBlockedIPv6,
  isBlockedHost,
  normalizeAllowlist,
  matchesAllowlist
};
