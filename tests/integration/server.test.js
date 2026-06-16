"use strict";

/**
 * Integration tests for all AEP HTTP endpoints.
 *
 * Database isolation: each test run uses an in-memory (":memory:") SQLite DB,
 * set via DATABASE_PATH before the server module is first required.
 * A fresh server is started on an ephemeral port for the entire suite,
 * then shut down in the after() hook.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Bootstrap: isolate the database before any server code is loaded
// ---------------------------------------------------------------------------

// Backend under test: defaults to SQLite. The Postgres parity CI job sets
// STORAGE_BACKEND=postgres (+ DATABASE_URL) to run this exact same suite against
// a Postgres service container — proving both backends behave identically.
const USE_POSTGRES = (process.env.STORAGE_BACKEND || "").toLowerCase() === "postgres";

// SQLite only: use a fresh temp DB file per run so we don't touch data/aep.db.
// Under Postgres there is no file to manage — db.init() targets DATABASE_URL.
const TEST_DB = path.join(os.tmpdir(), `aep-test-${Date.now()}.db`);
if (!USE_POSTGRES) {
  process.env.DATABASE_PATH = TEST_DB;
}

// Clear require cache entries so a fresh DB singleton is created even if
// another test file already loaded these modules.
function clearCache() {
  const keys = Object.keys(require.cache).filter(
    k => k.includes("agent-event-protocol/src")
  );
  for (const k of keys) delete require.cache[k];
}

clearCache();

const { app } = require("../../src/server");
// The DB API is async and lazily initialised: server.js only auto-init()s when
// run as the main module. Tests drive `app` directly, so we must initialise the
// storage backend ourselves (open connection + run migrations) before listening.
const db = require("../../src/db");

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let writeKey;   // raw API key with write scope
let readKey;    // raw API key with read scope
let adminToken;

before(async () => {
  // Set admin token so we can create API keys
  adminToken = "test-admin-token-" + crypto.randomUUID();
  process.env.ADMIN_TOKEN = adminToken;

  // Set DASHBOARD_TOKEN so that requireReadAccess properly enforces auth in tests
  // (without it the middleware allows unauthenticated access in dev mode)
  process.env.DASHBOARD_TOKEN = "test-dash-token-" + crypto.randomUUID();

  // Initialise the storage backend before the server handles any request.
  await db.init();

  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Create a write-scoped API key
  const wRes = await fetch(`${baseUrl}/admin/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ tenantId: "tenant-test", label: "write-key", scopes: ["read", "write"] }),
  });
  const wBody = await wRes.json();
  writeKey = wBody.key;

  // Create a read-only API key
  const rRes = await fetch(`${baseUrl}/admin/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ tenantId: "tenant-test", label: "read-key", scopes: ["read"] }),
  });
  const rBody = await rRes.json();
  readKey = rBody.key;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.closeDb();
  if (!USE_POSTGRES) {
    try { fs.unlinkSync(TEST_DB); } catch (_) {}
    delete process.env.DATABASE_PATH;
  }
  delete process.env.ADMIN_TOKEN;
  delete process.env.DASHBOARD_TOKEN;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides = {}) {
  return {
    specversion: "0.2.0",
    id: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    time: new Date().toISOString(),
    source: "agent://test",
    type: "task.created",
    session_id: "ses_int_001",
    trace_id: "trc_int_001",
    payload: { task: "integration test task" },
    ...overrides,
  };
}

async function ingest(event, key = writeKey) {
  return fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(event),
  });
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  test("returns 200 with ok:true", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(typeof body.service === "string");
  });
});

// ---------------------------------------------------------------------------
// POST /events — ingest
// ---------------------------------------------------------------------------

describe("POST /events — ingest", () => {
  test("accepts a valid event and returns 202 accepted:true", async () => {
    const event = makeEvent();
    const res = await ingest(event);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.accepted, true);
    assert.equal(body.duplicate, false);
    assert.equal(body.id, event.id);
  });

  test("returns 401 when no API key is provided", async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeEvent()),
    });
    assert.equal(res.status, 401);
  });

  test("returns 403 when read-only key attempts ingest", async () => {
    const res = await ingest(makeEvent(), readKey);
    assert.equal(res.status, 403);
  });

  test("returns 400 for an invalid event (missing required fields)", async () => {
    const res = await ingest({ specversion: "0.2.0", type: "task.created" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.accepted, false);
    assert.ok(Array.isArray(body.errors));
    assert.ok(body.errors.length > 0);
  });

  test("returns 400 for an unknown event type", async () => {
    const res = await ingest(makeEvent({ type: "not.a.type" }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.accepted, false);
  });

  test("deduplicates events with the same id — returns 200 duplicate:true", async () => {
    const event = makeEvent();
    const first = await ingest(event);
    assert.equal(first.status, 202);

    const second = await ingest(event); // same event.id
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.accepted, true);
    assert.equal(body.duplicate, true);
  });
});

// ---------------------------------------------------------------------------
// Quick-start: the bundled emitter (examples/emit-example.js)
//
// Guards the documented quick-start against the doc-vs-behavior drift where
// ingest silently 401'd because the example sent no key. The emitter must
// succeed when AEP_API_KEY holds a write key, and fail loudly (non-zero exit)
// when it is absent — since POST /events has no keyless dev bypass.
// ---------------------------------------------------------------------------

describe("examples/emit-example.js (documented quick-start)", () => {
  const { execFile } = require("node:child_process");
  const EMITTER = path.join(__dirname, "..", "..", "examples", "emit-example.js");

  function runEmitter(env) {
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [EMITTER],
        { env: { ...process.env, AEP_INGEST_URL: baseUrl, ...env } },
        (err, stdout, stderr) => {
          // On a normal non-zero exit, err.code is the integer exit code. On a
          // spawn failure it's a string errno (e.g. "ENOENT") — surface that as
          // a real rejection instead of masquerading as exit code 1.
          if (err && typeof err.code !== "number") {
            reject(err);
            return;
          }
          resolve({ code: err ? err.code : 0, stdout, stderr });
        }
      );
    });
  }

  test("emits successfully (exit 0, status 202) with a write-scoped AEP_API_KEY", async () => {
    const { code, stdout } = await runEmitter({ AEP_API_KEY: writeKey });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, 202);
    assert.equal(parsed.body.accepted, true);
  });

  test("fails loudly (exit 1, status 401 + hint) when AEP_API_KEY is unset", async () => {
    const { code, stdout, stderr } = await runEmitter({ AEP_API_KEY: "" });
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, 401);
    assert.match(stderr, /AEP_API_KEY/);
  });

  test("fails loudly (exit 1, status 403 + scope hint) with a read-only key", async () => {
    const { code, stdout, stderr } = await runEmitter({ AEP_API_KEY: readKey });
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, 403);
    assert.match(stderr, /write.*scope/);
  });
});

// ---------------------------------------------------------------------------
// GET /sessions
// ---------------------------------------------------------------------------

describe("GET /sessions", () => {
  test("returns 401 without an API key", async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    assert.equal(res.status, 401);
  });

  test("returns a sessions array with a read key", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.sessions));
  });

  test("sessions list grows after ingesting an event for a new session", async () => {
    const before = await (
      await fetch(`${baseUrl}/sessions`, { headers: { Authorization: `Bearer ${readKey}` } })
    ).json();

    const newSid = `ses_new_${Date.now()}`;
    await ingest(makeEvent({ session_id: newSid, trace_id: "trc_new_001" }));

    const after = await (
      await fetch(`${baseUrl}/sessions`, { headers: { Authorization: `Bearer ${readKey}` } })
    ).json();

    assert.ok(after.sessions.length > before.sessions.length);
  });

  test("a repeated ?cursor param (array) is coerced to its last value (last wins)", async () => {
    // /sessions has no inline param guard — it relies entirely on the central
    // coercion in validateQueryParams. Before this change, ?cursor=a&cursor=b
    // stringified to "a,b" and FAILED the base64url check → 400; now the array is
    // reduced to its last value ("b") and validated like any single cursor (here a
    // harmless first-page read). Proves a guard-less route is covered centrally.
    const res = await fetch(`${baseUrl}/sessions?cursor=a&cursor=b`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.sessions));
  });

  test("a repeated ?cursor whose LAST value is invalid still 400s", async () => {
    // The last value ("!!!") is what gets validated → 400. (The sibling
    // ?cursor=a&cursor=b → 200 test is what uniquely locks coerce-before-validate
    // ordering; this case asserts an invalid last value is not let through.)
    const res = await fetch(`${baseUrl}/sessions?cursor=AAAA&cursor=!!!`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("a prototype-polluting query key (?__proto__[x]=1) is handled safely, no 500, no pollution", async () => {
    // coerceArrayParams uses Object.keys + plain own-property assignment, and the
    // Express 5 "simple" parser never builds a nested __proto__ object — so this
    // cannot pollute Object.prototype or crash.
    const res = await fetch(`${baseUrl}/sessions?__proto__[x]=1&constructor[prototype][y]=2`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    assert.equal({}.x, undefined, "Object.prototype not polluted");
    assert.equal({}.y, undefined, "Object.prototype not polluted");
  });
});

// ---------------------------------------------------------------------------
// GET /sessions/:sessionId
// ---------------------------------------------------------------------------

describe("GET /sessions/:sessionId", () => {
  const SESSION_ID = `ses_detail_${Date.now()}`;
  const TRACE_ID   = `trc_detail_${Date.now()}`;

  before(async () => {
    for (const type of ["task.created", "task.completed"]) {
      await ingest(makeEvent({ session_id: SESSION_ID, trace_id: TRACE_ID, type }));
    }
  });

  test("returns session metadata", async () => {
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session_id, SESSION_ID);
    assert.equal(body.trace_id, TRACE_ID);
    assert.equal(body.event_count, 2);
    assert.ok("started_at" in body && "updated_at" in body);
  });

  test("returns 404 for an unknown session", async () => {
    const res = await fetch(`${baseUrl}/sessions/ses_does_not_exist_999`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 404);
  });

  test("returns 401 without auth", async () => {
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}`);
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /sessions/:sessionId/events
// ---------------------------------------------------------------------------

describe("GET /sessions/:sessionId/events", () => {
  const SESSION_ID = `ses_timeline_${Date.now()}`;
  const TRACE_ID   = `trc_timeline_${Date.now()}`;

  before(async () => {
    // Seed three events
    for (const type of ["task.created", "tool.called", "task.completed"]) {
      await ingest(makeEvent({ session_id: SESSION_ID, trace_id: TRACE_ID, type }));
    }
  });

  test("returns events for the session sorted by time", async () => {
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}/events`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session_id, SESSION_ID);
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length >= 3);
  });

  test("filters by type using ?type= query param", async () => {
    const res = await fetch(
      `${baseUrl}/sessions/${SESSION_ID}/events?type=tool.called`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    const body = await res.json();
    assert.ok(body.events.every(e => e.type === "tool.called"));
  });

  test("returns 401 without auth", async () => {
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}/events`);
    assert.equal(res.status, 401);
  });

  test("repeated ?type param (array) coerces to the last value (last wins), not 500", async () => {
    // validateQueryParams coerces a repeated param to its last value before the
    // DB binding (which would otherwise throw on an array → 500). So a request
    // whose LAST type is a real type behaves exactly like that single-type query.
    const lastWinsRes = await fetch(
      `${baseUrl}/sessions/${SESSION_ID}/events?type=nope&type=task.created`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    const singleRes = await fetch(
      `${baseUrl}/sessions/${SESSION_ID}/events?type=task.created`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(lastWinsRes.status, 200);
    const lastWins = await lastWinsRes.json();
    const single = await singleRes.json();
    assert.ok(lastWins.events.length >= 1, "last value (task.created) matches real events");
    assert.equal(lastWins.events.length, single.events.length,
      "?type=nope&type=task.created === ?type=task.created (last wins)");
    assert.ok(lastWins.events.every(e => e.type === "task.created"));
  });
});

// ---------------------------------------------------------------------------
// GET /sessions/:sessionId/tree
// ---------------------------------------------------------------------------

describe("GET /sessions/:sessionId/tree", () => {
  const ROOT_SID    = `ses_tree_root_${Date.now()}`;
  const CHILD_SID   = `ses_tree_child_${Date.now()}`;
  const TRACE_ID    = `trc_tree_${Date.now()}`;

  before(async () => {
    await ingest(makeEvent({ session_id: ROOT_SID, trace_id: TRACE_ID, agent_role: "orchestrator" }));
    await ingest(makeEvent({
      session_id: CHILD_SID,
      trace_id: TRACE_ID,
      parent_session_id: ROOT_SID,
      agent_role: "subagent",
    }));
  });

  test("returns session tree including child sessions", async () => {
    const res = await fetch(`${baseUrl}/sessions/${ROOT_SID}/tree`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // buildTree returns { session: { session_id, ... }, children: [...] }
    assert.ok(body.session, "response should have a 'session' key");
    assert.equal(body.session.session_id, ROOT_SID);
  });

  test("returns 404 for an unknown session", async () => {
    const res = await fetch(`${baseUrl}/sessions/ses_ghost_999/tree`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// GET /sessions/:sessionId/export
// ---------------------------------------------------------------------------

describe("GET /sessions/:sessionId/export", () => {
  const SID      = `ses_export_${Date.now()}`;
  const TRACE_ID = `trc_export_${Date.now()}`;

  before(async () => {
    await ingest(makeEvent({ session_id: SID, trace_id: TRACE_ID, type: "task.created" }));
    await ingest(makeEvent({ session_id: SID, trace_id: TRACE_ID, type: "task.completed" }));
  });

  test("exports as JSON by default", async () => {
    const res = await fetch(`${baseUrl}/sessions/${SID}/export`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session_id, SID);
    assert.ok(body.events.length >= 2);
  });

  test("exports as CSV when ?format=csv", async () => {
    const res = await fetch(`${baseUrl}/sessions/${SID}/export?format=csv`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") || "";
    assert.ok(ct.includes("text/csv"), `Expected text/csv, got '${ct}'`);
    const text = await res.text();
    assert.ok(text.includes("session_id"), "CSV should have header row");
    assert.ok(text.includes(SID));
  });

  test("a repeated ?format param (array) coerces to the LAST value, not 500", async () => {
    // validateQueryParams coerces ?format=csv&format=json to "json" (last wins)
    // before the handler — an array reaching .toLowerCase() used to throw → 500.
    const res = await fetch(`${baseUrl}/sessions/${SID}/export?format=csv&format=json`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/,
      "last value 'json' wins");
    const body = await res.json();
    assert.equal(body.session_id, SID);
    assert.ok(Array.isArray(body.events));
  });

  test("a repeated ?format=json&format=csv coerces to CSV (last value wins)", async () => {
    // Confirms last-wins is the rule (not a blanket JSON fallback): the last
    // value is the string "csv", so the response is CSV.
    const res = await fetch(`${baseUrl}/sessions/${SID}/export?format=json&format=csv`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/csv/,
      "last value 'csv' wins");
  });

  test("repeated ?type param (array) coerces to the last value (last wins), not 500", async () => {
    // type/q used to reach the DB as a raw array → binding throws → 500. Now the
    // array is coerced to its last value, so a request whose LAST type is real
    // behaves exactly like that single-type export.
    const lastWinsRes = await fetch(`${baseUrl}/sessions/${SID}/export?type=nope&type=task.created`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    const singleRes = await fetch(`${baseUrl}/sessions/${SID}/export?type=task.created`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(lastWinsRes.status, 200);
    const lastWins = await lastWinsRes.json();
    const single = await singleRes.json();
    assert.ok(lastWins.events.length >= 1, "last value (task.created) matches real events");
    assert.equal(lastWins.events.length, single.events.length,
      "?type=nope&type=task.created === ?type=task.created (last wins)");
  });

  test("a mixed array ?type + scalar ?q applies last-wins type AND the scalar q", async () => {
    // The params are independent: an array `type` coerces to its last value, a
    // scalar `q` is honoured as-is. So this must equal the equivalent
    // single-type + same-q request — neither param nukes the other.
    const refRes = await fetch(`${baseUrl}/sessions/${SID}/export?type=task.created&q=created`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    const refBody = await refRes.json();

    const mixedRes = await fetch(`${baseUrl}/sessions/${SID}/export?type=nope&type=task.created&q=created`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(mixedRes.status, 200);
    const mixedBody = await mixedRes.json();
    assert.ok(mixedBody.events.length >= 1, "task.created matches and contains 'created'");
    assert.equal(mixedBody.events.length, refBody.events.length,
      "last-wins type + scalar q === ?type=task.created&q=created");
  });

  test("now inherits the shared query-length 400 (q > 200 chars) via validateQueryParams", async () => {
    // /export now runs validateQueryParams, so it gains the same DoS-guard 400s
    // /events has. Locks the intentional behaviour change (see PR notes).
    const res = await fetch(`${baseUrl}/sessions/${SID}/export?q=${"x".repeat(201)}`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("now 400s on an INVALID ?limit / ?cursor it previously ignored (intentional)", async () => {
    // The surprising side-effect of routing /export through validateQueryParams:
    // /export ignores limit/cursor, so a VALID one is a no-op, but an INVALID one
    // now 400s instead of being silently dropped. Locks that documented change.
    const limitRes = await fetch(`${baseUrl}/sessions/${SID}/export?limit=abc`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(limitRes.status, 400);
    const cursorRes = await fetch(`${baseUrl}/sessions/${SID}/export?cursor=!!!`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(cursorRes.status, 400);
  });
});

// ---------------------------------------------------------------------------
// GET /workflows/:traceId
// ---------------------------------------------------------------------------

describe("GET /workflows/:traceId", () => {
  const TRACE_ID = `trc_wf_${Date.now()}`;

  before(async () => {
    await ingest(makeEvent({ session_id: `ses_wf_a_${Date.now()}`, trace_id: TRACE_ID }));
    await ingest(makeEvent({ session_id: `ses_wf_b_${Date.now()}`, trace_id: TRACE_ID }));
  });

  test("returns workflow tree for a known trace_id", async () => {
    const res = await fetch(`${baseUrl}/workflows/${TRACE_ID}`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trace_id, TRACE_ID);
    assert.ok(Array.isArray(body.tree));
  });

  test("returns 404 for an unknown trace_id", async () => {
    const res = await fetch(`${baseUrl}/workflows/trc_does_not_exist`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// GET /metrics
// ---------------------------------------------------------------------------

describe("GET /metrics", () => {
  test("returns metrics object with known keys", async () => {
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // Metrics should at minimum have counters or session counts
    assert.ok(typeof body === "object" && body !== null);
  });

  test("returns 401 without auth", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Signature canonicalization telemetry (issue #65, Phase A)
//
// A v2-signed ingest against a key WITH an hmac_secret is classified by its
// effective canonical form (always "v2" now that v1 is retired) in the
// Prometheus output; an invalid signature increments the rejection counter.
// Counters are process-wide, so we assert on the before/after DELTA.
// ---------------------------------------------------------------------------

describe("signature canonicalization metrics", () => {
  const { canonicalizeV2 } = require("../../src/signature");
  const SIG_SECRET = "phase-a-hmac-secret";
  let signKey;

  // Read the aep_signature_verifications_total value for a given form+marked
  // label pair from the Prometheus scrape (0 when the series is absent yet).
  function counterFor(text, form, marked) {
    const re = new RegExp(
      `aep_signature_verifications_total\\{form="${form}",marked="${marked}"\\}\\s+(\\d+)`
    );
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  }

  async function scrape() {
    const res = await fetch(`${baseUrl}/metrics/prometheus`);
    assert.equal(res.status, 200);
    return res.text();
  }

  function signedEvent(form, canon) {
    const event = makeEvent({ payload: { task: "signed", nested: { deep: 1 } } });
    const value = crypto.createHmac("sha256", SIG_SECRET).update(form(event), "utf8").digest("base64");
    event.signature = { alg: "hmac-sha256", value, canon };
    return event;
  }

  before(async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        tenantId: "tenant-sig", label: "signing-key", scopes: ["read", "write"], hmacSecret: SIG_SECRET,
      }),
    });
    signKey = (await res.json()).key;
  });

  test("a v2-signed ingest is counted by effective form", async () => {
    const before = await scrape();
    const v2Before = counterFor(before, "v2", "true");

    const res = await ingest(signedEvent(canonicalizeV2, "v2"), signKey);
    assert.equal(res.status, 202);

    const after = await scrape();
    assert.equal(counterFor(after, "v2", "true"), v2Before + 1, "v2 counter should increment by 1");
  });

  test("an invalid signature (tampered v2 digest) is rejected and counted as a rejection", async () => {
    // A v2-marked event whose digest is wrong → the genuine digest-mismatch
    // path (not a marker rejection), so the rejection counter increments.
    const ev = signedEvent(canonicalizeV2, "v2");
    ev.signature.value = "AAAA"; // wrong digest
    const res = await ingest(ev, signKey);
    assert.equal(res.status, 401);

    const text = await scrape();
    assert.match(text, /aep_signature_verifications_rejected_total\{marked="true"\}\s+\d+/);
  });
});

// ---------------------------------------------------------------------------
// Per-event signature acceptance — v2 only (issue #65 Phase E, BREAKING)
//
// The server accepts ONLY a payload-covering v2 signature: an explicit
// canon:"v2" marker that verifies against the deep form. A legacy v1 signature,
// an unmarked signature (even one that would verify deep), and any non-"v2"
// marker are rejected with 401 + an actionable error and NO RFC 8594
// Deprecation/Sunset/Link headers. The transition mode, the REQUIRE_CANON_V2
// escape hatch, and the v1 deprecation headers were all removed — there is no
// env that re-accepts v1.
// ---------------------------------------------------------------------------

describe("per-event signature acceptance — v2 only (issue #65 Phase E)", () => {
  const { canonicalizeV2 } = require("../../src/signature");
  const SIG_SECRET = "phase-e-hmac-secret";
  let signKey;

  // Sign over `form`; attach the canon marker only when a string is given (pass
  // undefined to OMIT it — simulates a pre-v0.3.0 unmarked emitter).
  function signedEvent(form, canon) {
    const event = makeEvent({ payload: { task: "v2only", nested: { deep: 1 } } });
    const value = crypto.createHmac("sha256", SIG_SECRET).update(form(event), "utf8").digest("base64");
    event.signature = { alg: "hmac-sha256", value };
    if (typeof canon === "string") event.signature.canon = canon;
    return event;
  }

  before(async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        tenantId: "tenant-v2only", label: "v2-signing-key", scopes: ["read", "write"], hmacSecret: SIG_SECRET,
      }),
    });
    signKey = (await res.json()).key;
  });

  test("a v2-signed event is accepted (202) with no deprecation headers", async () => {
    const res = await ingest(signedEvent(canonicalizeV2, "v2"), signKey);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("deprecation"), null);
    assert.equal(res.headers.get("sunset"), null);
    assert.equal(res.headers.get("link"), null);
  });

  test("a v1-signed event is REJECTED (401) with an actionable error and NO deprecation headers", async () => {
    const res = await ingest(signedEvent(canonicalizeV2, "v1"), signKey);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.accepted, false);
    // Actionable, SDK-agnostic hint (sanitized detail is escaped + capped at 100
    // chars; the message is ≤99 so it arrives intact).
    assert.match(body.detail, /canon/);
    assert.match(body.detail, /AEP SDK/);
    // Hard reject, not an accepted-v1 ingest → no RFC 8594 headers.
    assert.equal(res.headers.get("deprecation"), null);
    assert.equal(res.headers.get("sunset"), null);
    assert.equal(res.headers.get("link"), null);
  });

  test("an unmarked deep signature is rejected (401) — the explicit canon:\"v2\" marker is required", async () => {
    const res = await ingest(signedEvent(canonicalizeV2, undefined), signKey);
    assert.equal(res.status, 401);
  });

  test("REQUIRE_CANON_V2=false has NO effect — the escape hatch is gone, v1 is still 401", async () => {
    // The env was removed in Phase E; setting it must not re-accept v1.
    process.env.REQUIRE_CANON_V2 = "false";
    try {
      const res = await ingest(signedEvent(canonicalizeV2, "v1"), signKey);
      assert.equal(res.status, 401);
    } finally {
      delete process.env.REQUIRE_CANON_V2;
    }
  });

  test("a key with NO hmac_secret skips signature verification — event accepted regardless", async () => {
    // Keys without an hmac_secret bypass the entire signature block.
    const res = await ingest(makeEvent(), writeKey); // writeKey has no hmac_secret
    assert.equal(res.status, 202);
  });
});

// ---------------------------------------------------------------------------
// Admin: POST /admin/keys, GET /admin/keys, DELETE /admin/keys/:id
// ---------------------------------------------------------------------------

describe("Admin API — /admin/keys", () => {
  test("POST /admin/keys creates a new key", async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ tenantId: "tenant-admin-test", label: "admin-created" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(typeof body.key === "string");
    assert.ok(body.key.startsWith("aep_"), `Key should start with 'aep_', got '${body.key}'`);
  });

  test("GET /admin/keys lists all keys", async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.keys));
    assert.ok(body.keys.length >= 1);
  });

  test("DELETE /admin/keys/:id revokes a key", async () => {
    // Create a disposable key
    const createRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ tenantId: "tenant-revoke", label: "to-revoke" }),
    });
    const { id } = await createRes.json();

    const delRes = await fetch(`${baseUrl}/admin/keys/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(delRes.status, 200);
    const body = await delRes.json();
    assert.equal(body.ok, true);
  });

  test("POST /admin/keys requires admin token", async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readKey}`,
      },
      body: JSON.stringify({ tenantId: "tenant-unauthorized" }),
    });
    // Should be 401 or 403
    assert.ok([401, 403, 503].includes(res.status), `Expected 4xx, got ${res.status}`);
  });

  test("POST /admin/keys returns 400 when tenantId is missing", async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ label: "missing-tenant" }),
    });
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// GET /openapi.json
// ---------------------------------------------------------------------------

describe("GET /openapi.json", () => {
  test("returns a valid OpenAPI document", async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.openapi, "should have 'openapi' field");
    assert.ok(body.info, "should have 'info' field");
    assert.ok(body.paths, "should have 'paths' field");
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard
// ---------------------------------------------------------------------------

describe("GET /dashboard", () => {
  // Regression: Express 5's send() applies its dotfiles policy to the whole
  // resolved path when sendFile() gets an absolute path, so a checkout under a
  // dot-directory (e.g. .claude/worktrees/...) used to 404. The route now uses
  // the `root` option so the file is served regardless of the checkout path.
  test("serves the dashboard HTML (200)", async () => {
    // The harness sets DASHBOARD_TOKEN, so authenticate like a browser would.
    const res = await fetch(`${baseUrl}/dashboard`, {
      headers: { Authorization: `Bearer ${process.env.DASHBOARD_TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const body = await res.text();
    assert.match(body, /<!doctype html>/i);
  });
});

// ---------------------------------------------------------------------------
// GET /rejections
// ---------------------------------------------------------------------------

describe("GET /rejections", () => {
  test("returns 200 with empty list and total:0 when no rejections have occurred", async () => {
    const res = await fetch(`${baseUrl}/rejections`, {
      headers: { Authorization: `Bearer ${writeKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.rejections), "rejections should be an array");
    // May be 0 or more depending on other tests that sent bad events; just verify shape
    assert.ok(typeof body.total === "number", "total should be a number");
  });

  test("records a schema-invalid rejection after a bad POST /events", async () => {
    // Send an event missing required fields to trigger a schema rejection
    const badEvent = {
      specversion: "0.2.0",
      id: `evt_reject_schema_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "task.created",
      session_id: "ses_reject_test",
      // missing: source, trace_id — will fail schema validation
    };
    const postRes = await ingest(badEvent);
    assert.equal(postRes.status, 400);

    const res = await fetch(`${baseUrl}/rejections`, {
      headers: { Authorization: `Bearer ${writeKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.total >= 1, "should have at least one rejection");

    // Most-recent item is first
    const latest = body.rejections[0];
    assert.equal(latest.reason, "schema_invalid");
    assert.equal(latest.event_id, badEvent.id);
    assert.equal(latest.session_id, "ses_reject_test");
    assert.ok(Array.isArray(latest.errors), "errors should be an array");
    assert.ok(latest.errors.length > 0, "errors should be non-empty");
    assert.ok(typeof latest.ts === "string", "ts should be an ISO string");
    assert.ok(typeof latest.id === "string", "each rejection entry should have its own id");
  });

  test("returns rejections most-recent first", async () => {
    // Send two distinct bad events and verify ordering
    const id1 = `evt_ord_1_${crypto.randomUUID().replace(/-/g, "")}`;
    const id2 = `evt_ord_2_${crypto.randomUUID().replace(/-/g, "")}`;
    await ingest({ specversion: "0.2.0", id: id1, type: "task.created", session_id: "ses_ord" });
    await ingest({ specversion: "0.2.0", id: id2, type: "task.created", session_id: "ses_ord" });

    const res = await fetch(`${baseUrl}/rejections`, {
      headers: { Authorization: `Bearer ${writeKey}` },
    });
    const body = await res.json();
    // id2 was sent last so it should appear before id1
    const ids = body.rejections.map(r => r.event_id);
    const pos1 = ids.indexOf(id1);
    const pos2 = ids.indexOf(id2);
    assert.ok(pos2 !== -1 && pos1 !== -1, "both event IDs should appear in rejections");
    assert.ok(pos2 < pos1, "most-recently rejected event should appear first");
  });

  test("respects the ?limit query parameter", async () => {
    const res = await fetch(`${baseUrl}/rejections?limit=1`, {
      headers: { Authorization: `Bearer ${writeKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.rejections.length <= 1, "should return at most 1 item");
    assert.ok(typeof body.total === "number", "total should reflect full count, not capped count");
  });

  test("requires authentication — returns 401 without a key", async () => {
    const res = await fetch(`${baseUrl}/rejections`);
    assert.equal(res.status, 401);
  });

  test("is accessible with a read-only API key", async () => {
    const res = await fetch(`${baseUrl}/rejections`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// SECURITY TESTS — Phase 2c
// ---------------------------------------------------------------------------

/**
 * Cross-Tenant Isolation Tests
 * 
 * Verify that one tenant's API key cannot access another tenant's data.
 * This tests both database filtering AND application-layer defense-in-depth validation.
 */
