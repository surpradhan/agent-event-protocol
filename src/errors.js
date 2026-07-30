"use strict";

/**
 * src/errors.js — shared error-rendering helpers for the operator-facing CLIs
 * (src/cli.js, src/prune.js, src/export.js).
 *
 * Node dials every address a host resolves to (happy eyeballs) and, when they
 * all fail, rejects with an AggregateError whose own `.message` is empty — so
 * the obvious `err.message || String(err)` prints a bare "AggregateError" with
 * no host, port, or cause. describeError() unwraps that (and any other thrown
 * error) into one informative terminal line. Originally added to src/cli.js
 * for issue #173/#175; lifted here (issue #176) so src/prune.js and
 * src/export.js — which reach the network via `pg` and the AWS SDK
 * respectively — get the same treatment instead of their own bare
 * `err.message || String(err)`.
 */

const { URL } = require("url");

/** The origin of a URL, for use in an error message.
 *
 *  Prefer `origin` — unlike `href` it drops any userinfo, so a server URL of
 *  the form http://user:pass@host can't put a password on stderr. WHATWG
 *  returns the *string* "null" for a non-special scheme (a typo'd
 *  `--server foo://…`), which would read as "could not reach null". */
function targetOf(url) {
  return url.origin && url.origin !== "null" ? url.origin : `${url.protocol}//${url.host}`;
}

/** How many distinct causes to name before summarising the rest. */
const MAX_CAUSES = 5;

/** Squash an error string onto one terminal line.
 *
 *  OpenSSL-backed messages arrive multi-line and carry a trailing newline plus
 *  a path into node's deps/, none of which belongs in a one-line `Error:`. */
function oneLine(text, max = 160) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Connection codes whose message is typically just "<syscall> <code> <address>".
 *
 *  Membership alone isn't enough to drop the message — the same code can arrive
 *  with a message that explains something (ECONNRESET's is "socket hang up",
 *  which restates neither the syscall nor the code). See restatesCode. */
const TERSE_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
]);

/** Does this message merely restate the code, i.e. "connect ECONNREFUSED <addr>"?
 *
 *  Node puts the syscall first and the code second. Checking the position (not
 *  just "contains") matters: an EPROTO message embeds "EPROTO" mid-string and
 *  then explains the actual TLS problem, which must survive. Anything after the
 *  code is an address — sometimes with a local-address suffix on Windows — and
 *  the error line already names the target. */
function restatesCode(message, code) {
  // Normalise first: the raw message may carry leading or doubled whitespace,
  // and oneLine() only flattens it later, after this decision has been made.
  const words = String(message).trim().split(/\s+/);
  return words[1] === code || (words.length === 1 && words[0] === code);
}

/** Render a thrown/rejected error as one line of terminal detail.
 *
 *  Node dials every address a host resolves to (happy eyeballs) and, when they
 *  all fail, rejects with an AggregateError whose own `.message` is empty — so
 *  the obvious `err.message || String(err)` prints a bare "AggregateError" and
 *  throws away every useful cause. The causes live in `.errors[]`, one per
 *  address tried, so unwrap them (recursively — an AggregateError may nest).
 *
 *  Pass `target` at a call site that knows what it was talking to. That form
 *  leads with the error code, dropping the message only for the codes whose
 *  message restates it (see TERSE_ERROR_CODES) — which is what collapses the
 *  IPv6/IPv4 attempts into a single ECONNREFUSED, while leaving a TLS failure's
 *  reason intact. Without a target the message is the more informative half —
 *  compare "ENOENT" with "ENOENT: no such file or directory, open 'x.json'" —
 *  so the preference flips.
 *
 *  This runs on the failure path, including inside a socket 'error' handler, so
 *  it must not throw: a hostile or exotic error object (throwing getter, cyclic
 *  `.errors`, null prototype) has to degrade to a worse message, never to a
 *  crash. */
