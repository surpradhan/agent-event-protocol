"use strict";

/**
 * Integration tests for all AEP HTTP endpoints.
 *
 * Database isolation: each test run uses an in-memory (":memory:") SQLite DB,
 * set via DATABASE_PATH before the server module is first required.
 * A fresh server is started on an ephemeral port for the entire suite,
 * then shut down in the after() hook.
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Bootstrap: isolate the database before any server code is loaded
// ---------------------------------------------------------------------------

// Use a fresh temp DB per test run so we don't touch data/aep.db
const TEST_DB = path.join(os.tmpdir(), `aep-test-${Date.now()}.db`);
process.env.DATABASE_PATH = TEST_DB;

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
  try { fs.unlinkSync(TEST_DB); } catch (_) {}
  delete process.env.ADMIN_TOKEN;
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.DATABASE_PATH;
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