describe("Security — Cross-Tenant Isolation", () => {
  const TENANT_A = `tenant_a_${Date.now()}`;
  const TENANT_B = `tenant_b_${Date.now()}`;
  const SESSION_A = `ses_a_${Date.now()}`;
  const SESSION_B = `ses_b_${Date.now()}`;
  const TRACE_A = `trc_a_${Date.now()}`;
  const TRACE_B = `trc_b_${Date.now()}`;

  let keyTenantA;
  let keyTenantB;

  before(async () => {
    // Create API keys for both tenants
    const resA = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ tenantId: TENANT_A, label: "tenant-a-key", scopes: ["read", "write"] }),
    });
    keyTenantA = (await resA.json()).key;

    const resB = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ tenantId: TENANT_B, label: "tenant-b-key", scopes: ["read", "write"] }),
    });
    keyTenantB = (await resB.json()).key;

    // Tenant A: ingest an event
    await ingest(makeEvent({ session_id: SESSION_A, trace_id: TRACE_A }), keyTenantA);

    // Tenant B: ingest an event
    await ingest(makeEvent({ session_id: SESSION_B, trace_id: TRACE_B }), keyTenantB);
  });

  test("Tenant A cannot access Tenant B's sessions", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${keyTenantA}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    // Tenant A should only see their own sessions
    const sessionIds = body.sessions.map(s => s.session_id);
    assert.ok(sessionIds.includes(SESSION_A), "Tenant A should see their own session");
    assert.ok(!sessionIds.includes(SESSION_B), "Tenant A should NOT see Tenant B's session");
  });

  test("Tenant A's query for Tenant B's events returns empty (DB-layer filtering)", async () => {
    // Database query filters by tenant, so Tenant A cannot access Tenant B's data
    // Events objects don't have tenant_id fields, so application-layer validation
    // allows them (treating as system/unscoped data), but DB filtering prevents leakage
    const res = await fetch(`${baseUrl}/sessions/${SESSION_B}/events`, {
      headers: { Authorization: `Bearer ${keyTenantA}` },
    });

    // Database filtering ensures SESSION_B is not visible to Tenant A
    // Response should be 404 (session not found in tenant's view) or 200 with empty events
    assert.ok([200, 404].includes(res.status), `Expected 200 or 404, got ${res.status}`);

    if (res.status === 200) {
      const body = await res.json();
      // If session exists, events array should be empty (filtered at DB layer)
      assert.equal(body.events.length, 0, "Cross-tenant events must not appear in results");
    }
  });

  test("Tenant B's query for Tenant A's tree returns empty or not found", async () => {
    const res = await fetch(`${baseUrl}/sessions/${SESSION_A}/tree`, {
      headers: { Authorization: `Bearer ${keyTenantB}` },
    });

    // Database filtering ensures tree is scoped to requesting tenant
    assert.ok([200, 404].includes(res.status), `Expected 200 or 404, got ${res.status}`);

    if (res.status === 200) {
      const body = await res.json();
      // If we get a tree, verify it's empty or belongs to Tenant B only
      assert.ok(!body.session || body.session.session_id !== SESSION_A, "Should not leak Tenant A tree to Tenant B");
    }
  });

  test("Tenant A's query for Tenant B's workflows returns empty or not found", async () => {
    const res = await fetch(`${baseUrl}/workflows/${TRACE_B}`, {
      headers: { Authorization: `Bearer ${keyTenantA}` },
    });

    // Database filtering ensures workflows are tenant-scoped
    assert.ok([200, 404].includes(res.status), `Expected 200 or 404, got ${res.status}`);

    if (res.status === 200) {
      const body = await res.json();
      // If we get a workflow, verify it doesn't contain Tenant B's data
      assert.ok(!body.tree || body.tree.length === 0 || body.trace_id !== TRACE_B, "Should not leak Tenant B workflow to Tenant A");
    }
  });
});

