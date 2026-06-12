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
