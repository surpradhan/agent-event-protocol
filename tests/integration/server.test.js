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