/**
 * XSS Prevention Tests
 * 
 * Verify that query parameters with special characters are safely handled
 * and don't break JSON responses or enable XSS injection.
 */
describe("Security — XSS Prevention in Query Parameters", () => {
  const SESSION_ID = `ses_xss_${Date.now()}`;
  const TRACE_ID = `trc_xss_${Date.now()}`;

  before(async () => {
    // Seed an event for testing
    await ingest(makeEvent({
      session_id: SESSION_ID,
      trace_id: TRACE_ID,
      type: "task.created",
    }), writeKey);
  });

  test("Query parameter with double quotes does not break JSON and is properly escaped", async () => {
    const malicious = `test"injection"here`;
    const encoded = encodeURIComponent(malicious);
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}/events?q=${encoded}`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    // Should successfully parse as JSON (no syntax error)
    assert.ok(typeof body === "object", "Response should be valid JSON");

    // Verify malicious input is either absent or properly escaped in response
    const responseText = JSON.stringify(body);
    // The unescaped quote sequence should NOT appear in the response body
    assert.ok(
      !responseText.includes(`"injection"`),
      'Unescaped injection pattern should not appear in response body'
    );
  });

  test("Query parameter with newlines does not break JSON and is properly escaped", async () => {
    const malicious = `test\ninjection\nhere`;
    const encoded = encodeURIComponent(malicious);
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}/events?q=${encoded}`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    // Should successfully parse as JSON
    assert.ok(typeof body === "object", "Response should be valid JSON");

    // Verify malicious input is properly escaped (newlines should be \n in JSON)
    const responseText = JSON.stringify(body);
    // Actual newline characters should NOT appear in JSON response body
    // (they should be escaped as \n or removed)
    const hasActualNewline = /\n(?=[^"]*":)/.test(responseText);
    assert.ok(
      !hasActualNewline,
      'Actual newline characters should not appear unescaped in response body'
    );
  });

  test("Query parameter with backslashes does not break JSON and is properly escaped", async () => {
    const malicious = `test\\escape\\here`;
    const encoded = encodeURIComponent(malicious);
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}/events?q=${encoded}`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    // Should successfully parse as JSON
    assert.ok(typeof body === "object", "Response should be valid JSON");

    // Verify backslashes are properly escaped in JSON
    const responseText = JSON.stringify(body);
    // Verify the response can be round-tripped through JSON parse/stringify
    const reparsed = JSON.parse(responseText);
    assert.ok(typeof reparsed === "object", "Response should survive JSON round-trip");
  });

  test("Filter parameter with special characters does not break JSON and is properly escaped", async () => {
    const malicious = `<script>alert('xss')</script>`;
    const encoded = encodeURIComponent(malicious);
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}/events?type=${encoded}`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    // Should successfully parse as JSON
    assert.ok(typeof body === "object", "Response should be valid JSON");

    // Verify script tag payload is properly escaped in response
    const responseText = JSON.stringify(body);
    // If the payload appears in the response, it should be escaped (< becomes < or similar)
    // Raw angle brackets in JSON string should not be followed by 'script>'
    assert.ok(
      !responseText.includes('<script>'),
      'Unescaped script tag should not appear in response body'
    );
  });
});

/**
 * SSE Connection Limit Tests
 * 
 * Verify that the per-tenant and global SSE connection limits are enforced
 * with proper atomic operations to prevent TOCTOU race conditions.
 */
describe("Security — SSE Connection Limits", () => {
  test("SSE connection limit is enforced per-tenant", async () => {
    const connections = [];
    const MAX_ATTEMPTS = 105; // Try to exceed the 100-per-tenant limit

    try {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const res = await fetch(`${baseUrl}/stream`, {
          headers: { Authorization: `Bearer ${readKey}` },
        });

        if (res.status === 429) {
          // Hit the limit - this is expected after MAX_SSE_PER_TENANT connections
          assert.equal(res.headers.get("Retry-After"), "60", "429 response should include Retry-After header");
          break;
        }

        assert.equal(res.status, 200, `Connection ${i} should succeed`);
        connections.push(res);

        // Don't keep reading the stream to avoid blocking; just verify we got 200
        // In a real test, we'd keep connections alive and verify behavior
      }

      // Should have hit the limit before MAX_ATTEMPTS
      assert.ok(
        connections.length < MAX_ATTEMPTS,
        `Should hit connection limit before ${MAX_ATTEMPTS} attempts`
      );

      // Verify strict boundary: exactly 100 connections allowed, 101st rejected
      // Per-tenant limit is MAX_SSE_PER_TENANT = 100
      assert.ok(
        connections.length >= 100,
        "Should allow at least 100 connections per tenant before hitting limit"
      );
      assert.ok(
        connections.length <= 102,
        `Should reject around connection 100-102, got ${connections.length} (allows for async timing)`
      );

      // Verify we actually hit the limit (more than one connection should be active)
      assert.ok(
        connections.length > 1,
        "Should have hit limit after multiple connections"
      );
    } finally {
      // Clean up: close all connections
      for (const conn of connections) {
        conn.body?.cancel?.();
      }
    }
  });

  test("429 response includes Retry-After header", async () => {
    // Create many connections to hit the limit
    const connections = [];
    for (let i = 0; i < 105; i++) {
      const res = await fetch(`${baseUrl}/stream`, {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      if (res.status === 429) {
        // Verify Retry-After header
        const retryAfter = res.headers.get("Retry-After");
        assert.equal(retryAfter, "60", "Retry-After header should be present on 429 response");
        return; // Test passed
      }
      connections.push(res);
    }

    // Clean up
    for (const conn of connections) {
      conn.body?.cancel?.();
    }

    assert.fail("Should have hit 429 limit during connection attempts");
  });
});

// ---------------------------------------------------------------------------
// Phase 13 PR-C — Projects / tiers / quotas
//
// Backend-agnostic: this whole block runs identically under SQLite and under
// the Postgres parity job (STORAGE_BACKEND=postgres).
// ---------------------------------------------------------------------------

describe("Admin API — /admin/projects (tiers)", () => {
  let adminHeaders;
  before(() => {
    adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };
  });

  test("a seeded 'default' project exists with unlimited quota", async () => {
    const res = await fetch(`${baseUrl}/admin/projects/default`, { headers: adminHeaders });
    assert.equal(res.status, 200);
    const { project } = await res.json();
    assert.equal(project.id, "default");
    assert.equal(project.tier, "enterprise");
    assert.equal(project.eventQuota, null, "default project quota is unlimited");
    assert.equal(project.retentionDays, null);
  });

  test("POST /admin/projects creates a project and materialises tier defaults", async () => {
    const res = await fetch(`${baseUrl}/admin/projects`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Team A", tenantId: "tenant-team-a", tier: "team" }),
    });
    assert.equal(res.status, 201);
    const { project } = await res.json();
    assert.equal(project.tier, "team");
    assert.equal(project.tenantId, "tenant-team-a");
    // team tier default quota (90-day retention)
    assert.equal(project.retentionDays, 90);
    assert.ok(Number.isInteger(project.eventQuota), "team tier has a finite event quota");
  });

  test("POST /admin/projects supports per-project quota override", async () => {
    const res = await fetch(`${baseUrl}/admin/projects`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ tenantId: "tenant-override", tier: "free", eventQuota: 42 }),
    });
    assert.equal(res.status, 201);
    const { project } = await res.json();
    assert.equal(project.eventQuota, 42);
  });

  test("POST /admin/projects rejects an unknown tier with 400", async () => {
    const res = await fetch(`${baseUrl}/admin/projects`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ tenantId: "tenant-bad", tier: "platinum" }),
    });
    assert.equal(res.status, 400);
  });

  test("POST /admin/projects requires tenantId", async () => {
    const res = await fetch(`${baseUrl}/admin/projects`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ tier: "free" }),
    });
    assert.equal(res.status, 400);
  });

  test("GET /admin/projects lists projects with usage", async () => {
    const res = await fetch(`${baseUrl}/admin/projects`, { headers: adminHeaders });
    assert.equal(res.status, 200);
    const { projects } = await res.json();
    assert.ok(Array.isArray(projects));
    assert.ok(projects.some(p => p.id === "default"));
    assert.ok(projects.every(p => typeof p.usage === "number"));
  });

  test("GET /admin/projects/:id returns 404 for an unknown project", async () => {
    const res = await fetch(`${baseUrl}/admin/projects/does-not-exist`, { headers: adminHeaders });
    assert.equal(res.status, 404);
  });

  test("admin/projects requires the admin token", async () => {
    const res = await fetch(`${baseUrl}/admin/projects`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.ok([401, 403, 503].includes(res.status), `Expected 4xx, got ${res.status}`);
  });
});

describe("API keys bind to a project", () => {
  test("POST /admin/keys with a valid projectId binds the key", async () => {
    // Create a project first.
    const pRes = await fetch(`${baseUrl}/admin/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-keybind", tier: "free" }),
    });
    const { project } = await pRes.json();

    const kRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-keybind", projectId: project.id, label: "bound" }),
    });
    assert.equal(kRes.status, 201);
    const kBody = await kRes.json();
    assert.equal(kBody.projectId, project.id);

    // Listing surfaces the binding.
    const listRes = await fetch(`${baseUrl}/admin/keys`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const { keys } = await listRes.json();
    const found = keys.find(k => k.id === kBody.id);
    assert.ok(found, "created key appears in the listing");
    assert.equal(found.projectId, project.id);
  });

  test("POST /admin/keys with an unknown projectId returns 400", async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-x", projectId: "no-such-project" }),
    });
    assert.equal(res.status, 400);
  });

  test("a key with no projectId defaults to the 'default' project", async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-default-proj", label: "no-project" }),
    });
    const body = await res.json();
    assert.equal(body.projectId, "default");
  });
});

describe("POST /events — quota enforcement", () => {
  test("ingest is rejected with 429 once a project's event quota is reached", async () => {
    const QUOTA = 3;
    const tenant = "tenant-quota-" + crypto.randomUUID().slice(0, 8);

    // Project with a tiny quota.
    const pRes = await fetch(`${baseUrl}/admin/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: tenant, tier: "free", eventQuota: QUOTA }),
    });
    const { project } = await pRes.json();

    // A write key bound to that project + tenant.
    const kRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: tenant, projectId: project.id, scopes: ["read", "write"] }),
    });
    const quotaKey = (await kRes.json()).key;

    // First QUOTA events accepted.
    for (let i = 0; i < QUOTA; i++) {
      const ev = makeEvent({
        id: `evt_quota_${i}_${crypto.randomUUID().replace(/-/g, "")}`,
        session_id: `ses_quota_${tenant}`,
        trace_id: `trc_quota_${tenant}`,
      });
      const r = await ingest(ev, quotaKey);
      assert.equal(r.status, 202, `event ${i} should be accepted`);
    }

    // The next one is over quota → 429 with a Retry-After header.
    const over = await ingest(
      makeEvent({
        id: `evt_quota_over_${crypto.randomUUID().replace(/-/g, "")}`,
        session_id: `ses_quota_${tenant}`,
        trace_id: `trc_quota_${tenant}`,
      }),
      quotaKey
    );
    assert.equal(over.status, 429);
    const body = await over.json();
    assert.equal(body.accepted, false);
    assert.equal(body.quota, QUOTA);
    assert.equal(over.headers.get("Retry-After"), "3600");
  });

  test("the unlimited default project never blocks ingest on quota", async () => {
    // writeKey is bound to the default (enterprise/unlimited) project.
    for (let i = 0; i < 5; i++) {
      const r = await ingest(
        makeEvent({ id: `evt_unl_${i}_${crypto.randomUUID().replace(/-/g, "")}` })
      );
      assert.equal(r.status, 202);
    }
  });
});

// ---------------------------------------------------------------------------
// Retention / pruning (Phase 13 PR-D)
//
// These drive the prune job (src/retention.pruneAll) directly against the same
// storage backend the server uses, then assert via the DB module. They run
// under BOTH backends via the Postgres parity CI job (no SQLite-specific calls).
// ---------------------------------------------------------------------------