function describeError(err, target = null) {
  const label = target
    ? (e) => {
      if (!e.code) return e.message;
      if (!e.message) return e.code;
      // Drop the message only when it says nothing the code and the target
      // don't. That collapses happy eyeballs' per-address attempts into one
      // cause, while keeping "socket hang up" and every TLS reason.
      if (TERSE_ERROR_CODES.has(e.code) && restatesCode(e.message, e.code)) return e.code;
      return `${e.code}: ${e.message}`;
    }
    : (e) => e.message || e.code;

  const causes = new Set();
  const seen = new Set();

  /** Collect this node's cause, or its children's. Returns whether anything
   *  described it — which is the signal to stop, not the size of `causes`, since
   *  a child whose label duplicates a sibling's adds nothing to the Set. */
  const collect = (e) => {
    if (!e || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e); // cyclic .errors would otherwise recurse until the stack blows
    try {
      // Descend only when the children actually describe something. `.errors`
      // is not exclusive to AggregateError — a validation error may hang plain
      // objects there that carry neither message nor code, and losing the
      // parent's own message to them would regress what `err.message` gave.
      if (Array.isArray(e.errors) && e.errors.length > 0) {
        let described = false;
        for (const child of e.errors) {
          if (collect(child)) described = true;
        }
        if (described) return true;
      }
      const text = label(e);
      if (!text) return false;
      // Keep one past the cap so the caller can tell "exactly MAX" from "more".
      if (causes.size <= MAX_CAUSES) causes.add(oneLine(text));
      return true;
    } catch (_) {
      // A getter threw. Skip this node rather than lose the whole report.
      return false;
    }
  };
  collect(err);

  const listed = [...causes];
  let detail = listed.slice(0, MAX_CAUSES).join(", ");
  if (listed.length > MAX_CAUSES) detail += ", …";
  if (!detail) {
    try { detail = String(err); } catch (_) { detail = "unknown error"; }
  }
  return target ? `could not reach ${target} (${detail})` : detail;
}

/** Is this a transport-level failure — the peer was never reached?
 *
 *  Decides whether "could not reach <target>" framing is honest. An auth
 *  failure or a service-side error means the dial succeeded, and wrapping it
 *  as unreachable would point the operator at the network instead of at their
 *  credentials/config. Deliberately walks the same shape describeError's
 *  `collect()` does — `.code` and (recursively) `.errors`, e.g. a
 *  happy-eyeballs AggregateError's per-address attempts — and no further, so
 *  a "yes" here is a promise describeError(err, target) can actually keep.
 *  (`.cause` is not walked: a library may wrap a dial failure there — see
 *  pg-pool's connection-timeout error — but describeError doesn't narrate
 *  through it, and teaching it to is a separate, deliberately out-of-scope
 *  change; see issue #186.) Runs on failure paths — same never-throw
 *  contract as describeError. */
function isUnreachable(err, seen = new Set()) {
  if (!err || typeof err !== "object" || seen.has(err)) return false;
  seen.add(err);
  try {
    if (TERSE_ERROR_CODES.has(err.code)) return true;
    return Array.isArray(err.errors) && err.errors.some((e) => isUnreachable(e, seen));
  } catch (_) {
    return false; // a getter threw — can't tell, so don't reframe
  }
}

/** Attach a target to an unreachable-network error; pass anything else through.
 *
 *  For a dial failure this returns a new Error whose `.message` is the full
 *  cli.js-style line — "could not reach <target> (<causes>)" — with the
 *  original as `.cause`, so a later `describeError(err)` (no target) prints it
 *  as-is: the top-level handlers in src/prune.js / src/export.js need no
 *  change. A reached-server failure (bad password, missing bucket) or a null
 *  target returns `err` untouched, keeping its own, more accurate message. */
function withTarget(err, target) {
  if (!target || !isUnreachable(err)) return err;
  return new Error(describeError(err, target), { cause: err });
}

/** Credential-free target for the configured storage backend, or null.
 *
 *  Names what src/db's Postgres backend will dial, for error messages —
 *  mirroring its config resolution (DATABASE_URL, else libpq's PGHOST/PGPORT,
 *  else localhost:5432). Returns null whenever there is no network target to
 *  name: the sqlite backend (a file, whose errors already carry the path), a
 *  unix-socket PGHOST, or a DATABASE_URL in a shape WHATWG won't parse
 *  (key=value form) — parsing is how credentials are provably dropped, so an
 *  unparseable string is never echoed. */
function databaseTarget(env = process.env) {
  if (String(env.STORAGE_BACKEND || "sqlite").toLowerCase() !== "postgres") return null;
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      return url.host ? targetOf(url) : null;
    } catch (_) {
      return null;
    }
  }
  const host = env.PGHOST || "localhost";
  if (host.startsWith("/")) return null; // unix-socket directory, not a dial target
  return `postgres://${host}:${env.PGPORT || "5432"}`;
}

module.exports = { describeError, targetOf, withTarget, databaseTarget };