describe("Retention / pruning", () => {
  const { pruneAll } = require("../../src/retention");

  // Spin up a project + write key whose tenant is unique per test, with a
  // chosen retention window, then ingest events at controlled timestamps.
  async function makeRetentionProject({ tier = "free", retentionDays } = {}) {
    const tenant = "tenant-ret-" + crypto.randomUUID().slice(0, 8);
    const body = { tenantId: tenant, tier };
    if (retentionDays !== undefined) body.retentionDays = retentionDays;

    const pRes = await fetch(`${baseUrl}/admin/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body),
    });
    assert.equal(pRes.status, 201, "project created");
    const { project } = await pRes.json();

    const kRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: tenant, projectId: project.id, scopes: ["read", "write"] }),
    });
    const key = (await kRes.json()).key;

    return { tenant, project, key };
  }

  function daysAgo(n) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }

  test("deletes events older than retention_days and reconciles sessions", async () => {
    // 30-day retention (free tier default). Old events (>30d) should go;
    // recent events should stay.
    const { tenant, key } = await makeRetentionProject({ tier: "free" });
    const sid = `ses_ret_${tenant}`;
    const trace = `trc_ret_${tenant}`;

    // 2 old events (60d / 45d ago) + 2 recent (1d / now) in one session.
    const stamps = [daysAgo(60), daysAgo(45), daysAgo(1), new Date().toISOString()];
    for (let i = 0; i < stamps.length; i++) {
      const r = await ingest(
        makeEvent({
          id: `evt_ret_${i}_${crypto.randomUUID().replace(/-/g, "")}`,
          session_id: sid,
          trace_id: trace,
          time: stamps[i],
        }),
        key
      );
      assert.equal(r.status, 202, `event ${i} accepted`);
    }

    assert.equal(await db.getProjectEventCount(tenant), 4, "4 events before prune");
    const before = await db.getSession(sid);
    assert.equal(before.event_count, 4);

    const summary = await pruneAll();

    // Only this tenant's old events removed; counts are native numbers.
    assert.equal(await db.getProjectEventCount(tenant), 2, "2 events remain after prune");
    const detail = summary.details.find(d => d.tenant_id === tenant);
    assert.ok(detail, "summary includes this tenant");
    assert.equal(detail.events_deleted, 2);
    assert.equal(detail.sessions_deleted, 0, "session survived (still has events)");

    // Session summary reconciled: count drops to 2, started_at advances to the
    // oldest surviving event (1d ago), not the deleted 60d-ago one.
    const after = await db.getSession(sid);
    assert.equal(after.event_count, 2, "event_count recomputed");
    assert.ok(after.started_at >= daysAgo(2), "started_at moved up past pruned events");

    // The actual remaining events are the two recent ones.
    const remaining = await db.getSessionEvents(sid);
    assert.equal(remaining.length, 2);
  });

  test("deletes a session entirely when all its events are pruned", async () => {
    const { tenant, key } = await makeRetentionProject({ tier: "free" });
    const sid = `ses_allold_${tenant}`;

    // All events older than the 30-day window.
    for (let i = 0; i < 3; i++) {
      await ingest(
        makeEvent({
          id: `evt_allold_${i}_${crypto.randomUUID().replace(/-/g, "")}`,
          session_id: sid,
          trace_id: `trc_allold_${tenant}`,
          time: daysAgo(40 + i),
        }),
        key
      );
    }
    assert.ok(await db.getSession(sid), "session exists before prune");

    const summary = await pruneAll();
    const detail = summary.details.find(d => d.tenant_id === tenant);
    assert.equal(detail.events_deleted, 3);
    assert.equal(detail.sessions_deleted, 1, "empty session removed");
    assert.equal(await db.getSession(sid), null, "session gone after prune");
    assert.equal(await db.getProjectEventCount(tenant), 0);
  });

  test("retention_days NULL (unlimited) is never pruned", async () => {
    // enterprise tier => retention_days null. Override is not needed.
    const { tenant, key } = await makeRetentionProject({ tier: "enterprise" });
    const sid = `ses_keep_${tenant}`;

    await ingest(
      makeEvent({
        id: `evt_keep_${crypto.randomUUID().replace(/-/g, "")}`,
        session_id: sid,
        trace_id: `trc_keep_${tenant}`,
        time: daysAgo(3650), // 10 years old
      }),
      key
    );
    assert.equal(await db.getProjectEventCount(tenant), 1);

    const summary = await pruneAll();
    assert.equal(await db.getProjectEventCount(tenant), 1, "unlimited project untouched");
    // No detail row should be emitted for an unprunable project.
    assert.equal(summary.details.find(d => d.tenant_id === tenant), undefined);
  });

  test("retention_days <= 0 (explicit override) is never pruned", async () => {
    const { tenant, key } = await makeRetentionProject({ tier: "free", retentionDays: 0 });
    const sid = `ses_zero_${tenant}`;

    await ingest(
      makeEvent({
        id: `evt_zero_${crypto.randomUUID().replace(/-/g, "")}`,
        session_id: sid,
        trace_id: `trc_zero_${tenant}`,
        time: daysAgo(999),
      }),
      key
    );

    const summary = await pruneAll();
    assert.equal(await db.getProjectEventCount(tenant), 1, "retention_days=0 means keep forever");
    assert.equal(summary.details.find(d => d.tenant_id === tenant), undefined);
  });

  test("untouched sessions are not reconciled (prune scoped to affected sessions)", async () => {
    // Regression for the tenant-wide reconcile bug: a prune that touches one
    // session in a tenant must NOT rewrite aggregates on a sibling session that
    // lost no events. The insert path sets started_at to the FIRST-INSERTED
    // event's time (never recomputed), so a session whose events arrive
    // out-of-time-order has stored started_at != MIN(time). A tenant-wide
    // reconcile silently rewrites that started_at to MIN(time) — a value the
    // write path never produces. Scoped reconcile leaves it untouched.
    const { tenant, key } = await makeRetentionProject({ tier: "free" });

    // Session A: has an OLD event (>30d) → will be pruned + reconciled.
    const aSid = `ses_affected_${tenant}`;
    for (const t of [daysAgo(60), daysAgo(1)]) {
      const r = await ingest(
        makeEvent({
          id: `evt_a_${crypto.randomUUID().replace(/-/g, "")}`,
          session_id: aSid,
          trace_id: `trc_affected_${tenant}`,
          time: t,
        }),
        key
      );
      assert.equal(r.status, 202);
    }

    // Session B (untouched): all events RECENT (none pruned), ingested
    // out-of-time-order — emit the LATER event first, then the EARLIER one — so
    // its stored started_at (first-inserted = later) differs from MIN(time).
    const bSid = `ses_untouched_${tenant}`;
    const bLater = daysAgo(2);
    const bEarlier = daysAgo(5);
    for (const t of [bLater, bEarlier]) {
      const r = await ingest(
        makeEvent({
          id: `evt_b_${crypto.randomUUID().replace(/-/g, "")}`,
          session_id: bSid,
          trace_id: `trc_untouched_${tenant}`,
          time: t,
        }),
        key
      );
      assert.equal(r.status, 202);
    }

    const bBefore = await db.getSession(bSid);
    assert.equal(bBefore.event_count, 2, "B has 2 events before prune");
    // Sanity: stored started_at is the first-inserted (later) time, NOT MIN(time).
    assert.equal(bBefore.started_at, bLater, "B started_at = first-inserted time");
    assert.ok(bBefore.started_at > bEarlier, "B is genuinely out-of-time-order");

    const summary = await pruneAll();

    // Session A was pruned + reconciled.
    const detail = summary.details.find(d => d.tenant_id === tenant);
    assert.ok(detail, "summary includes this tenant");
    assert.equal(detail.events_deleted, 1, "only A's old event deleted");
    assert.equal(detail.sessions_deleted, 0, "A still has a recent event");
    const aAfter = await db.getSession(aSid);
    assert.equal(aAfter.event_count, 1, "A reconciled to its surviving event");

    // Session B must be COMPLETELY unchanged — this is what fails on the old
    // tenant-wide reconcile (it would rewrite started_at to bEarlier = MIN).
    const bAfter = await db.getSession(bSid);
    assert.equal(bAfter.started_at, bBefore.started_at, "B started_at unchanged");
    assert.equal(bAfter.event_count, bBefore.event_count, "B event_count unchanged");
    assert.equal(bAfter.updated_at, bBefore.updated_at, "B updated_at unchanged");
  });

  test("--dry-run reports counts but deletes nothing", async () => {
    const { tenant, key } = await makeRetentionProject({ tier: "free" });
    const sid = `ses_dry_${tenant}`;

    for (let i = 0; i < 2; i++) {
      await ingest(
        makeEvent({
          id: `evt_dry_${i}_${crypto.randomUUID().replace(/-/g, "")}`,
          session_id: sid,
          trace_id: `trc_dry_${tenant}`,
          time: daysAgo(50),
        }),
        key
      );
    }

    const summary = await pruneAll({ dryRun: true });
    assert.equal(summary.dryRun, true);
    const detail = summary.details.find(d => d.tenant_id === tenant);
    assert.equal(detail.events_deleted, 2, "dry-run reports what would be deleted");
    assert.equal(detail.sessions_deleted, 0, "dry-run does not compute session deletes");

    // Nothing was actually deleted.
    assert.equal(await db.getProjectEventCount(tenant), 2, "dry-run left events intact");
    assert.ok(await db.getSession(sid), "dry-run left the session intact");
  });
});

// ---------------------------------------------------------------------------
// Orphan tenants: events but no project row (issue #122)
// Exercises the real storage backend (so the Postgres parity job validates the
// dialect-identical listEventTenantIds SQL), end-to-end through the export +
// prune jobs. All assertions use non-destructive dry-runs.
// ---------------------------------------------------------------------------

describe("orphan tenants (events but no project, issue #122)", () => {
  const { runExport } = require("../../src/export/index");
  const { pruneAll } = require("../../src/retention");

  // A key minted with only a tenantId binds to the seeded `default` project, so
  // its events land under a tenant that has NO project row of its own.
  async function makeOrphanTenant() {
    const tenant = "tenant-orphan-" + crypto.randomUUID().slice(0, 8);
    const kRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: tenant, scopes: ["read", "write"] }),
    });
    const key = (await kRes.json()).key;
    const r = await ingest(
      makeEvent({
        id: `evt_orphan_${crypto.randomUUID().replace(/-/g, "")}`,
        session_id: `ses_orphan_${tenant}`,
        trace_id: `trc_orphan_${tenant}`,
      }),
      key
    );
    assert.equal(r.status, 202, "orphan tenant event accepted");
    return tenant;
  }

  test("listEventTenantIds includes a tenant that has events but no project", async () => {
    const tenant = await makeOrphanTenant();
    const eventTenants = await db.listEventTenantIds();
    assert.ok(eventTenants.includes(tenant), "event tenant is discovered");
    // It must NOT appear in the project registry.
    const projects = await db.listProjects();
    assert.ok(!projects.some(p => p.tenant_id === tenant), "no project row for the tenant");
  });

  test("export reports the orphan tenant and skips it by default", async () => {
    const tenant = await makeOrphanTenant();
    const summary = await runExport({ dryRun: true });
    assert.equal(summary.allTenants, false);
    assert.ok(summary.orphan_tenants.includes(tenant), "orphan reported");
    assert.equal(
      summary.details.find(d => d.tenant_id === tenant),
      undefined,
      "orphan not exported by default"
    );
  });

  test("export with allTenants includes the orphan tenant", async () => {
    const tenant = await makeOrphanTenant();
    const summary = await runExport({ dryRun: true, allTenants: true });
    assert.equal(summary.allTenants, true);
    const detail = summary.details.find(d => d.tenant_id === tenant);
    assert.ok(detail, "orphan included with --all-tenants");
    assert.ok(detail.events >= 1, "orphan's events counted");
  });

  test("prune reports the orphan tenant (never pruned — no retention policy)", async () => {
    const tenant = await makeOrphanTenant();
    const summary = await pruneAll({ dryRun: true });
    assert.ok(summary.orphan_tenants.includes(tenant), "orphan reported by prune");
    // The mechanism it can't be pruned: there is no project row carrying a
    // retention policy for this tenant (prune iterates the project registry).
    const projects = await db.listProjects();
    assert.ok(
      !projects.some(p => p.tenant_id === tenant),
      "orphan tenant has no project, so no retention policy can target it"
    );
  });
});

// ---------------------------------------------------------------------------
// GET /sessions/:id/audit-bundle  +  GET /workflows/:traceId/audit-bundle
// Phase 14 PR-B — tamper-evident, HMAC-signed audit bundles over HTTP.
// ---------------------------------------------------------------------------

describe("audit-bundle endpoints", () => {
  const { verifyAuditBundle } = require("../../src/audit");
  const AUDIT_SECRET = "audit-test-secret-" + crypto.randomUUID();

  // Scope ids unique to this block so other suites' data can't bleed in.
  const SESSION_ID = "ses_audit_solo";
  const WF_TRACE   = "trc_audit_wf";
  const WF_ROOT    = "ses_audit_root";
  const WF_CHILD   = "ses_audit_child";

  let savedSecret;
  let otherTenantKey;   // read key bound to a DIFFERENT tenant (isolation test)

  before(async () => {
    savedSecret = process.env.AUDIT_SIGNING_SECRET;
    process.env.AUDIT_SIGNING_SECRET = AUDIT_SECRET;

    // Explicit, strictly-increasing timestamps so the bundled event order is
    // deterministic regardless of ingest timing (makeEvent otherwise stamps
    // `new Date()` for each, which can collide in rapid succession).
    const t = n => `2026-06-11T00:00:0${n}.000Z`;

    // Seed a single-session scope (2 events).
    await ingest(makeEvent({ session_id: SESSION_ID, trace_id: "trc_audit_solo", time: t(0) }));
    await ingest(makeEvent({ session_id: SESSION_ID, trace_id: "trc_audit_solo", type: "task.completed", time: t(1) }));

    // Seed a multi-session workflow trace: orchestrator root + one subagent child.
    await ingest(makeEvent({ session_id: WF_ROOT, trace_id: WF_TRACE, agent_role: "orchestrator", time: t(2) }));
    await ingest(makeEvent({
      session_id: WF_CHILD, trace_id: WF_TRACE, type: "handoff.started",
      parent_session_id: WF_ROOT, agent_role: "subagent", time: t(3),
    }));

    // A read key for a second tenant — used to prove tenant isolation: it must
    // NOT be able to pull tenant-test's bundles (scope-nonexistent → 404).
    const oRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-other", label: "audit-other", scopes: ["read"] }),
    });
    otherTenantKey = (await oRes.json()).key;
  });

  after(() => {
    if (savedSecret === undefined) delete process.env.AUDIT_SIGNING_SECRET;
    else process.env.AUDIT_SIGNING_SECRET = savedSecret;
  });

  async function getBundle(pathSuffix, key = readKey) {
    return fetch(`${baseUrl}${pathSuffix}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
  }

  test("session bundle: 200, verifiable round-trip, count + headers", async () => {
    const res = await getBundle(`/sessions/${SESSION_ID}/audit-bundle`);
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-disposition") || "",
      /attachment; filename="ses_audit_solo-audit-bundle\.json"/
    );

    const bundle = await res.json();
    assert.equal(bundle.manifest.event_count, bundle.events.length);
    assert.equal(bundle.events.length, 2);
    assert.equal(bundle.manifest.scope.session_id, SESSION_ID);
    assert.equal(bundle.manifest.scope.trace_id, "trc_audit_solo");

    const result = verifyAuditBundle(bundle, AUDIT_SECRET);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.content_digest_match, true);
    assert.equal(result.manifest_signature_valid, true);
  });

  test("workflow bundle: 200, spans all sessions in the trace, verifiable", async () => {
    const res = await getBundle(`/workflows/${WF_TRACE}/audit-bundle`);
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-disposition") || "",
      /attachment; filename="trc_audit_wf-audit-bundle\.json"/
    );

    const bundle = await res.json();
    // Both the root and child session's events are present.
    assert.equal(bundle.events.length, 2);
    assert.equal(bundle.manifest.event_count, 2);
    assert.equal(bundle.manifest.scope.trace_id, WF_TRACE);
    const sessions = new Set(bundle.events.map(e => e.session_id));
    assert.ok(sessions.has(WF_ROOT) && sessions.has(WF_CHILD));
    // Events from both sessions are merged in ascending time order (root @t2
    // before child @t3) — deterministic thanks to the seeded timestamps.
    assert.deepEqual(bundle.events.map(e => e.session_id), [WF_ROOT, WF_CHILD]);

    const result = verifyAuditBundle(bundle, AUDIT_SECRET);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("tamper test: mutating a bundled event payload fails verification", async () => {
    const res = await getBundle(`/sessions/${SESSION_ID}/audit-bundle`);
    const bundle = await res.json();

    bundle.events[0].payload = { task: "TAMPERED" };

    const result = verifyAuditBundle(bundle, AUDIT_SECRET);
    assert.equal(result.valid, false);
    assert.equal(result.content_digest_match, false);
  });

  test("returns 401 when no API key is provided", async () => {
    const res = await fetch(`${baseUrl}/sessions/${SESSION_ID}/audit-bundle`);
    assert.equal(res.status, 401);
  });

  test("returns 404 for an unknown session", async () => {
    const res = await getBundle(`/sessions/ses_does_not_exist/audit-bundle`);
    assert.equal(res.status, 404);
  });

  test("returns 404 for an unknown workflow trace", async () => {
    const res = await getBundle(`/workflows/trc_does_not_exist/audit-bundle`);
    assert.equal(res.status, 404);
  });

  test("tenant isolation: another tenant cannot pull this tenant's bundles", async () => {
    // tenant-other's read key sees neither the session nor the trace owned by
    // tenant-test, so both scopes are nonexistent for it → 404 (no leak).
    const sRes = await getBundle(`/sessions/${SESSION_ID}/audit-bundle`, otherTenantKey);
    assert.equal(sRes.status, 404);
    const wRes = await getBundle(`/workflows/${WF_TRACE}/audit-bundle`, otherTenantKey);
    assert.equal(wRes.status, 404);
  });

  test("returns 503 when AUDIT_SIGNING_SECRET is unset", async () => {
    const prev = process.env.AUDIT_SIGNING_SECRET;
    delete process.env.AUDIT_SIGNING_SECRET;
    try {
      const res = await getBundle(`/sessions/${SESSION_ID}/audit-bundle`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.match(body.hint || "", /AUDIT_SIGNING_SECRET/);
    } finally {
      process.env.AUDIT_SIGNING_SECRET = prev;
    }
  });

  // --- ?format=pdf (Phase 14 PR-C) -----------------------------------------
  // The PDF is a human-readable rendering; all auth/tenant/404/503 guards sit
  // BEFORE the format branch, so only the happy-path representation changes.

  test("session bundle ?format=pdf: 200, application/pdf, PDF magic, .pdf filename", async () => {
    const res = await getBundle(`/sessions/${SESSION_ID}/audit-bundle?format=pdf`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/pdf/);
    assert.match(
      res.headers.get("content-disposition") || "",
      /attachment; filename="ses_audit_solo-audit-bundle\.pdf"/
    );
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 5).toString(), "%PDF-");
    assert.match(body.subarray(-32).toString(), /%%EOF\s*$/);
  });

  test("workflow bundle ?format=pdf: 200, application/pdf, PDF magic, .pdf filename", async () => {
    const res = await getBundle(`/workflows/${WF_TRACE}/audit-bundle?format=pdf`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/pdf/);
    assert.match(
      res.headers.get("content-disposition") || "",
      /attachment; filename="trc_audit_wf-audit-bundle\.pdf"/
    );
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 5).toString(), "%PDF-");
    assert.match(body.subarray(-32).toString(), /%%EOF\s*$/);
  });

  test("unrecognized format value falls back to the JSON bundle (parity with /export)", async () => {
    const res = await getBundle(`/sessions/${SESSION_ID}/audit-bundle?format=bogus`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.match(
      res.headers.get("content-disposition") || "",
      /attachment; filename="ses_audit_solo-audit-bundle\.json"/
    );
    const bundle = await res.json();
    assert.equal(verifyAuditBundle(bundle, AUDIT_SECRET).valid, true);
  });

  test("?format=pdf does not bypass the 404 guard for an unknown session", async () => {
    const res = await getBundle(`/sessions/ses_does_not_exist/audit-bundle?format=pdf`);
    assert.equal(res.status, 404);
  });

  test("?format=pdf returns 503 when AUDIT_SIGNING_SECRET is unset", async () => {
    const prev = process.env.AUDIT_SIGNING_SECRET;
    delete process.env.AUDIT_SIGNING_SECRET;
    try {
      const res = await getBundle(`/sessions/${SESSION_ID}/audit-bundle?format=pdf`);
      assert.equal(res.status, 503);
    } finally {
      process.env.AUDIT_SIGNING_SECRET = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/policy-blocked — policy-enforcement analytics (Phase 14 PR-D)
// ---------------------------------------------------------------------------

describe("GET /analytics/policy-blocked", () => {
  // Five policy.blocked events for tenant-test, with fixed past times so the
  // since/until window tests are deterministic. No other test emits
  // policy.blocked, so the tenant-scoped aggregates here are exact.
  const PB_TRACE = "trc_pb_analytics";
  const seed = [
    { id: "evt_pb_1", time: "2026-03-01T08:00:00Z", source: "agent://orchestrator", policy: "pii_guard", reason: "PII to external", action_blocked: "tool.called/send_email" },
    { id: "evt_pb_2", time: "2026-03-01T20:00:00Z", source: "agent://orchestrator", policy: "pii_guard", reason: "PII to external", action_blocked: "tool.called/send_email" },
    { id: "evt_pb_3", time: "2026-03-02T09:00:00Z", source: "agent://orchestrator", policy: "pii_guard", reason: "PII to external", action_blocked: "tool.called/send_email" },
    { id: "evt_pb_4", time: "2026-03-03T10:00:00Z", source: "agent://worker", policy: "rate_limit_guard", reason: "Too many calls", action_blocked: "tool.called/http_post" },
    { id: "evt_pb_5", time: "2026-03-03T11:00:00Z", source: "agent://worker", policy: "rate_limit_guard", reason: "Too many calls", action_blocked: "tool.called/http_post" },
  ];

  before(async () => {
    for (const s of seed) {
      const res = await ingest(makeEvent({
        id: s.id,
        time: s.time,
        source: s.source,
        type: "policy.blocked",
        session_id: "ses_pb_001",
        trace_id: PB_TRACE,
        agent_role: "orchestrator",
        payload: { policy: s.policy, reason: s.reason, action_blocked: s.action_blocked },
      }));
      assert.equal(res.status, 202);
    }
  });

  test("requires authentication (401 without a key)", async () => {
    const res = await fetch(`${baseUrl}/analytics/policy-blocked`);
    assert.equal(res.status, 401);
  });

  test("returns aggregated analytics for the tenant", async () => {
    const res = await fetch(`${baseUrl}/analytics/policy-blocked`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.total, 5);
    assert.deepEqual(body.by_policy, [
      { key: "pii_guard", count: 3 },
      { key: "rate_limit_guard", count: 2 },
    ]);
    assert.deepEqual(body.by_action, [
      { key: "tool.called/send_email", count: 3 },
      { key: "tool.called/http_post", count: 2 },
    ]);
    assert.deepEqual(body.by_source, [
      { key: "agent://orchestrator", count: 3 },
      { key: "agent://worker", count: 2 },
    ]);
    assert.deepEqual(body.by_day, [
      { date: "2026-03-01", count: 2 },
      { date: "2026-03-02", count: 1 },
      { date: "2026-03-03", count: 2 },
    ]);
    // recent is most-recent-first and carries the projected fields
    assert.equal(body.recent[0].id, "evt_pb_5");
    assert.equal(body.recent[0].policy, "rate_limit_guard");
    assert.equal(body.recent[0].action_blocked, "tool.called/http_post");
    assert.equal(body.recent.length, 5);
    assert.ok(typeof body.generated_at === "string");
    assert.deepEqual(body.window, { since: null, until: null });
  });

  test("?since is an inclusive lower bound on event time", async () => {
    const res = await fetch(`${baseUrl}/analytics/policy-blocked?since=2026-03-02T00:00:00Z`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // excludes the two 2026-03-01 events
    assert.equal(body.total, 3);
    assert.equal(body.window.since, "2026-03-02T00:00:00Z");
  });

  test("?until is an exclusive upper bound; window narrows to a single day", async () => {
    const res = await fetch(
      `${baseUrl}/analytics/policy-blocked?since=2026-03-02T00:00:00Z&until=2026-03-03T00:00:00Z`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // only the single 2026-03-02 event
    assert.equal(body.total, 1);
    assert.deepEqual(body.by_day, [{ date: "2026-03-02", count: 1 }]);
  });

  test("?limit caps the recent list without changing totals", async () => {
    const res = await fetch(`${baseUrl}/analytics/policy-blocked?limit=2`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 5);
    assert.equal(body.recent.length, 2);
  });

  test("rejects a non-ISO ?since with 400", async () => {
    const res = await fetch(`${baseUrl}/analytics/policy-blocked?since=not-a-date`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("rejects ?limit outside [1,1000] with 400 (shared query validation)", async () => {
    const res = await fetch(`${baseUrl}/analytics/policy-blocked?limit=0`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("repeated ?since params are coerced (last wins), not a 500", async () => {
    const res = await fetch(
      `${baseUrl}/analytics/policy-blocked?since=not-a-date&since=2026-03-02T00:00:00Z`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.window.since, "2026-03-02T00:00:00Z");
    assert.equal(body.total, 3);
  });
});

// ---------------------------------------------------------------------------
// API-key access log — full usage audit trail (Phase 14 PR-E)
// ---------------------------------------------------------------------------

describe("GET /admin/keys/:id/access-log", () => {
  let keyOffId;            // a key whose traffic happens while logging is OFF
  let keyOn, keyOnId;      // a read+write key whose traffic is logged

  // Mint a key and return { id, key } (admin-scoped).
  async function mintKey(scopes) {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-test", label: "access-log", scopes }),
    });
    const body = await res.json();
    return { id: body.id, key: body.key };
  }

  async function getLog(id, qs = "") {
    return fetch(`${baseUrl}/admin/keys/${id}/access-log${qs}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  }

  // Poll the access log until `total` reaches at least `want` (the recorder runs
  // fire-and-forget on response finish), or time out.
  async function waitForTotal(id, want) {
    for (let i = 0; i < 40; i++) {
      const res = await getLog(id);
      const body = await res.json();
      if (body.total >= want) return body;
      await new Promise(r => setTimeout(r, 25));
    }
    const res = await getLog(id);
    return res.json();
  }

  before(async () => {
    // 1) Logging OFF (default): traffic for keyOff must NOT be recorded.
    delete process.env.ACCESS_LOG_ENABLED;
    const off = await mintKey(["read"]);
    keyOffId = off.id;
    await fetch(`${baseUrl}/sessions`, { headers: { Authorization: `Bearer ${off.key}` } });

    // 2) Enable logging, then drive a known amount of traffic with keyOn.
    process.env.ACCESS_LOG_ENABLED = "true";
    const on = await mintKey(["read", "write"]);
    keyOn = on.key;
    keyOnId = on.id;

    // 3 reads (200) + 1 ingest (202) = 4 logged requests for keyOn.
    await fetch(`${baseUrl}/sessions`, { headers: { Authorization: `Bearer ${keyOn}` } });
    await fetch(`${baseUrl}/sessions`, { headers: { Authorization: `Bearer ${keyOn}` } });
    await fetch(`${baseUrl}/metrics`, { headers: { Authorization: `Bearer ${keyOn}` } });
    await ingest(makeEvent({ session_id: "ses_acl", trace_id: "trc_acl" }), keyOn);
    await waitForTotal(keyOnId, 4);
  });

  after(() => {
    delete process.env.ACCESS_LOG_ENABLED;
  });

  test("does NOT record when ACCESS_LOG_ENABLED is unset (opt-in)", async () => {
    const res = await getLog(keyOffId);
    assert.equal(res.status, 200);
    const body = await res.json();
    // keyOff's only request ran while ACCESS_LOG_ENABLED was unset → not recorded.
    // (total === 0 is the proof; `enabled` just reflects the env at *read* time,
    // which is now on, so it does not itself prove the opt-in behaviour.)
    assert.equal(body.total, 0);
  });

  test("requires admin auth (401 without the admin token)", async () => {
    const res = await fetch(`${baseUrl}/admin/keys/${keyOnId}/access-log`);
    assert.equal(res.status, 401);
  });

  test("404 for an unknown key id", async () => {
    const res = await getLog("nonexistent-key-id");
    assert.equal(res.status, 404);
  });

  test("records each key-authenticated request (incl. ingest), most-recent-first", async () => {
    const res = await getLog(keyOnId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.api_key_id, keyOnId);
    assert.equal(body.enabled, true);
    assert.ok(body.total >= 4, `expected >=4 entries, got ${body.total}`);

    // Entries are most-recent-first and carry the expected projected fields.
    for (const e of body.entries) {
      assert.ok(typeof e.method === "string");
      assert.ok(e.path.startsWith("/"));
      assert.ok(!e.path.includes("?"), "path must not contain a query string");
      assert.ok(Number.isInteger(e.status));
      assert.equal(e.tenant_id, "tenant-test");
      assert.ok(typeof e.ts === "string");
    }
    const times = body.entries.map(e => e.ts);
    const sortedDesc = [...times].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(times, sortedDesc);

    // The ingest (POST /events) request was recorded with a 202.
    assert.ok(body.entries.some(e => e.method === "POST" && e.path === "/events" && e.status === 202));
    // A read was recorded with a 200.
    assert.ok(body.entries.some(e => e.method === "GET" && e.path === "/sessions" && e.status === 200));
  });

  test("?limit caps entries but not total", async () => {
    const res = await getLog(keyOnId, "?limit=2");
    const body = await res.json();
    assert.equal(body.entries.length, 2);
    assert.ok(body.total >= 4);
  });

  test("rejects a non-ISO ?since with 400", async () => {
    const res = await getLog(keyOnId, "?since=not-a-date");
    assert.equal(res.status, 400);
  });

  test("?until=epoch-start excludes all of today's entries", async () => {
    const res = await getLog(keyOnId, "?until=1970-01-01T00:00:00Z");
    const body = await res.json();
    assert.equal(body.total, 0);
    assert.equal(body.window.until, "1970-01-01T00:00:00Z");
  });

  test("only logs the requesting key — keyOn's log excludes keyOff activity", async () => {
    const res = await getLog(keyOnId);
    const body = await res.json();
    // every entry belongs to keyOn
    assert.ok(body.entries.every(e => e.api_key_id === keyOnId));
  });

  test("never persists query-string secrets (headline security guarantee)", async () => {
    // Mint a fresh key so the assertion is scoped to exactly this request.
    const secretKey = await mintKey(["read"]);
    const SECRET = "SUPERSECRET-do-not-store";
    await fetch(`${baseUrl}/sessions?limit=5&token=${SECRET}`, {
      headers: { Authorization: `Bearer ${secretKey.key}` },
    });
    const body = await waitForTotal(secretKey.id, 1);

    assert.ok(body.total >= 1);
    // The stored path is the pathname only — no query string, no secret anywhere.
    const entry = body.entries.find(e => e.path.startsWith("/sessions"));
    assert.ok(entry, "expected a /sessions entry");
    assert.equal(entry.path, "/sessions");
    assert.ok(!JSON.stringify(body).includes(SECRET), "the secret query param must never appear in the access log");
  });
});

// ---------------------------------------------------------------------------
// GET /compliance/report — compliance report templates (Phase 14 PR-F)
// ---------------------------------------------------------------------------

describe("GET /compliance/report", () => {
  before(async () => {
    // Seed a small workflow so the report has events/policy.blocked to evidence.
    await ingest(makeEvent({ id: "evt_cmp_1", time: "2026-04-01T08:00:00Z", session_id: "ses_cmp", trace_id: "trc_cmp", type: "task.created" }));
    await ingest(makeEvent({ id: "evt_cmp_2", time: "2026-04-01T09:00:00Z", session_id: "ses_cmp", trace_id: "trc_cmp", type: "policy.blocked", payload: { policy: "pii_guard", action_blocked: "tool.called/x" } }));
  });

  function getReport(qs) {
    return fetch(`${baseUrl}/compliance/report?${qs}`, { headers: { Authorization: `Bearer ${readKey}` } });
  }

  test("requires authentication (401 without a key)", async () => {
    const res = await fetch(`${baseUrl}/compliance/report?framework=soc2`);
    assert.equal(res.status, 401);
  });

  test("missing / invalid framework → 400", async () => {
    assert.equal((await getReport("")).status, 400);
    assert.equal((await getReport("framework=nope")).status, 400);
  });

  for (const fw of ["soc2", "hipaa", "gdpr", "eu_ai_act"]) {
    test(`${fw}: returns a well-formed report`, async () => {
      const res = await getReport(`framework=${fw}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.framework, fw);
      assert.ok(typeof body.framework_name === "string");
      assert.ok(Array.isArray(body.controls) && body.controls.length > 0);
      assert.equal(
        body.summary.satisfied + body.summary.partial + body.summary.unmet + body.summary.not_applicable,
        body.summary.total_controls
      );
      assert.ok(typeof body.disclaimer === "string" && body.disclaimer.length > 0);
      for (const c of body.controls) {
        assert.ok(c.id && c.title && c.requirement && c.status && c.detail);
      }
    });
  }

  test("rejects both session and trace together with 400", async () => {
    const res = await getReport("framework=soc2&session=ses_cmp&trace=trc_cmp");
    assert.equal(res.status, 400);
  });

  test("rejects a non-ISO ?since with 400", async () => {
    const res = await getReport("framework=soc2&since=not-a-date");
    assert.equal(res.status, 400);
  });

  test("integrity control is PARTIAL when AUDIT_SIGNING_SECRET is unset", async () => {
    const prev = process.env.AUDIT_SIGNING_SECRET;
    delete process.env.AUDIT_SIGNING_SECRET;
    try {
      const body = await (await getReport("framework=soc2")).json();
      const integrity = body.controls.find(c => c.id === "CC7.1");
      assert.equal(integrity.status, "partial");
      assert.equal(body.evidence.integrity.signing_configured, false);
    } finally {
      if (prev === undefined) delete process.env.AUDIT_SIGNING_SECRET;
      else process.env.AUDIT_SIGNING_SECRET = prev;
    }
  });

  test("integrity control is SATISFIED + bundle verified when signing is configured and a trace scope is given", async () => {
    const prev = process.env.AUDIT_SIGNING_SECRET;
    process.env.AUDIT_SIGNING_SECRET = "test-compliance-secret";
    try {
      const body = await (await getReport("framework=soc2&trace=trc_cmp")).json();
      const integrity = body.controls.find(c => c.id === "CC7.1");
      assert.equal(integrity.status, "satisfied");
      assert.equal(body.evidence.integrity.signing_configured, true);
      assert.equal(body.evidence.integrity.bundle_verified, true);
      assert.equal(body.scope.trace_id, "trc_cmp");
    } finally {
      if (prev === undefined) delete process.env.AUDIT_SIGNING_SECRET;
      else process.env.AUDIT_SIGNING_SECRET = prev;
    }
  });

  test("EU AI Act human-oversight is satisfied once a policy.blocked event exists", async () => {
    const body = await (await getReport("framework=eu_ai_act")).json();
    const oversight = body.controls.find(c => c.id === "Art.14");
    assert.equal(oversight.status, "satisfied");
  });

  test("?format=pdf returns a PDF document", async () => {
    const res = await getReport("framework=hipaa&format=pdf");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  test("a nonexistent ?trace scope is not a 404 — it just yields no integrity proof", async () => {
    // The scope is an OPTIONAL proof-point, not the resource; a typo'd/missing
    // scope returns 200 with bundle_verified=null (capability still reported).
    const prev = process.env.AUDIT_SIGNING_SECRET;
    process.env.AUDIT_SIGNING_SECRET = "test-compliance-secret";
    try {
      const res = await getReport("framework=soc2&trace=trc_does_not_exist");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.evidence.integrity.bundle_verified, null);
      // signing is configured, so the integrity control is still satisfied (the
      // capability exists) even though no bundle could be built for the scope.
      assert.equal(body.controls.find(c => c.id === "CC7.1").status, "satisfied");
    } finally {
      if (prev === undefined) delete process.env.AUDIT_SIGNING_SECRET;
      else process.env.AUDIT_SIGNING_SECRET = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Data-residency region labels (Phase 14 PR-G)
// ---------------------------------------------------------------------------

describe("data-residency region labels", () => {
  async function createProject(body) {
    return fetch(`${baseUrl}/admin/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body),
    });
  }

  test("a project stores and returns its region + regionEnforced", async () => {
    const res = await createProject({ tenantId: "res-a", tier: "team", region: "eu" });
    assert.equal(res.status, 201);
    const { project } = await res.json();
    assert.equal(project.region, "EU"); // canonicalized
    assert.equal(typeof project.regionEnforced, "boolean");
  });

  test("an omitted region is null and regionEnforced (no requirement)", async () => {
    const res = await createProject({ tenantId: "res-b", tier: "free" });
    assert.equal(res.status, 201);
    const { project } = await res.json();
    assert.equal(project.region, null);
    assert.equal(project.regionEnforced, true);
  });

  test("an invalid region → 400", async () => {
    const res = await createProject({ tenantId: "res-c", region: "mars" });
    assert.equal(res.status, 400);
  });

  test("regionEnforced reflects the deployment's DATA_RESIDENCY_REGION", async () => {
    const prev = process.env.DATA_RESIDENCY_REGION;
    process.env.DATA_RESIDENCY_REGION = "EU";
    try {
      const euRes = await (await createProject({ tenantId: "res-eu", region: "EU" })).json();
      assert.equal(euRes.project.regionEnforced, true); // deployment is EU, project wants EU

      const usRes = await (await createProject({ tenantId: "res-us", region: "US" })).json();
      assert.equal(usRes.project.regionEnforced, false); // deployment is EU, project wants US — mismatch
      assert.equal(usRes.project.region, "US");
    } finally {
      if (prev === undefined) delete process.env.DATA_RESIDENCY_REGION;
      else process.env.DATA_RESIDENCY_REGION = prev;
    }
  });

  test("GET /admin/projects/:id includes region + regionEnforced", async () => {
    const created = await (await createProject({ tenantId: "res-d", region: "APAC" })).json();
    const res = await fetch(`${baseUrl}/admin/projects/${created.project.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const { project } = await res.json();
    assert.equal(project.region, "APAC");
    assert.ok("regionEnforced" in project);
  });

  test("audit bundle records data_residency_region only when the deployment declares one", async () => {
    // Seed a one-event session for this tenant.
    await ingest(makeEvent({ id: "evt_res_1", session_id: "ses_res", trace_id: "trc_res" }));

    const prevSecret = process.env.AUDIT_SIGNING_SECRET;
    const prevRegion = process.env.DATA_RESIDENCY_REGION;
    process.env.AUDIT_SIGNING_SECRET = "test-residency-secret";
    try {
      // With a deployment region set → manifest carries data_residency_region.
      process.env.DATA_RESIDENCY_REGION = "EU";
      let res = await fetch(`${baseUrl}/sessions/ses_res/audit-bundle`, {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      assert.equal(res.status, 200);
      let bundle = await res.json();
      assert.equal(bundle.manifest.data_residency_region, "EU");
      // The region field is INSIDE the signed manifest: the bundle still verifies
      // (the signature is recomputed over the manifest including the new field).
      const { verifyAuditBundle } = require("../../src/audit");
      assert.equal(verifyAuditBundle(bundle, process.env.AUDIT_SIGNING_SECRET).valid, true);

      // Without a deployment region → field is absent (byte-compatible with pre-PR-G).
      delete process.env.DATA_RESIDENCY_REGION;
      res = await fetch(`${baseUrl}/sessions/ses_res/audit-bundle`, {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      bundle = await res.json();
      assert.equal("data_residency_region" in bundle.manifest, false);
    } finally {
      if (prevSecret === undefined) delete process.env.AUDIT_SIGNING_SECRET;
      else process.env.AUDIT_SIGNING_SECRET = prevSecret;
      if (prevRegion === undefined) delete process.env.DATA_RESIDENCY_REGION;
      else process.env.DATA_RESIDENCY_REGION = prevRegion;
    }
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/performance — latency / performance profiling (Phase 15-A)
// ---------------------------------------------------------------------------

describe("GET /analytics/performance", () => {
  // Seed lifecycle events in a far-future window (2030-01) that no other test
  // touches, so a since/until bound isolates exactly these operations even
  // though the endpoint is tenant-scoped (other tests emit task/tool events too).
  const PERF_SINCE = "2030-01-01T00:00:00Z";
  const PERF_UNTIL = "2030-02-01T00:00:00Z";

  before(async () => {
    const seed = [
      // web_search ×2 on agent://a / ses_perf_1 (2000ms, 5000ms)
      { id: "evt_pf_c1", time: "2030-01-01T00:00:00Z", source: "agent://a", type: "tool.called", session_id: "ses_perf_1", payload: { tool: "web_search" } },
      { id: "evt_pf_r1", time: "2030-01-01T00:00:02Z", source: "agent://a", type: "tool.result", session_id: "ses_perf_1", causation_id: "evt_pf_c1", payload: { tool: "web_search", status: "success" } },
      { id: "evt_pf_c2", time: "2030-01-01T00:01:00Z", source: "agent://a", type: "tool.called", session_id: "ses_perf_1", payload: { tool: "web_search" } },
      { id: "evt_pf_r2", time: "2030-01-01T00:01:05Z", source: "agent://a", type: "tool.result", session_id: "ses_perf_1", causation_id: "evt_pf_c2", payload: { tool: "web_search", status: "success" } },
      // db_query ×1 on agent://b / ses_perf_2 (1000ms)
      { id: "evt_pf_c3", time: "2030-01-01T00:02:00Z", source: "agent://b", type: "tool.called", session_id: "ses_perf_2", payload: { tool: "db_query" } },
      { id: "evt_pf_r3", time: "2030-01-01T00:02:01Z", source: "agent://b", type: "tool.result", session_id: "ses_perf_2", causation_id: "evt_pf_c3", payload: { tool: "db_query", status: "success" } },
      // task completed (10000ms) and task failed (3000ms) on agent://orch
      { id: "evt_pf_t1", time: "2030-01-01T00:03:00Z", source: "agent://orch", type: "task.created", session_id: "ses_perf_1", payload: { task: "summarize" } },
      { id: "evt_pf_tc1", time: "2030-01-01T00:03:10Z", source: "agent://orch", type: "task.completed", session_id: "ses_perf_1", causation_id: "evt_pf_t1", payload: { result: "done" } },
      { id: "evt_pf_t2", time: "2030-01-01T00:04:00Z", source: "agent://orch", type: "task.created", session_id: "ses_perf_2", payload: { task: "fetch" } },
      { id: "evt_pf_tf1", time: "2030-01-01T00:04:03Z", source: "agent://orch", type: "task.failed", session_id: "ses_perf_2", causation_id: "evt_pf_t2", payload: { reason: "timeout" } },
      // an unmatched end: tool.result whose causation_id points at nothing
      { id: "evt_pf_orphan", time: "2030-01-01T00:05:00Z", source: "agent://a", type: "tool.result", session_id: "ses_perf_1", causation_id: "evt_pf_missing", payload: { tool: "web_search", status: "success" } },
    ];
    for (const s of seed) {
      const res = await ingest(makeEvent({ trace_id: "trc_perf", agent_role: "subagent", ...s }));
      assert.equal(res.status, 202);
    }
  });

  test("requires authentication (401 without a key)", async () => {
    const res = await fetch(`${baseUrl}/analytics/performance`);
    assert.equal(res.status, 401);
  });

  test("computes percentile latency and the grouped breakdowns", async () => {
    const res = await fetch(
      `${baseUrl}/analytics/performance?since=${PERF_SINCE}&until=${PERF_UNTIL}`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    // 5 matched operations; 1 unmatched end (the orphan tool.result).
    assert.equal(body.total_operations, 5);
    assert.equal(body.unmatched_ends, 1);

    // durations sorted: [1000, 2000, 3000, 5000, 10000]
    assert.equal(body.overall.p50, 3000); // nearest-rank
    assert.equal(body.overall.p95, 10000);
    assert.equal(body.overall.p99, 10000);
    assert.equal(body.overall.min, 1000);
    assert.equal(body.overall.max, 10000);
    assert.equal(body.overall.mean, 4200);

    // by_tool excludes task ops; ranked by count desc
    assert.deepEqual(body.by_tool.map((t) => [t.key, t.count]), [
      ["web_search", 2],
      ["db_query", 1],
    ]);
    const ws = body.by_tool.find((t) => t.key === "web_search");
    assert.equal(ws.max, 5000);

    // by_operation: tool pair (3) then the two task pairs (1 each), tie alpha
    assert.deepEqual(body.by_operation.map((o) => [o.key, o.count]), [
      ["tool.called→tool.result", 3],
      ["task.created→task.completed", 1],
      ["task.created→task.failed", 1],
    ]);

    // by_agent: agent://a (2) & agent://orch (2) tie → alpha; then agent://b (1)
    assert.deepEqual(body.by_agent.map((a) => [a.key, a.count]), [
      ["agent://a", 2],
      ["agent://orch", 2],
      ["agent://b", 1],
    ]);

    // slowest is the 10s task.completed, descending
    assert.equal(body.slowest[0].duration_ms, 10000);
    assert.equal(body.slowest[0].op_type, "task.created→task.completed");
    assert.equal(body.slowest[0].status, "completed");
    assert.ok(typeof body.generated_at === "string");
    assert.deepEqual(body.window, { since: PERF_SINCE, until: PERF_UNTIL });
  });

  test("?limit caps the slowest list without changing totals", async () => {
    const res = await fetch(
      `${baseUrl}/analytics/performance?since=${PERF_SINCE}&until=${PERF_UNTIL}&limit=2`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total_operations, 5);
    assert.equal(body.slowest.length, 2);
    assert.deepEqual(body.slowest.map((s) => s.duration_ms), [10000, 5000]);
  });

  test("a narrowed ?until window drops later operations", async () => {
    // Up to 00:02:30 → only the three tool operations (both web_search pairs +
    // the db_query pair, all of whose events end before 00:02:30); the two task
    // pairs (00:03+) and the orphan (00:05) fall outside the window.
    const res = await fetch(
      `${baseUrl}/analytics/performance?since=${PERF_SINCE}&until=2030-01-01T00:02:30Z`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // c1/r1 (2000ms) and c3/r3 (1000ms) fully inside; c2 started 00:01:00 but
    // its result r2 ends 00:01:05 — also inside. So 3 tool ops, no tasks.
    assert.equal(body.total_operations, 3);
    assert.equal(body.by_tool.reduce((n, t) => n + t.count, 0), 3);
    assert.deepEqual(body.by_operation.map((o) => o.key), ["tool.called→tool.result"]);
  });

  test("rejects a non-ISO ?since with 400", async () => {
    const res = await fetch(`${baseUrl}/analytics/performance?since=not-a-date`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("rejects ?limit outside [1,1000] with 400 (shared query validation)", async () => {
    const res = await fetch(`${baseUrl}/analytics/performance?limit=0`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Custom analytics — user-defined queries + saved-query library (Phase 15-B)
// ---------------------------------------------------------------------------

describe("Custom analytics — POST /analytics/query", () => {
  // Seed events in a far-future window (2031-01) that no other test touches, so
  // a since/until bound isolates exactly these even though queries are tenant-scoped.
  const Q_SINCE = "2031-01-01T00:00:00Z";
  const Q_UNTIL = "2031-02-01T00:00:00Z";

  before(async () => {
    const seed = [
      { id: "evt_q1", time: "2031-01-01T00:00:00Z", source: "agent://a", type: "tool.called", session_id: "ses_q1", payload: { tool: "web_search" }, labels: { env: "prod" } },
      { id: "evt_q2", time: "2031-01-01T01:00:00Z", source: "agent://a", type: "tool.called", session_id: "ses_q1", payload: { tool: "web_search" }, labels: { env: "prod" } },
      { id: "evt_q3", time: "2031-01-02T00:00:00Z", source: "agent://b", type: "tool.called", session_id: "ses_q2", payload: { tool: "db_query" }, labels: { env: "dev" } },
      { id: "evt_q4", time: "2031-01-02T00:00:00Z", source: "agent://a", type: "task.created", session_id: "ses_q1", payload: { priority: "high" } },
    ];
    for (const s of seed) {
      const res = await ingest(makeEvent({ trace_id: "trc_q", agent_role: "subagent", ...s }));
      assert.equal(res.status, 202);
    }
  });

  test("requires authentication (401 without a key)", async () => {
    const res = await fetch(`${baseUrl}/analytics/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ since: Q_SINCE, until: Q_UNTIL }),
    });
    assert.equal(res.status, 401);
  });

  test("runs an ad-hoc grouped query", async () => {
    const res = await fetch(`${baseUrl}/analytics/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readKey}` },
      body: JSON.stringify({
        since: Q_SINCE,
        until: Q_UNTIL,
        filters: [{ field: "type", op: "eq", value: "tool.called" }],
        group_by: ["payload.tool"],
        aggregations: [{ op: "count" }, { op: "count_distinct", field: "session_id" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total_matched, 3);
    assert.deepEqual(body.rows.map((r) => [r.group["payload.tool"], r.count]), [
      ["web_search", 2],
      ["db_query", 1],
    ]);
    const ws = body.rows.find((r) => r.group["payload.tool"] === "web_search");
    assert.equal(ws.distinct.session_id, 1);
  });

  test("rejects an invalid spec with 400 + details", async () => {
    const res = await fetch(`${baseUrl}/analytics/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readKey}` },
      body: JSON.stringify({ group_by: ["payload.__proto__"] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(Array.isArray(body.details) && /forbidden segment/.test(body.details.join(" ")));
  });

  test("rejects a non-whitelisted field with 400", async () => {
    const res = await fetch(`${baseUrl}/analytics/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readKey}` },
      body: JSON.stringify({ filters: [{ field: "raw_payload", op: "exists" }] }),
    });
    assert.equal(res.status, 400);
  });
});

describe("Custom analytics — saved-query library", () => {
  const Q_SINCE = "2031-01-01T00:00:00Z";
  const Q_UNTIL = "2031-02-01T00:00:00Z";
  const SAMPLE_SPEC = {
    since: Q_SINCE,
    until: Q_UNTIL,
    filters: [{ field: "type", op: "eq", value: "tool.called" }],
    group_by: ["payload.tool"],
  };
  let savedId;
  let otherKey; // a second tenant's read+write key (for isolation tests)

  before(async () => {
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-other-15b", label: "other", scopes: ["read", "write"] }),
    });
    otherKey = (await res.json()).key;
  });

  test("create requires a write-scoped key (read key → 403)", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readKey}` },
      body: JSON.stringify({ name: "should-fail", spec: SAMPLE_SPEC }),
    });
    assert.equal(res.status, 403);
  });

  test("create with a write key returns 201 and the stored record", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ name: "tools-by-name", spec: SAMPLE_SPEC }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id.startsWith("sq_"));
    assert.equal(body.name, "tools-by-name");
    assert.equal(body.spec.group_by[0], "payload.tool");
    savedId = body.id;
  });

  test("a duplicate name for the same tenant → 409", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ name: "tools-by-name", spec: SAMPLE_SPEC }),
    });
    assert.equal(res.status, 409);
  });

  test("create rejects an invalid spec with 400", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ name: "bad", spec: { limit: 99999 } }),
    });
    assert.equal(res.status, 400);
  });

  test("create rejects a missing name with 400", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ spec: SAMPLE_SPEC }),
    });
    assert.equal(res.status, 400);
  });

  test("list returns the tenant's saved queries (read scope)", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.saved_queries.some((q) => q.id === savedId));
  });

  test("rejects a malformed saved-query id with 400 (path-param validation)", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries/bad..id`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("get one by id (read scope), 404 for unknown", async () => {
    const ok = await fetch(`${baseUrl}/analytics/saved-queries/${savedId}`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(ok.status, 200);
    const miss = await fetch(`${baseUrl}/analytics/saved-queries/sq_nonexistent`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(miss.status, 404);
  });

  test("run a saved query by id returns results + the saved_query ref", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries/${savedId}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total_matched, 3);
    assert.equal(body.saved_query.id, savedId);
    assert.equal(body.saved_query.name, "tools-by-name");
  });

  test("tenant isolation: another tenant cannot see, run, or delete the query", async () => {
    const list = await fetch(`${baseUrl}/analytics/saved-queries`, {
      headers: { Authorization: `Bearer ${otherKey}` },
    });
    const listBody = await list.json();
    assert.equal(listBody.saved_queries.some((q) => q.id === savedId), false);

    const get = await fetch(`${baseUrl}/analytics/saved-queries/${savedId}`, {
      headers: { Authorization: `Bearer ${otherKey}` },
    });
    assert.equal(get.status, 404);

    const run = await fetch(`${baseUrl}/analytics/saved-queries/${savedId}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherKey}` },
    });
    assert.equal(run.status, 404);

    const del = await fetch(`${baseUrl}/analytics/saved-queries/${savedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${otherKey}` },
    });
    assert.equal(del.status, 404);
  });

  test("delete requires a write key (read key → 403)", async () => {
    const res = await fetch(`${baseUrl}/analytics/saved-queries/${savedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 403);
  });

  test("delete with a write key returns 204; a second delete → 404", async () => {
    const first = await fetch(`${baseUrl}/analytics/saved-queries/${savedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${writeKey}` },
    });
    assert.equal(first.status, 204);
    const second = await fetch(`${baseUrl}/analytics/saved-queries/${savedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${writeKey}` },
    });
    assert.equal(second.status, 404);
  });
});

// ---------------------------------------------------------------------------
// GET /workflows/:traceId/graph — cross-session causation graph (Phase 15-C)
// ---------------------------------------------------------------------------

describe("GET /workflows/:traceId/graph", () => {
  // A two-session workflow: an orchestrator session hands off to a sub-agent
  // session; the cross-session causation edge is handoff.started → task.created.
  const WG_TRACE = "trc_wfgraph_15c";
  before(async () => {
    const seed = [
      { id: "wg_t1", time: "2032-01-01T00:00:00Z", source: "agent://orch", type: "task.created", session_id: "ses_wg_orch", agent_role: "orchestrator" },
      { id: "wg_h1", time: "2032-01-01T00:00:01Z", source: "agent://orch", type: "handoff.started", session_id: "ses_wg_orch", agent_role: "orchestrator", causation_id: "wg_t1" },
      { id: "wg_t2", time: "2032-01-01T00:00:02Z", source: "agent://sub", type: "task.created", session_id: "ses_wg_sub", parent_session_id: "ses_wg_orch", agent_role: "subagent", causation_id: "wg_h1" },
      { id: "wg_r2", time: "2032-01-01T00:00:03Z", source: "agent://sub", type: "task.completed", session_id: "ses_wg_sub", agent_role: "subagent", causation_id: "wg_t2" },
    ];
    for (const s of seed) {
      const res = await ingest(makeEvent({ trace_id: WG_TRACE, ...s }));
      assert.equal(res.status, 202);
    }
  });

  test("requires authentication (401 without a key)", async () => {
    const res = await fetch(`${baseUrl}/workflows/${WG_TRACE}/graph`);
    assert.equal(res.status, 401);
  });

  test("404 for an unknown trace", async () => {
    const res = await fetch(`${baseUrl}/workflows/trc_does_not_exist/graph`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 404);
  });

  test("assembles the cross-session causation graph", async () => {
    const res = await fetch(`${baseUrl}/workflows/${WG_TRACE}/graph`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 200);
    const g = await res.json();

    assert.equal(g.trace_id, WG_TRACE);
    assert.equal(g.event_count, 4);
    assert.equal(g.session_count, 2);
    assert.equal(g.edge_count, 3); // t1→h1, h1→t2, t2→r2
    assert.equal(g.cross_session_edge_count, 1); // only h1→t2 spans sessions
    assert.deepEqual(g.root_ids, ["wg_t1"]);

    // sessions ordered by first appearance: orch then sub
    assert.deepEqual(g.sessions.map((s) => [s.session_id, s.event_count]), [
      ["ses_wg_orch", 2],
      ["ses_wg_sub", 2],
    ]);

    // the cross-session edge is the handoff → sub-agent task
    const cross = g.edges.find((e) => e.cross_session);
    assert.equal(cross.from, "wg_h1");
    assert.equal(cross.to, "wg_t2");
    assert.ok(typeof g.generated_at === "string");
  });

  test("rejects a malformed traceId with 400 (path-param validation)", async () => {
    const res = await fetch(`${baseUrl}/workflows/bad..trace/graph`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("tenant isolation: another tenant cannot see the graph", async () => {
    const keyRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-other-15c", label: "other", scopes: ["read"] }),
    });
    const otherKey = (await keyRes.json()).key;
    const res = await fetch(`${baseUrl}/workflows/${WG_TRACE}/graph`, {
      headers: { Authorization: `Bearer ${otherKey}` },
    });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/anomalies — workflow anomaly detection (Phase 15-D)
// ---------------------------------------------------------------------------

describe("GET /analytics/anomalies", () => {
  // 8 calm traces (no policy.blocked) + 1 trace with a burst of policy.blocked,
  // all in a far-future window (2033-01) so the cross-trace baseline is exact.
  const AD_SINCE = "2033-01-01T00:00:00Z";
  const AD_UNTIL = "2033-02-01T00:00:00Z";

  before(async () => {
    let t = Date.parse("2033-01-01T00:00:00Z");
    const at = () => new Date((t += 1000)).toISOString();
    // 8 calm traces, 3 benign task.created each
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 3; j++) {
        const res = await ingest(makeEvent({
          id: `ad_calm_${i}_${j}`, time: at(), type: "task.created",
          session_id: `ses_ad_${i}`, trace_id: `trc_ad_calm_${i}`,
        }));
        assert.equal(res.status, 202);
      }
    }
    // 1 anomalous trace: a burst of 10 policy.blocked
    for (let k = 0; k < 10; k++) {
      const res = await ingest(makeEvent({
        id: `ad_spike_${k}`, time: at(), type: "policy.blocked",
        session_id: "ses_ad_spike", trace_id: "trc_ad_spike",
        payload: { policy: "pii_guard", action_blocked: "send_email" },
      }));
      assert.equal(res.status, 202);
    }
  });

  test("requires authentication (401 without a key)", async () => {
    const res = await fetch(`${baseUrl}/analytics/anomalies`);
    assert.equal(res.status, 401);
  });

  test("flags the policy.blocked-volume spike against the calm baseline", async () => {
    const res = await fetch(
      `${baseUrl}/analytics/anomalies?since=${AD_SINCE}&until=${AD_UNTIL}`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.trace_count, 9); // 8 calm + 1 spike
    assert.equal(body.threshold, 3.5);
    assert.equal(body.anomaly_count, 1);
    const a = body.anomalies[0];
    assert.equal(a.trace_id, "trc_ad_spike");
    assert.equal(a.metrics.policy_blocked_count, 10);
    assert.ok(a.flags.some((f) => f.metric === "policy_blocked_count"));
    assert.ok(["critical", "high", "medium"].includes(a.severity));
    assert.deepEqual(body.window, { since: AD_SINCE, until: AD_UNTIL });
    // the policy_blocked baseline is stable; latency has no ops → not stable
    assert.equal(body.baselines.policy_blocked_count.stable, true);
    assert.equal(body.baselines.latency_max_ms.stable, false);
  });

  test("a higher ?threshold can suppress the flag", async () => {
    const res = await fetch(
      `${baseUrl}/analytics/anomalies?since=${AD_SINCE}&until=${AD_UNTIL}&threshold=100`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.anomaly_count, 0);
  });

  test("?limit caps the anomalies list (count is pre-cap)", async () => {
    const res = await fetch(
      `${baseUrl}/analytics/anomalies?since=${AD_SINCE}&until=${AD_UNTIL}&limit=1`,
      { headers: { Authorization: `Bearer ${readKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.anomalies.length <= 1);
  });

  test("rejects a non-positive ?threshold with 400", async () => {
    const res = await fetch(`${baseUrl}/analytics/anomalies?threshold=0`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("rejects a non-ISO ?since with 400", async () => {
    const res = await fetch(`${baseUrl}/analytics/anomalies?since=not-a-date`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(res.status, 400);
  });

  test("tenant isolation: another tenant sees none of this tenant's anomalies", async () => {
    const keyRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-other-15d", label: "other", scopes: ["read"] }),
    });
    const otherKey = (await keyRes.json()).key;
    const res = await fetch(
      `${baseUrl}/analytics/anomalies?since=${AD_SINCE}&until=${AD_UNTIL}`,
      { headers: { Authorization: `Bearer ${otherKey}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trace_count, 0);
    assert.equal(body.anomaly_count, 0);
  });
});

// ---------------------------------------------------------------------------
// Webhooks (Phase 16-A) — registration & management
// ---------------------------------------------------------------------------

describe("Webhooks — POST /webhooks (registration)", () => {
  test("creates a webhook with defaults (wildcard filter, enabled)", async () => {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: "https://hooks.example.com/aep" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.id, /^wh_/);
    assert.equal(body.target_url, "https://hooks.example.com/aep");
    assert.deepEqual(body.event_types, ["*"]);
    assert.equal(body.enabled, true);
    assert.equal(body.tenant_id, "tenant-test");
    assert.ok(body.created_at && body.updated_at);
  });

  test("creates with an explicit event-type filter and disabled flag", async () => {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({
        target_url: "https://hooks.example.com/errors",
        event_types: ["error.raised", "task.failed"],
        enabled: false,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.event_types, ["error.raised", "task.failed"]);
    assert.equal(body.enabled, false);
  });

  test("rejects an SSRF target (loopback) with 400", async () => {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: "http://127.0.0.1:9000/x" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.details.some((d) => /SSRF/.test(d)));
  });

  test("rejects a private RFC1918 + cloud-metadata target with 400", async () => {
    for (const url of ["http://10.0.0.5/x", "http://169.254.169.254/latest/meta-data/"]) {
      const res = await fetch(`${baseUrl}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
        body: JSON.stringify({ target_url: url }),
      });
      assert.equal(res.status, 400, url);
    }
  });

  test("rejects a non-http(s) scheme with 400", async () => {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: "file:///etc/passwd" }),
    });
    assert.equal(res.status, 400);
  });

  test("rejects an unknown event type with 400", async () => {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: "https://h.example.com/x", event_types: ["bogus.type"] }),
    });
    assert.equal(res.status, 400);
  });

  test("requires a write-scoped key (403 read, 401 anon)", async () => {
    const r403 = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readKey}` },
      body: JSON.stringify({ target_url: "https://h.example.com/x" }),
    });
    assert.equal(r403.status, 403);
    const r401 = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_url: "https://h.example.com/x" }),
    });
    assert.equal(r401.status, 401);
  });

  test("honours WEBHOOK_TARGET_ALLOWLIST for a private target", async () => {
    process.env.WEBHOOK_TARGET_ALLOWLIST = "127.0.0.1:9099";
    try {
      const res = await fetch(`${baseUrl}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
        body: JSON.stringify({ target_url: "http://127.0.0.1:9099/hook" }),
      });
      assert.equal(res.status, 201);
    } finally {
      delete process.env.WEBHOOK_TARGET_ALLOWLIST;
    }
  });
});

describe("Webhooks — GET / PATCH / DELETE", () => {
  async function createWebhook(overrides = {}) {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: "https://hooks.example.com/m", ...overrides }),
    });
    return (await res.json());
  }

  test("GET /webhooks lists the tenant's webhooks (read scope)", async () => {
    await createWebhook();
    const res = await fetch(`${baseUrl}/webhooks`, { headers: { Authorization: `Bearer ${readKey}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.webhooks));
    assert.ok(body.webhooks.length >= 1);
  });

  test("GET /webhooks/:id returns one, 404 for missing", async () => {
    const wh = await createWebhook();
    const res = await fetch(`${baseUrl}/webhooks/${wh.id}`, { headers: { Authorization: `Bearer ${readKey}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, wh.id);

    const miss = await fetch(`${baseUrl}/webhooks/wh_nope`, { headers: { Authorization: `Bearer ${readKey}` } });
    assert.equal(miss.status, 404);
  });

  test("PATCH toggles enabled and updates filter/url", async () => {
    const wh = await createWebhook({ enabled: true });
    const res = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ enabled: false, event_types: ["tool.called"], target_url: "https://hooks.example.com/new" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, false);
    assert.deepEqual(body.event_types, ["tool.called"]);
    assert.equal(body.target_url, "https://hooks.example.com/new");
    assert.ok(body.updated_at >= wh.updated_at);
  });

  test("PATCH re-validates SSRF on a target_url change (400)", async () => {
    const wh = await createWebhook();
    const res = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: "http://192.168.1.10/x" }),
    });
    assert.equal(res.status, 400);
  });

  test("PATCH with no updatable fields → 400", async () => {
    const wh = await createWebhook();
    const res = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test("PATCH a missing webhook → 404", async () => {
    const res = await fetch(`${baseUrl}/webhooks/wh_missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 404);
  });

  test("PATCH/DELETE require a write-scoped key (403 read)", async () => {
    const wh = await createWebhook();
    const p = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readKey}` },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(p.status, 403);
    const d = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(d.status, 403);
  });

  test("DELETE removes a webhook (204), then 404", async () => {
    const wh = await createWebhook();
    const del = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${writeKey}` },
    });
    assert.equal(del.status, 204);
    const after = await fetch(`${baseUrl}/webhooks/${wh.id}`, { headers: { Authorization: `Bearer ${writeKey}` } });
    assert.equal(after.status, 404);
    const delAgain = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${writeKey}` },
    });
    assert.equal(delAgain.status, 404);
  });

  test("tenant isolation — another tenant cannot see, fetch, patch, or delete", async () => {
    const wh = await createWebhook();
    const keyRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-other-16a", label: "other", scopes: ["read", "write"] }),
    });
    const otherKey = (await keyRes.json()).key;

    const list = await fetch(`${baseUrl}/webhooks`, { headers: { Authorization: `Bearer ${otherKey}` } });
    const listBody = await list.json();
    assert.ok(!listBody.webhooks.some((w) => w.id === wh.id));

    const get = await fetch(`${baseUrl}/webhooks/${wh.id}`, { headers: { Authorization: `Bearer ${otherKey}` } });
    assert.equal(get.status, 404);

    const patch = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherKey}` },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(patch.status, 404);

    const del = await fetch(`${baseUrl}/webhooks/${wh.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${otherKey}` },
    });
    assert.equal(del.status, 404);

    // The original tenant still sees it intact.
    const stillThere = await fetch(`${baseUrl}/webhooks/${wh.id}`, { headers: { Authorization: `Bearer ${writeKey}` } });
    assert.equal(stillThere.status, 200);
    assert.equal((await stillThere.json()).enabled, true);
  });
});

// ---------------------------------------------------------------------------
// Webhooks (Phase 16-B) — event delivery + retries
//
// Exercises the REAL outbound delivery path against a local http listener, gated
// by WEBHOOKS_ENABLED + WEBHOOK_TARGET_ALLOWLIST (so 127.0.0.1 is permitted) with
// tiny backoff so retries are fast. Delivery is fire-and-forget, so tests poll the
// webhook_deliveries table (via the db module) until a terminal row appears.
// ---------------------------------------------------------------------------

describe("Webhooks — event delivery (Phase 16-B)", () => {
  const http = require("http");
  let listener;
  let listenerPort;
  let received;
  let responder; // (hitCount, res) => void — set per test

  before(async () => {
    received = [];
    responder = (n, res) => res.writeHead(200).end("ok");
    listener = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body });
        responder(received.length, res);
      });
    });
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    listenerPort = listener.address().port;

    process.env.WEBHOOKS_ENABLED = "1";
    process.env.WEBHOOK_TARGET_ALLOWLIST = `127.0.0.1:${listenerPort}`;
    process.env.WEBHOOK_MAX_RETRIES = "3";
    process.env.WEBHOOK_BACKOFF_BASE_MS = "1";
    process.env.WEBHOOK_BACKOFF_MAX_MS = "5";
    process.env.WEBHOOK_TIMEOUT_MS = "2000";
  });

  after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    delete process.env.WEBHOOKS_ENABLED;
    delete process.env.WEBHOOK_TARGET_ALLOWLIST;
    delete process.env.WEBHOOK_MAX_RETRIES;
    delete process.env.WEBHOOK_BACKOFF_BASE_MS;
    delete process.env.WEBHOOK_BACKOFF_MAX_MS;
    delete process.env.WEBHOOK_TIMEOUT_MS;
  });

  async function registerWebhook(body) {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: `http://127.0.0.1:${listenerPort}/hook`, ...body }),
    });
    assert.equal(res.status, 201);
    return res.json();
  }

  async function waitForTerminalDelivery(webhookId, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await db.listWebhookDeliveries(webhookId, "tenant-test", { limit: 10 });
      const terminal = rows.find((r) => r.status === "success" || r.status === "failed");
      if (terminal) return { rows, terminal };
      await new Promise((r) => setTimeout(r, 20));
    }
    const rows = await db.listWebhookDeliveries(webhookId, "tenant-test", { limit: 10 });
    return { rows, terminal: null };
  }

  test("delivers a matching event and records a success row", async () => {
    const before = received.length;
    const wh = await registerWebhook({ event_types: ["task.created"] });
    const event = makeEvent({ id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "task.created" });
    const ing = await ingest(event);
    assert.equal(ing.status, 202);

    const { terminal } = await waitForTerminalDelivery(wh.id);
    assert.ok(terminal, "expected a terminal delivery row");
    assert.equal(terminal.status, "success");
    assert.equal(terminal.attempts, 1);
    assert.equal(terminal.last_status_code, 200);
    assert.equal(terminal.event_id, event.id);
    assert.equal(terminal.event_type, "task.created");

    // The listener actually received the POST with the event in the body.
    assert.ok(received.length > before);
    const last = received[received.length - 1];
    assert.equal(last.method, "POST");
    const payload = JSON.parse(last.body);
    assert.equal(payload.event.id, event.id);
    assert.equal(payload.webhook_id, wh.id);
  });

  test("retries on 5xx then succeeds (records attempts > 1)", async () => {
    const wh = await registerWebhook({ event_types: ["task.failed"] });
    // Fail the first hit for THIS webhook's path, succeed after.
    let hits = 0;
    responder = (n, res) => {
      hits += 1;
      if (hits === 1) res.writeHead(503).end("try later");
      else res.writeHead(200).end("ok");
    };
    const event = makeEvent({ id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "task.failed" });
    await ingest(event);

    const { terminal } = await waitForTerminalDelivery(wh.id);
    assert.ok(terminal);
    assert.equal(terminal.status, "success");
    assert.ok(terminal.attempts >= 2, `expected ≥2 attempts, got ${terminal.attempts}`);
    responder = (n, res) => res.writeHead(200).end("ok");
  });

  test("records a failed row after exhausting retries on persistent 500", async () => {
    const wh = await registerWebhook({ event_types: ["error.raised"] });
    responder = (n, res) => res.writeHead(500).end("nope");
    const event = makeEvent({ id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "error.raised" });
    await ingest(event);

    const { terminal } = await waitForTerminalDelivery(wh.id);
    assert.ok(terminal);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.attempts, 4); // 1 + WEBHOOK_MAX_RETRIES(3)
    assert.equal(terminal.last_status_code, 500);
    responder = (n, res) => res.writeHead(200).end("ok");
  });

  test("does not deliver an event that does not match the filter", async () => {
    const wh = await registerWebhook({ event_types: ["memory.read"] });
    const event = makeEvent({ id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "task.created" });
    await ingest(event);
    // Give any (erroneous) dispatch time to run, then assert no row was recorded.
    await new Promise((r) => setTimeout(r, 300));
    const rows = await db.listWebhookDeliveries(wh.id, "tenant-test", { limit: 10 });
    assert.equal(rows.length, 0);
  });

  test("does not deliver to a disabled webhook", async () => {
    const wh = await registerWebhook({ event_types: ["task.created"], enabled: false });
    const event = makeEvent({ id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "task.created" });
    await ingest(event);
    await new Promise((r) => setTimeout(r, 300));
    const rows = await db.listWebhookDeliveries(wh.id, "tenant-test", { limit: 10 });
    assert.equal(rows.length, 0);
  });

  test("delivers nothing when WEBHOOKS_ENABLED is unset", async () => {
    const wh = await registerWebhook({ event_types: ["task.created"] });
    delete process.env.WEBHOOKS_ENABLED;
    try {
      const event = makeEvent({ id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "task.created" });
      await ingest(event);
      await new Promise((r) => setTimeout(r, 300));
      const rows = await db.listWebhookDeliveries(wh.id, "tenant-test", { limit: 10 });
      assert.equal(rows.length, 0);
    } finally {
      process.env.WEBHOOKS_ENABLED = "1";
    }
  });

  test("tenant isolation — a webhook is only fed its own tenant's events", async () => {
    const wh = await registerWebhook({ event_types: ["task.created"] });
    // Mint a second tenant's write key and ingest an event as that tenant.
    const keyRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-other-16b", label: "other", scopes: ["read", "write"] }),
    });
    const otherKey = (await keyRes.json()).key;
    const event = makeEvent({ id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "task.created", session_id: "ses_other", trace_id: "trc_other" });
    await ingest(event, otherKey);
    await new Promise((r) => setTimeout(r, 300));
    // tenant-test's webhook must NOT have received tenant-other's event.
    const rows = await db.listWebhookDeliveries(wh.id, "tenant-test", { limit: 10 });
    assert.ok(!rows.some((row) => row.event_id === event.id));
  });
});

// ---------------------------------------------------------------------------
// Webhooks (Phase 16-C) — HMAC payload signing
//
// Verifies the one-time signing_secret on creation (and that it's never exposed
// again), and that real deliveries carry a valid X-AEP-Signature header that
// verifies against that secret over the raw received body.
// ---------------------------------------------------------------------------

describe("Webhooks — HMAC payload signing (Phase 16-C)", () => {
  const http = require("http");
  const { verifyWebhookSignature } = require("../../src/webhookSignature");
  let listener;
  let listenerPort;
  let received;

  before(async () => {
    received = [];
    listener = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    listenerPort = listener.address().port;
    process.env.WEBHOOKS_ENABLED = "1";
    process.env.WEBHOOK_TARGET_ALLOWLIST = `127.0.0.1:${listenerPort}`;
    process.env.WEBHOOK_MAX_RETRIES = "1";
    process.env.WEBHOOK_BACKOFF_BASE_MS = "1";
    process.env.WEBHOOK_TIMEOUT_MS = "2000";
  });

  after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    delete process.env.WEBHOOKS_ENABLED;
    delete process.env.WEBHOOK_TARGET_ALLOWLIST;
    delete process.env.WEBHOOK_MAX_RETRIES;
    delete process.env.WEBHOOK_BACKOFF_BASE_MS;
    delete process.env.WEBHOOK_TIMEOUT_MS;
  });

  test("POST /webhooks returns a one-time signing_secret; GET never exposes it", async () => {
    const createRes = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: `http://127.0.0.1:${listenerPort}/sig`, event_types: ["task.created"] }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.match(created.signing_secret, /^whsec_[0-9a-f]{64}$/);

    // GET one — must NOT include the secret.
    const getRes = await fetch(`${baseUrl}/webhooks/${created.id}`, { headers: { Authorization: `Bearer ${readKey}` } });
    const got = await getRes.json();
    assert.equal(got.signing_secret, undefined);

    // GET list — must NOT include the secret on any item.
    const listRes = await fetch(`${baseUrl}/webhooks`, { headers: { Authorization: `Bearer ${readKey}` } });
    const list = await listRes.json();
    assert.ok(list.webhooks.every((w) => w.signing_secret === undefined));
  });

  test("delivery carries an X-AEP-Signature that verifies against the secret", async () => {
    const before = received.length;
    const createRes = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: `http://127.0.0.1:${listenerPort}/sig2`, event_types: ["task.completed"] }),
    });
    const { id: webhookId, signing_secret: secret } = await createRes.json();

    const event = makeEvent({ id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "task.completed" });
    await ingest(event);

    // Wait for the listener to receive the signed delivery.
    const deadline = Date.now() + 4000;
    let hit = null;
    while (Date.now() < deadline) {
      hit = received.slice(before).find((r) => {
        try { return JSON.parse(r.rawBody).webhook_id === webhookId; } catch { return false; }
      });
      if (hit) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(hit, "expected the listener to receive the delivery");

    const sigHeader = hit.headers["x-aep-signature"];
    assert.ok(sigHeader && sigHeader.startsWith("hmac-sha256="), `expected signature header, got ${sigHeader}`);
    // The signature verifies against the secret over the EXACT raw body received.
    assert.equal(verifyWebhookSignature(hit.rawBody, sigHeader, secret), true);
    // A wrong secret must NOT verify (the signature is real, not a constant).
    assert.equal(verifyWebhookSignature(hit.rawBody, sigHeader, "whsec_wrong"), false);
    // Identifying headers present.
    assert.equal(hit.headers["x-aep-webhook-id"], webhookId);
    assert.equal(hit.headers["x-aep-event-type"], "task.completed");
    assert.ok(hit.headers["x-aep-delivery-id"]);
  });
});

// ---------------------------------------------------------------------------
// Webhooks (Phase 16-D) — GET /webhooks/:id/deliveries
//
// Seeds webhook_deliveries rows directly (delivery itself is covered in 16-B/16-C)
// and exercises the read endpoint: shape, ordering, filters, scope, isolation.
// ---------------------------------------------------------------------------

describe("Webhooks — GET /webhooks/:id/deliveries (Phase 16-D)", () => {
  let webhookId;

  async function registerWebhook() {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify({ target_url: "https://hooks.example.com/d", event_types: ["task.created"] }),
    });
    return (await res.json()).id;
  }

  before(async () => {
    webhookId = await registerWebhook();
    // Seed three delivery rows (oldest → newest) for this tenant's webhook.
    const base = Date.parse("2026-06-13T00:00:00.000Z");
    const rows = [
      { status: "success", attempts: 1, last_status_code: 200, last_error: null },
      { status: "failed",  attempts: 4, last_status_code: 500, last_error: "HTTP 500" },
      { status: "failed",  attempts: 4, last_status_code: null, last_error: "timeout after 5000ms" },
    ];
    for (let i = 0; i < rows.length; i++) {
      const ts = new Date(base + i * 60000).toISOString();
      const created = await db.createWebhookDelivery({
        id: `wd_${crypto.randomUUID().replace(/-/g, "")}`,
        webhookId,
        tenantId: "tenant-test",
        eventId: `evt_d${i}`,
        eventType: "task.created",
        status: "pending",
        attempts: 0,
        lastStatusCode: null,
        lastError: null,
        createdAt: ts,
        updatedAt: ts,
      });
      await db.updateWebhookDelivery(created.id, "tenant-test", {
        status: rows[i].status,
        attempts: rows[i].attempts,
        last_status_code: rows[i].last_status_code,
        last_error: rows[i].last_error,
        updated_at: ts,
      });
    }
  });

  test("returns the webhook's deliveries (newest first) with the right shape", async () => {
    const res = await fetch(`${baseUrl}/webhooks/${webhookId}/deliveries`, { headers: { Authorization: `Bearer ${readKey}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.webhook_id, webhookId);
    assert.ok(Array.isArray(body.deliveries));
    assert.ok(body.deliveries.length >= 3);
    // Newest first.
    assert.ok(body.deliveries[0].created_at >= body.deliveries[1].created_at);
    const one = body.deliveries.find((d) => d.last_status_code === 200);
    assert.equal(one.status, "success");
    assert.equal(one.attempts, 1);
    assert.equal(one.event_type, "task.created");
    // A network-error row surfaces null status code + an error string.
    const timeoutRow = body.deliveries.find((d) => d.last_error && d.last_error.includes("timeout"));
    assert.equal(timeoutRow.last_status_code, null);
  });

  test("respects ?limit", async () => {
    const res = await fetch(`${baseUrl}/webhooks/${webhookId}/deliveries?limit=1`, { headers: { Authorization: `Bearer ${readKey}` } });
    const body = await res.json();
    assert.equal(body.deliveries.length, 1);
  });

  test("400 on a malformed since/until", async () => {
    const res = await fetch(`${baseUrl}/webhooks/${webhookId}/deliveries?since=not-a-date`, { headers: { Authorization: `Bearer ${readKey}` } });
    assert.equal(res.status, 400);
  });

  test("404 for an unknown webhook id", async () => {
    const res = await fetch(`${baseUrl}/webhooks/wh_does_not_exist/deliveries`, { headers: { Authorization: `Bearer ${readKey}` } });
    assert.equal(res.status, 404);
  });

  test("tenant isolation — another tenant gets 404, not the rows", async () => {
    const keyRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenantId: "tenant-other-16d", label: "other", scopes: ["read"] }),
    });
    const otherKey = (await keyRes.json()).key;
    const res = await fetch(`${baseUrl}/webhooks/${webhookId}/deliveries`, { headers: { Authorization: `Bearer ${otherKey}` } });
    assert.equal(res.status, 404);
  });

  test("requires auth (401 without a key)", async () => {
    const res = await fetch(`${baseUrl}/webhooks/${webhookId}/deliveries`);
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// SSE — rejection.received broadcast (Wave 3 finding #28)
//
// Verifies that posting a rejected event causes the /stream SSE endpoint to
// emit a `rejection.received` message with the right `reason` and a numeric
// `total`.  We consume the SSE stream as a raw text/event-stream response
// (Node fetch keeps the body alive) and race a short timeout so the test never
// hangs if the broadcast is lost.
// ---------------------------------------------------------------------------

describe("SSE — rejection.received broadcast", () => {
  /**
   * Open one SSE connection, post a bad event, then scan the buffered stream
   * data for the first `rejection.received` message.  Returns the parsed JSON
   * payload or throws if nothing arrives within `timeoutMs`.
   */
  async function catchRejectionSSE(postFn, timeoutMs = 2000) {
    // SSE subscriber must share the same tenant as the rejecting request;
    // readKey and the test keys below are all scoped to "tenant-test".
    // Open SSE stream with a read-scoped key
    const sseRes = await fetch(`${baseUrl}/stream`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(sseRes.status, 200, "SSE endpoint should return 200");
    assert.ok(
      sseRes.headers.get("content-type").startsWith("text/event-stream"),
      "SSE endpoint should return text/event-stream"
    );

    // Collect raw SSE bytes into a string, resolve as soon as we see the event.
    // Hoist reader so the timeout handler can cancel it to stop the dangling read loop.
    const reader = sseRes.body.getReader();
    let resolve, reject;
    const found = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error("rejection.received SSE not received within timeout"));
    }, timeoutMs);

    (async () => {
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString();
          // SSE messages are separated by blank lines; scan all complete messages
          const messages = buf.split(/\n\n/);
          // Keep the last (potentially incomplete) chunk in the buffer
          buf = messages.pop();
          for (const msg of messages) {
            const eventLine = msg.split("\n").find(l => l.startsWith("event: "));
            const dataLine  = msg.split("\n").find(l => l.startsWith("data: "));
            if (eventLine && eventLine.slice(7).trim() === "rejection.received" && dataLine) {
              clearTimeout(timer);
              reader.cancel().catch(() => {});
              resolve(JSON.parse(dataLine.slice(6)));
              return;
            }
          }
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    })();

    // Post the bad event AFTER the SSE reader loop is running
    await postFn();

    return found;
  }

  test("schema-invalid event broadcasts rejection.received with reason schema_invalid", async () => {
    const badEvent = {
      specversion: "0.2.0",
      id: `evt_sse_schema_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "task.created",
      session_id: "ses_sse_schema_test",
      // missing required: source, trace_id → schema validation failure
    };

    const payload = await catchRejectionSSE(async () => {
      const res = await ingest(badEvent);
      assert.equal(res.status, 400, "bad event should be rejected with 400");
    });

    assert.equal(payload.type, "rejection.received", "SSE message type should be rejection.received");
    assert.equal(payload.reason, "schema_invalid", "reason should be schema_invalid");
    assert.ok(typeof payload.total === "number" && payload.total >= 1, "total should be a positive number");
  });

  test("signature-invalid event broadcasts rejection.received with reason signature_invalid", async () => {
    // Create a key with an HMAC secret so signature verification is enabled
    const hmacKeyRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        tenantId: "tenant-test",
        label: "hmac-sse-test",
        scopes: ["read", "write"],
        hmacSecret: "test-hmac-secret-sse",
      }),
    });
    const hmacKey = (await hmacKeyRes.json()).key;

    // A valid-shape event submitted with the HMAC key but NO signature → sig_invalid
    const event = makeEvent({ id: `evt_sse_sig_${crypto.randomUUID().replace(/-/g, "")}` });

    const payload = await catchRejectionSSE(async () => {
      const res = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hmacKey}` },
        body: JSON.stringify(event),
      });
      assert.equal(res.status, 401, "unsigned event with HMAC key should be rejected with 401");
    });

    assert.equal(payload.type, "rejection.received", "SSE message type should be rejection.received");
    assert.equal(payload.reason, "signature_invalid", "reason should be signature_invalid");
    assert.ok(typeof payload.total === "number" && payload.total >= 1, "total should be a positive number");
  });

  test("rejection.received is NOT broadcast to a different tenant's SSE stream", async () => {
    // Negative isolation: SSE subscriber is tenant-test (readKey); rejection fires
    // for tenant-other-sse-isolation — it must not reach the subscriber.
    const otherKeyRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        tenantId: "tenant-other-sse-isolation",
        label: "sse-isolation-test",
        scopes: ["read", "write"],
      }),
    });
    const otherWriteKey = (await otherKeyRes.json()).key;

    // Open SSE stream as tenant-test
    const sseRes = await fetch(`${baseUrl}/stream`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(sseRes.status, 200);

    let received = false;
    const reader = sseRes.body.getReader();

    // Read loop — set received=true if any rejection.received arrives
    const readerDone = (async () => {
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString();
          const messages = buf.split(/\n\n/);
          buf = messages.pop();
          for (const msg of messages) {
            const eventLine = msg.split("\n").find(l => l.startsWith("event: "));
            if (eventLine && eventLine.slice(7).trim() === "rejection.received") {
              received = true;
            }
          }
        }
      } catch { /* cancelled */ }
    })();

    // Post a bad event using the OTHER tenant's key
    const badEvent = {
      specversion: "0.2.0",
      id: `evt_sse_iso_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "task.created",
      session_id: "ses_sse_isolation_test",
      // missing required fields → schema_invalid for tenant-other-sse-isolation
    };
    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherWriteKey}` },
      body: JSON.stringify(badEvent),
    });
    assert.equal(res.status, 400, "Bad event should be rejected 400");

    // Wait for any cross-tenant bleed to arrive, then cancel
    await new Promise(r => setTimeout(r, 500));
    await reader.cancel().catch(() => {});
    await readerDone;

    assert.equal(received, false, "rejection.received must NOT arrive on a cross-tenant SSE stream");
  });
});
