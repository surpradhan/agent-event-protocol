"use strict";

const crypto  = require("crypto");
const express = require("express");
const path    = require("path");
const { version: SERVER_VERSION } = require("../package.json");

const { validateEvent, sanitizeInput }        = require("./validator");
const db                       = require("./db");
const { verifySignature } = require("./signature");
const { buildAuditBundle, verifyAuditBundle } = require("./audit");
const { renderAuditBundlePdf } = require("./audit-pdf");
const { summarizePolicyBlocked, toCsvAnalytics } = require("./analytics");
const { summarizePerformance } = require("./performance");
const { detectAnomalies } = require("./anomalies");
const { validateQuerySpec, runQuery } = require("./customQuery");
const { validateCreateWebhook, validateUpdateWebhook } = require("./webhooks");
const { scheduleDelivery } = require("./webhookDelivery");
const { generateSigningSecret } = require("./webhookSignature");
const { buildWorkflowGraph } = require("./workflowGraph");
const { generateComplianceReport, isValidFramework, FRAMEWORK_IDS } = require("./compliance");
const { renderComplianceReportPdf } = require("./compliance-pdf");
const { isPrunable } = require("./retention");
const { isValidRegion, normalizeRegion, getDeploymentRegion, isRegionEnforced } = require("./regions");
const {
  requireApiKey,
  requireReadAccess,
  requireDashboardAuth,
  requireAdminAuth,
  generateApiKey
} = require("./auth");
const logger                   = require("./logger");
const {
  metricsMiddleware,
  getPrometheusText,
  recordSignatureVerification,
  recordSignatureRejection,
  getSignatureMetrics
} = require("./metrics");
const { ingestRateLimit }      = require("./middleware/rateLimit");
const { enforceQuota, recordAccepted } = require("./middleware/quota");
const { TIER_NAMES, DEFAULT_TIER, getTierPolicy, isValidTier } = require("./tiers");
const { validateQueryParams, validatePathParams } = require("./middleware/queryValidation");
const { accessLog, isAccessLogEnabled } = require("./middleware/accessLog");

// ============================================================================
// Security helpers
// ============================================================================
// sanitizeInput is imported from validator.js above

/**
 * Validate that returned data belongs to the requesting tenant.
 * Defense-in-depth security check to prevent SQL injection or logic errors from exposing cross-tenant data.
 *
 * Array items without a tenant_id field are treated as safe (unscoped/system data).
 * Array items WITH a tenant_id field MUST match the requesting tenant.
 * Object data with tenant_id MUST match the requesting tenant.
 *
 * @param {object|null} data — the returned data from a database query
 * @param {string} requestedTenantId — the tenant making the request
 * @param {string} dataType — the type of data (for logging/errors)
 * @returns {boolean} true if data belongs to the tenant, false otherwise
 */
function validateTenantOwnership(data, requestedTenantId, dataType = "object") {
  if (!data) return true; // null/undefined is safe (will be 404'd by caller)

  // For collections (arrays), validate each item
  // Items without tenant_id are assumed to be system/unscoped data (safe)
  // Items WITH tenant_id must match the requesting tenant
  if (Array.isArray(data)) {
    return data.every(item => !item.tenant_id || item.tenant_id === requestedTenantId);
  }

  // For objects, check tenant_id field exists and matches
  if (data.tenant_id && data.tenant_id !== requestedTenantId) {
    logger.error(
      { requested_tenant: requestedTenantId, data_tenant: data.tenant_id, data_type: dataType },
      "SECURITY: Tenant isolation violation detected — returned data belongs to different tenant"
    );
    return false;
  }

  return true;
}

const app  = express();
const port = process.env.PORT || 8787;

// ---------------------------------------------------------------------------
// SSE connection limits
// ---------------------------------------------------------------------------
const MAX_SSE_CONNECTIONS = parseInt(process.env.MAX_SSE_CONNECTIONS || '1000', 10);
const MAX_SSE_PER_TENANT = parseInt(process.env.MAX_SSE_PER_TENANT || '100', 10);

// ---------------------------------------------------------------------------
// In-memory rejection log — last 200 rejected events (schema/signature fails)
// ---------------------------------------------------------------------------
const recentRejections = [];
const MAX_REJECTIONS   = 1000; // Cap in-memory rejection log to prevent unbounded memory growth
function pushRejection({ event_id, event_type, session_id, reason, detail, errors, tenant_id }) {
  recentRejections.push({
    id:         crypto.randomUUID(),
    ts:         new Date().toISOString(),
    event_id:   event_id   || null,
    event_type: event_type || null,
    session_id: session_id || null,
    tenant_id:  tenant_id  || "default",
    reason,
    detail:     detail || null,
    errors:     errors || null
  });
  if (recentRejections.length > MAX_REJECTIONS) recentRejections.shift();
  // Broadcast to SSE clients so the dashboard badge and metric card update in
  // real time without polling.  broadcastSse is defined later in this file but
  // pushRejection is only *called* from the /events handler (also later), so
  // the forward reference is safe at call-time.
  // tenant_id is always a concrete string from requireApiKey("write"); || "default"
  // matches the stored record at line 107 for consistency.
  // Note: GET /rejections with a dashboard token returns the unfiltered list;
  // SSE is always per-tenant since /stream requires an API key.
  const tenantId = tenant_id || "default";
  const perTenantTotal = recentRejections.filter(r => r.tenant_id === tenantId).length;
  broadcastSse(
    "rejection.received",
    { type: "rejection.received", reason, total: perTenantTotal },
    tenantId
  );
}

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

// Structured request logging + latency metrics (register before routes)
app.use(metricsMiddleware);
app.use(express.json({ limit: "1mb" }));

// Lightweight request log line for every response (skip SSE noise)
app.use((req, res, next) => {
  res.on("finish", () => {
    if (req.path === "/stream") return; // exclude long-lived SSE connections
    logger.info(
      {
        method:    req.method,
        path:      req.path,
        status:    res.statusCode,
        tenant_id: req.tenant_id || undefined
      },
      "http"
    );
  });
  next();
});

// API-key usage audit trail (Phase 14 PR-E) — opt-in via ACCESS_LOG_ENABLED.
// Registered after the request-log middleware so its own finish hook attaches
// early; it records only requests that resolve to an API key (set later by the
// per-route auth middleware, available by the time `finish` fires).
app.use(accessLog);

// ---------------------------------------------------------------------------
// Server-Sent Events — real-time push to dashboard clients
// Tracks: Map<tenantId, Map<connectionId, response>>
// Enforces per-tenant and global connection limits
// ---------------------------------------------------------------------------

const sseClients = new Map(); // Map<tenantId, Map<connectionId, response>>

// ---------------------------------------------------------------------------
// Helpers (pure, no I/O)
// ---------------------------------------------------------------------------

function escapeCsv(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes("\n") || str.includes("\"")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(events) {
  const headers = ["session_id", "trace_id", "time", "type", "id", "causation_id", "source", "payload"];
  const rows = events.map(e => [
    e.session_id,
    e.trace_id,
    e.time,
    e.type,
    e.id,
    e.causation_id || "",
    e.source,
    JSON.stringify(e.payload || {})
  ]);
  return [headers.join(","), ...rows.map(r => r.map(escapeCsv).join(","))].join("\n");
}

// ---------------------------------------------------------------------------
// Audit-bundle helpers (Phase 14 PR-B)
// ---------------------------------------------------------------------------

/**
 * Resolve the audit signing secret at request time, or send a 503 and return
 * null.  The audit-bundle endpoints sign every response, so they require
 * AUDIT_SIGNING_SECRET.  This mirrors how requireAdminAuth 503s when ADMIN_TOKEN
 * is unset (see src/auth.js) and the CLI's readAuditSecret (src/cli.js).
 *
 * @param {import('express').Response} res
 * @returns {string|null} the secret, or null after a 503 was already sent.
 */
function auditSecretOr503(res) {
  const secret = process.env.AUDIT_SIGNING_SECRET;
  if (!secret) {
    res.status(503).json({
      error: "Audit export not configured",
      hint:  "Set the AUDIT_SIGNING_SECRET environment variable to enable audit-bundle endpoints"
    });
    return null;
  }
  return secret;
}

/**
 * Flatten a workflow tree (array of root nodes from db.getWorkflow) into the
 * flat list of session_ids it contains.  Each node is { session, children }.
 *
 * @param {Array<{session: {session_id: string}, children: any[]}>} nodes
 * @returns {string[]}
 */
function collectSessionIds(nodes) {
  const ids = [];
  const walk = (node) => {
    if (!node || !node.session) return;
    ids.push(node.session.session_id);
    (node.children || []).forEach(walk);
  };
  (nodes || []).forEach(walk);
  return ids;
}

/**
 * Derive a single distinct trace_id from an event sequence, or null if the
 * events span zero or multiple traces.  Events carry a top-level trace_id;
 * tenant is intentionally NOT derived here (stored events don't reliably carry
 * it — the bundle's tenant scope comes from the authenticated req.tenant_id).
 *
 * @param {object[]} events
 * @returns {string|null}
 */
function singleTraceId(events) {
  const traces = new Set(events.map(e => e && e.trace_id).filter(Boolean));
  return traces.size === 1 ? [...traces][0] : null;
}

// ---------------------------------------------------------------------------
// Routes — public / health + OpenAPI + Swagger UI
// ---------------------------------------------------------------------------

/**
 * GET /health — liveness probe
 *
 * Returns HTTP 200 when the server process is running normally.
 * Returns HTTP 503 if the database is unreachable (degraded state).
 */
app.get("/health", async (_req, res) => {
  let dbOk = false;
  try {
    await db.ping();
    dbOk = true;
  } catch (err) {
    logger.error({ err }, "health check: DB query failed");
  }

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    ok:      dbOk,
    service: "aep-ingest",
    version: SERVER_VERSION,
    checks:  { db: dbOk ? "ok" : "error" }
  });
});

/**
 * GET /ready — readiness probe
 *
 * Returns HTTP 200 only when the service is fully initialised and ready to
 * accept traffic (DB connected + migrations complete).  Load balancers and
 * Kubernetes readiness probes should use this endpoint.
 */
app.get("/ready", async (_req, res) => {
  let dbOk = false;
  let tablesOk = false;
  try {
    await db.ping();
    dbOk = true;
    // Verify the schema is migrated by checking that the core schema exists.
    tablesOk = await db.schemaReady();
  } catch (err) {
    logger.error({ err }, "readiness check: DB query failed");
  }

  const ready  = dbOk && tablesOk;
  const status = ready ? 200 : 503;
  res.status(status).json({
    ready,
    checks: {
      db:     dbOk     ? "ok" : "error",
      schema: tablesOk ? "ok" : "error"
    }
  });
});

// Serve the OpenAPI spec as JSON
app.get("/openapi.json", (_req, res) => {
  // Use the `root` option rather than a full absolute path: under Express 5,
  // send() applies its dotfiles policy (default "ignore") to the whole resolved
  // path when no root is set, so an absolute path containing a dot-directory
  // (e.g. a `.claude/worktrees/...` checkout) 404s. The root prefix is trusted
  // and exempt from that check; only the filename is policy-checked.
  res.sendFile("openapi.json", { root: __dirname });
});

// Serve Swagger UI (via CDN) — no local bundle required
app.get("/docs", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AEP API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "/openapi.json",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      deepLinking: true
    });
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Routes — dashboard (browser UI)
// ---------------------------------------------------------------------------

app.get("/dashboard", requireDashboardAuth, (_req, res) => {
  // See /openapi.json above: pass a `root` so Express 5's send() dotfiles policy
  // doesn't 404 the file when the checkout path contains a dot-directory.
  res.sendFile("dashboard.html", { root: path.join(__dirname, "public") });
});

// Static assets served from public/
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Routes — read endpoints (require API key OR dashboard token)
// ---------------------------------------------------------------------------

/**
 * GET /sessions
 *
 * Query params:
 *   limit   — page size (1–500, default 50)
 *   cursor  — opaque pagination token from a previous response's next_cursor
 *
 * Response: { sessions: [...], next_cursor: string|null }
 */
app.get("/sessions", requireReadAccess, validateQueryParams, async (req, res) => {
  const { limit, cursor } = req.query;
  const result = await db.getPaginatedSessions(req.tenant_id, { limit, cursor });

  // Validate tenant ownership of returned sessions (defense-in-depth)
  if (!validateTenantOwnership(result.sessions, req.tenant_id, "sessions_list")) {
    return res.status(403).json({ error: "Forbidden", message: "You do not have access to these sessions" });
  }

  res.json({ sessions: result.sessions, next_cursor: result.next_cursor });
});

/**
 * GET /sessions/:sessionId
 *
 * Returns metadata for a single session (scoped to the caller's tenant), or
 * 404 if it does not exist. Response shape matches each entry of GET /sessions:
 *   { session_id, trace_id, source, parent_session_id, agent_role,
 *     event_count, started_at, updated_at }
 */
app.get("/sessions/:sessionId", requireReadAccess, validatePathParams, async (req, res) => {
  const session = await db.getSession(req.params.sessionId, req.tenant_id);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json(session);
});

/**
 * GET /sessions/:sessionId/events
 *
 * Query params:
 *   type    — filter by event type (exact match)
 *   q       — free-text search across id, type, causation_id, payload
 *   limit   — page size (1–1000, default 100)
 *   cursor  — opaque pagination token from a previous response's next_cursor
 *
 * Response: { session_id, events: [...], next_cursor: string|null }
 *
 * Note: when `q` is combined with pagination the in-memory text filter is
 * applied after the cursor window, so a page may contain fewer than `limit`
 * items; iterate until next_cursor is null.
 */
app.get("/sessions/:sessionId/events", requireReadAccess, validatePathParams, validateQueryParams, async (req, res) => {
  // validateQueryParams coerces any repeated param (?type=a&type=b) to a single
  // value (last wins) before this handler runs, so type/q/limit/cursor are scalars.
  const { type = "", q = "", limit, cursor } = req.query;
  const result = await db.getPaginatedEvents(req.params.sessionId, {
    type, q, tenantId: req.tenant_id, limit, cursor
  });

  // Validate tenant ownership of returned events (defense-in-depth against SQL injection)
  if (!validateTenantOwnership(result.events, req.tenant_id, "session_events")) {
    return res.status(403).json({ error: "Forbidden", message: "You do not have access to this session" });
  }

  res.json({
    session_id:  req.params.sessionId,
    events:      result.events,
    next_cursor: result.next_cursor
  });
});

// GET /sessions/:sessionId/tree — session and all descendants as a recursive tree
app.get("/sessions/:sessionId/tree", requireReadAccess, validatePathParams, async (req, res) => {
  const tree = await db.getSessionTree(req.params.sessionId, req.tenant_id);
  if (!tree) {
    return res.status(404).json({ error: "Session not found", session_id: req.params.sessionId });
  }

  // Validate tenant ownership (defense-in-depth against SQL injection or logic errors)
  if (!validateTenantOwnership(tree, req.tenant_id, "session_tree")) {
    return res.status(403).json({ error: "Forbidden", message: "You do not have access to this session" });
  }

  res.json(tree);
});

// GET /sessions/:sessionId/export — download as JSON or CSV
app.get("/sessions/:sessionId/export", requireReadAccess, validatePathParams, validateQueryParams, async (req, res) => {
  const sessionId = req.params.sessionId;
  // validateQueryParams coerces any repeated param (?format=csv&format=json) to a
  // single value (last wins) before this handler, so format/type/q are scalars.
  // Routing through it also newly applies the shared q/type length + cursor/limit
  // 400s to /export (parity with /events). /export ignores cursor/limit, so a
  // VALID one is a no-op — but an INVALID ?cursor=/?limit= now 400s instead of
  // being silently ignored. Intentional (no legitimate export client sends them).
  const format = (req.query.format || "json").toLowerCase();
  const { type = "", q = "" } = req.query;
  const events = await db.getSessionEvents(sessionId, { type, q, tenantId: req.tenant_id });

  // Validate tenant ownership of events (defense-in-depth against SQL injection)
  if (!validateTenantOwnership(events, req.tenant_id, "session_events")) {
    return res.status(403).json({ error: "Forbidden", message: "You do not have access to this session" });
  }

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${sessionId}-events.csv"`);
    return res.send(toCsv(events));
  }

  res.setHeader("Content-Disposition", `attachment; filename="${sessionId}-events.json"`);
  return res.json({ session_id: sessionId, events });
});

// GET /workflows/:traceId — all sessions sharing a trace_id assembled into a tree
app.get("/workflows/:traceId", requireReadAccess, validatePathParams, async (req, res) => {
  const workflow = await db.getWorkflow(req.params.traceId, req.tenant_id);
  if (!workflow) {
    return res.status(404).json({ error: "Workflow not found", trace_id: req.params.traceId });
  }

  // Validate tenant ownership (defense-in-depth against SQL injection or logic errors)
  if (!validateTenantOwnership(workflow, req.tenant_id, "workflow")) {
    return res.status(403).json({ error: "Forbidden", message: "You do not have access to this workflow" });
  }

  res.json(workflow);
});

// GET /workflows/:traceId/graph — cross-session causation graph (Phase 15-C).
//
// The dashboard's per-session DAG can only show cross-session causation as dangling
// stubs.  This assembles the whole trace's event-level causation graph (every event
// across every session), classifying edges as intra- vs cross-session, so the
// dashboard can render one interactive DAG spanning the workflow.  Read- + tenant-
// scoped exactly like /workflows/:traceId; the DB returns the raw (tenant-scoped)
// envelopes and the pure buildWorkflowGraph (src/workflowGraph.js) shapes them.
app.get("/workflows/:traceId/graph", requireReadAccess, validatePathParams, async (req, res) => {
  const traceId = req.params.traceId;

  // 404 iff the trace has no sessions for this tenant — same semantics as
  // /workflows/:traceId (reuses the same tenant-scoped session lookup).
  const workflow = await db.getWorkflow(traceId, req.tenant_id);
  if (!workflow) {
    return res.status(404).json({ error: "Workflow not found", trace_id: traceId });
  }

  const events = await db.getWorkflowEvents(traceId, req.tenant_id);
  const graph = buildWorkflowGraph(events, { trace_id: traceId, now: new Date() });
  res.json(graph);
});

// ---------------------------------------------------------------------------
// Routes — audit bundles (Phase 14 PR-B; ?format=pdf added in PR-C)
//
// Tamper-evident, HMAC-signed JSON bundles built from the read API's events via
// buildAuditBundle (src/audit.js).  Read-scoped + tenant-scoped exactly like the
// sibling /export and /workflows/:traceId endpoints.  `now` is injected here so
// audit.js stays pure.  Both sign their response, so both require
// AUDIT_SIGNING_SECRET (→ 503 when unset).
// ---------------------------------------------------------------------------

/**
 * Send a freshly built audit bundle in the requested representation.
 * `?format=pdf` → human-readable PDF report (the JSON bundle remains the
 * verifiable artifact; the PDF prints the digest to tie back to it).  Any other
 * value — including absent — falls back to JSON, mirroring /export's format
 * handling (unrecognized values are not a 400 there either).
 */
function sendAuditBundle(req, res, bundle, secret, baseName) {
  const format = (typeof req.query.format === "string" ? req.query.format : "json").toLowerCase();
  if (format === "pdf") {
    // Freshly built → expected valid; verified for real (cheap) so the PDF's
    // verification section reports an actual check, not an assertion.  One
    // clock read shared by both calls, so rendered_at matches the verify
    // instant.  Like the JSON path, rendering is unpaginated and in-memory
    // (~0.4ms/event, linear) — a bundle must be complete to be meaningful, and
    // the endpoint is read-key-gated; same trade-off as the workflow handler.
    const now = new Date();
    const verification = verifyAuditBundle(bundle, secret, { now });
    return renderAuditBundlePdf(bundle, { verification, now }).then((pdf) => {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${baseName}-audit-bundle.pdf"`);
      res.send(pdf);
    });
  }
  res.setHeader("Content-Disposition", `attachment; filename="${baseName}-audit-bundle.json"`);
  return res.json(bundle);
}

// GET /sessions/:sessionId/audit-bundle — signed audit bundle for one session
app.get("/sessions/:sessionId/audit-bundle", requireReadAccess, validatePathParams, async (req, res) => {
  const secret = auditSecretOr503(res);
  if (!secret) return;

  const sessionId = req.params.sessionId;

  // 404 iff the session does not exist for this tenant (scope-nonexistent rule).
  // A real session with zero events still yields an empty — but signed — bundle.
  const session = await db.getSession(sessionId, req.tenant_id);
  if (!session) {
    return res.status(404).json({ error: "Session not found", session_id: sessionId });
  }

  const events = await db.getSessionEvents(sessionId, { tenantId: req.tenant_id });

  // Defense-in-depth: never bundle events belonging to another tenant.
  if (!validateTenantOwnership(events, req.tenant_id, "session_events")) {
    return res.status(403).json({ error: "Forbidden", message: "You do not have access to this session" });
  }

  const derivedTraceId = singleTraceId(events);
  const bundle = buildAuditBundle({
    events,
    meta: {
      session_id: sessionId,
      ...(derivedTraceId ? { trace_id: derivedTraceId } : {}),
      tenant_id: req.tenant_id ?? null,
      // Phase 14 PR-G: null when DATA_RESIDENCY_REGION is unset → no manifest field.
      data_residency_region: getDeploymentRegion()
    },
    secret,
    now: new Date()
  });

  return sendAuditBundle(req, res, bundle, secret, sessionId);
});

// GET /workflows/:traceId/audit-bundle — signed audit bundle for a whole trace
app.get("/workflows/:traceId/audit-bundle", requireReadAccess, validatePathParams, async (req, res) => {
  const secret = auditSecretOr503(res);
  if (!secret) return;

  const traceId = req.params.traceId;

  // 404 iff the trace does not exist for this tenant — same as /workflows/:traceId.
  const workflow = await db.getWorkflow(traceId, req.tenant_id);
  if (!workflow) {
    return res.status(404).json({ error: "Workflow not found", trace_id: traceId });
  }

  // Collect every session in the trace, fetch each session's (tenant-scoped)
  // events, then order the combined sequence by time. A bundle must hold ALL
  // events for the trace to be verifiable, so there is no pagination here; if any
  // per-session fetch rejects, the whole request fails rather than emit a partial
  // bundle. Sort by the ISO `time` string with a plain comparator — the same
  // codepoint ordering the DB uses (ORDER BY time ASC), not locale-sensitive.
  //
  // The bundle covers exactly the session set of the `/workflows/:traceId` tree.
  // getWorkflow derives roots as sessions whose parent is absent or outside the
  // trace; a pathological all-in-trace parent cycle would leave those sessions
  // unrooted and thus out of the tree (and the bundle) — the same blind spot the
  // /workflows view has. Acceptable: such a bundle is incomplete, never wrong.
  const sessionIds = collectSessionIds(workflow.tree);
  const perSession = await Promise.all(
    sessionIds.map(sid => db.getSessionEvents(sid, { tenantId: req.tenant_id }))
  );
  const events = perSession
    .flat()
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  // Defense-in-depth: never bundle events belonging to another tenant.
  if (!validateTenantOwnership(events, req.tenant_id, "workflow_events")) {
    return res.status(403).json({ error: "Forbidden", message: "You do not have access to this workflow" });
  }

  const bundle = buildAuditBundle({
    events,
    meta: {
      trace_id: traceId,
      tenant_id: req.tenant_id ?? null,
      // Phase 14 PR-G: null when DATA_RESIDENCY_REGION is unset → no manifest field.
      data_residency_region: getDeploymentRegion()
    },
    secret,
    now: new Date()
  });

  return sendAuditBundle(req, res, bundle, secret, traceId);
});

// ---------------------------------------------------------------------------
// Route — compliance report templates (Phase 14 PR-F)
//
// Maps AEP's live evidence (audit bundles + HMAC signatures, the API-key access
// log, policy.blocked analytics, tenant isolation + key scopes, retention, the
// causation-linked event store) onto the control areas of SOC 2 / HIPAA / GDPR /
// EU AI Act. Read-scoped + tenant-scoped. The pure generator lives in
// src/compliance.js; this handler only assembles the evidence object.
// ---------------------------------------------------------------------------

/**
 * Assemble the evidence facets a compliance report is derived from, scoped to the
 * requesting tenant. An optional `session`/`trace` adds a concrete integrity
 * proof-point (a freshly built audit bundle for that scope is verified); the
 * monitoring / record-keeping counts are tenant-wide posture.
 */
async function assembleComplianceEvidence(req, { session, trace, since, until }) {
  const tenantId = req.tenant_id;

  const metrics = await db.getMetrics(tenantId);
  const totalEvents = metrics.accepted || 0;
  const distinctTypes = Object.keys(metrics.byType || {}).length;

  const policyBlocked = await db.getPolicyBlockedEvents(tenantId, { since, until });

  const signingConfigured = !!process.env.AUDIT_SIGNING_SECRET;
  const accessLogEnabled = isAccessLogEnabled();

  // Retention posture from the requesting key's project.
  let retentionConfigured = false;
  let retentionDays = null;
  const project = await db.getProject(req.project_id || "default");
  if (project) {
    retentionDays = project.retention_days ?? null;
    retentionConfigured = isPrunable(retentionDays);
  }

  // Integrity proof-point: when signing is configured AND a session/trace scope is
  // named, build a bundle for it and verify it. Otherwise bundle_verified stays
  // null (the capability is reported via signing_configured).
  //
  // Note (intentional non-404): a session/trace that does not exist for the
  // tenant simply leaves bundle_verified null — the scope is an OPTIONAL integrity
  // proof-point, not the resource being fetched, so (unlike /sessions/:id/audit-
  // bundle) a missing/typo'd scope yields a weaker proof rather than a 404.
  let bundleVerified = null;
  let perEventSignatures = { present: 0, total: 0 };
  if (signingConfigured && (session || trace)) {
    const secret = process.env.AUDIT_SIGNING_SECRET;
    let events = null;
    let meta = null;
    if (session) {
      const s = await db.getSession(session, tenantId);
      if (s) {
        events = await db.getSessionEvents(session, { tenantId });
        meta = { session_id: session, tenant_id: tenantId ?? null };
      }
    } else {
      const wf = await db.getWorkflow(trace, tenantId);
      if (wf) {
        const sids = collectSessionIds(wf.tree);
        const perSession = await Promise.all(
          sids.map(sid => db.getSessionEvents(sid, { tenantId }))
        );
        events = perSession.flat().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
        meta = { trace_id: trace, tenant_id: tenantId ?? null };
      }
    }
    if (events && validateTenantOwnership(events, tenantId, "compliance_events")) {
      const now = new Date();
      const bundle = buildAuditBundle({ events, meta, secret, now });
      bundleVerified = verifyAuditBundle(bundle, secret, { now }).valid;
      perEventSignatures = bundle.manifest.per_event_signatures || perEventSignatures;
    }
  }

  return {
    access_control: { api_key_auth: true, scopes_enforced: true, tenant_isolation: true },
    access_log: { enabled: accessLogEnabled },
    integrity: {
      signing_configured: signingConfigured,
      bundle_verified: bundleVerified,
      per_event_signatures: perEventSignatures
    },
    monitoring: {
      policy_blocked_count: policyBlocked.length,
      total_events: totalEvents,
      distinct_event_types: distinctTypes
    },
    retention: { configured: retentionConfigured, retention_days: retentionDays },
    // trace_id is a REQUIRED envelope field (v0.2.0), so any in-scope event is
    // trace-linked — has_trace_ids = "events exist" is accurate, not a proxy. We
    // deliberately do NOT claim has_causation_links here: causation_id is optional
    // and we don't scan for it, so it stays at its conservative default (false)
    // rather than over-claiming (no transparency control depends on it).
    causation: { has_trace_ids: totalEvents > 0 },
    record_keeping: { total_events: totalEvents, audit_export_available: signingConfigured }
  };
}

/**
 * GET /compliance/report — a framework-mapped compliance report.
 *
 * Query params:
 *   framework — REQUIRED: soc2 | hipaa | gdpr | eu_ai_act
 *   session / trace — optional integrity proof-point scope (at most one)
 *   since / until — optional ISO-8601 window for the policy-enforcement evidence
 *   format — json (default) | pdf
 */
app.get("/compliance/report", requireReadAccess, validateQueryParams, async (req, res) => {
  const framework = typeof req.query.framework === "string" ? req.query.framework.toLowerCase() : "";
  if (!isValidFramework(framework)) {
    return res.status(400).json({
      error: "Bad Request",
      message: `Query parameter 'framework' is required and must be one of: ${FRAMEWORK_IDS.join(", ")}`
    });
  }

  const session = typeof req.query.session === "string" ? req.query.session : undefined;
  const trace = typeof req.query.trace === "string" ? req.query.trace : undefined;
  if (session && trace) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Specify at most one of 'session' or 'trace'"
    });
  }

  const since = parseIsoBound(req.query.since);
  const until = parseIsoBound(req.query.until);
  if (!since.ok || !until.ok) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Query parameters 'since' and 'until' must be ISO-8601 timestamps"
    });
  }

  const evidence = await assembleComplianceEvidence(req, {
    session,
    trace,
    since: since.value,
    until: until.value
  });

  const now = new Date();
  const report = generateComplianceReport(framework, evidence, {
    now,
    scope: {
      tenant_id: req.tenant_id ?? null,
      ...(session ? { session_id: session } : {}),
      ...(trace ? { trace_id: trace } : {}),
      since: since.value,
      until: until.value
    }
  });

  const format = (typeof req.query.format === "string" ? req.query.format : "json").toLowerCase();
  if (format === "pdf") {
    const pdf = await renderComplianceReportPdf(report, { now });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="compliance-${framework}.pdf"`);
    return res.send(pdf);
  }
  return res.json(report);
});

// GET /metrics — counters + session count + workflow metrics (JSON)
app.get("/metrics", requireReadAccess, async (req, res) => {
  const dbStats = await db.getMetrics(req.tenant_id);
  // Signature-form telemetry (issue #65) is process-wide / server-scoped, not
  // tenant-filtered — surfaced alongside the DB counters for convenience.
  res.json({ ...dbStats, signatures: getSignatureMetrics() });
});

// ---------------------------------------------------------------------------
// Route — policy-enforcement analytics (Phase 14 PR-D)
//
// Aggregates `policy.blocked` events into the compliance view "what did the
// agent refuse to do, and when?" (PRD §Phase 14).  Read-scoped + tenant-scoped
// exactly like /metrics and the sibling read endpoints.  The DB returns the raw
// (tenant-scoped, time-windowed) envelopes; the pure summarizePolicyBlocked
// (src/analytics.js) shapes them, so the SQL stays trivial on both backends.
// ---------------------------------------------------------------------------

/**
 * Parse an optional ISO-8601 ?since / ?until bound.
 * @param {*} raw  req.query value (already coerced to a scalar by validateQueryParams)
 * @returns {{ ok: boolean, value: string|null }}
 */
function parseIsoBound(raw) {
  if (raw === undefined) return { ok: true, value: null };
  const s = String(raw);
  // Date.parse accepts ISO-8601; reject anything it can't parse so a typo is a
  // 400 rather than a silently-ignored filter.
  if (Number.isNaN(Date.parse(s))) return { ok: false, value: null };
  return { ok: true, value: s };
}

/**
 * GET /analytics/policy-blocked — policy.blocked event analytics.
 *
 * Query params (all optional):
 *   since — ISO-8601 inclusive lower bound on event time (time >= since)
 *   until — ISO-8601 exclusive upper bound on event time (time <  until)
 *   limit — max entries in the `recent` list (1–1000, default 20)
 *
 * Tenant-scoped from the API key; no cross-tenant leakage.
 */
app.get("/analytics/policy-blocked", requireReadAccess, validateQueryParams, async (req, res) => {
  const since = parseIsoBound(req.query.since);
  const until = parseIsoBound(req.query.until);
  if (!since.ok || !until.ok) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Query parameters 'since' and 'until' must be ISO-8601 timestamps"
    });
  }

  const events = await db.getPolicyBlockedEvents(req.tenant_id, {
    since: since.value,
    until: until.value
  });

  // validateQueryParams already bounds ?limit to [1,1000]; default the recent
  // list to 20 when the caller omits it.
  const limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 20;
  const summary = summarizePolicyBlocked(events, { now: new Date(), limit });

  const format = (req.query.format || "json").toLowerCase();
  if (format !== "json" && format !== "csv") {
    return res.status(400).json({ error: "Bad Request", message: "Query parameter 'format' must be 'json' or 'csv'" });
  }
  if (format === "csv") {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="policy-blocked-${date}.csv"`);
    // Flatten the summary into tabular rows: one row per recent event.
    const fields = ["id", "time", "source", "session_id", "trace_id", "agent_role", "policy", "reason", "action_blocked"];
    return res.send(toCsvAnalytics(summary.recent, fields));
  }

  res.json({ ...summary, window: { since: since.value, until: until.value } });
});

/**
 * GET /analytics/performance — latency / performance profiling (Phase 15-A).
 *
 * Pairs lifecycle events into operations (tool.called→tool.result,
 * task.created→task.completed|failed) and reports p50/p95/p99 latency sliced by
 * tool, agent (source), session, and operation type — "latency breakdown per
 * agent, per tool, per event type" (PRD §Phase 15).  The DB returns the raw
 * (tenant-scoped, time-windowed) envelopes; the pure summarizePerformance
 * (src/performance.js) shapes them, so the SQL stays trivial on both backends.
 *
 * Query params (all optional):
 *   since — ISO-8601 inclusive lower bound on event time (time >= since)
 *   until — ISO-8601 exclusive upper bound on event time (time <  until)
 *   limit — max entries in the `slowest` list (1–1000, default 20)
 *
 * Tenant-scoped from the API key; no cross-tenant leakage.
 */
app.get("/analytics/performance", requireReadAccess, validateQueryParams, async (req, res) => {
  const since = parseIsoBound(req.query.since);
  const until = parseIsoBound(req.query.until);
  if (!since.ok || !until.ok) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Query parameters 'since' and 'until' must be ISO-8601 timestamps"
    });
  }

  const events = await db.getPerformanceEvents(req.tenant_id, {
    since: since.value,
    until: until.value
  });

  // validateQueryParams already bounds ?limit to [1,1000]; default the slowest
  // list to 20 when the caller omits it.
  const limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 20;
  const summary = summarizePerformance(events, { now: new Date(), limit });

  const format = (req.query.format || "json").toLowerCase();
  if (format !== "json" && format !== "csv") {
    return res.status(400).json({ error: "Bad Request", message: "Query parameter 'format' must be 'json' or 'csv'" });
  }
  if (format === "csv") {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="performance-${date}.csv"`);
    // Flatten the summary into tabular rows: one row per slowest operation.
    const fields = ["kind", "op_type", "name", "source", "session_id", "trace_id", "status", "duration_ms", "started_at", "ended_at"];
    return res.send(toCsvAnalytics(summary.slowest, fields));
  }

  res.json({ ...summary, window: { since: since.value, until: until.value } });
});

/**
 * GET /analytics/anomalies — workflow anomaly detection (Phase 15-D).
 *
 * Flags traces whose error-rate / policy.blocked-volume / latency deviates from
 * the per-tenant cross-trace baseline by more than `threshold` robust modified-z
 * (median/MAD) — "alert when a workflow deviates from expected patterns"
 * (PRD §Phase 15).  Read- + tenant-scoped; reuses the window event fetch and the
 * pure detectAnomalies (src/anomalies.js) shaper.
 *
 * Query params (all optional):
 *   since      — ISO-8601 inclusive lower bound on event time (time >= since)
 *   until      — ISO-8601 exclusive upper bound on event time (time <  until)
 *   threshold  — modified-z cutoff (> 0, default 3.5; smaller = more sensitive)
 *   limit      — max anomalies returned (1–1000, default 50)
 */
app.get("/analytics/anomalies", requireReadAccess, validateQueryParams, async (req, res) => {
  const since = parseIsoBound(req.query.since);
  const until = parseIsoBound(req.query.until);
  if (!since.ok || !until.ok) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Query parameters 'since' and 'until' must be ISO-8601 timestamps"
    });
  }

  // `threshold` is a positive float (modified-z cutoff). validateQueryParams does
  // not range-check it, so guard here: reject a non-positive / non-numeric value.
  let threshold;
  if (req.query.threshold !== undefined) {
    threshold = Number(req.query.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Query parameter 'threshold' must be a positive number"
      });
    }
  }

  const events = await db.getEventsForQuery(req.tenant_id, {
    since: since.value,
    until: until.value
  });

  // validateQueryParams already bounds ?limit to [1,1000]; default to 50.
  const limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 50;
  const result = detectAnomalies(events, { now: new Date(), threshold, limit });

  const format = (req.query.format || "json").toLowerCase();
  if (format !== "json" && format !== "csv") {
    return res.status(400).json({ error: "Bad Request", message: "Query parameter 'format' must be 'json' or 'csv'" });
  }
  if (format === "csv") {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="anomalies-${date}.csv"`);
    // Flatten the anomaly list: one row per anomalous trace; nested metrics/flags as JSON.
    const fields = ["trace_id", "max_score", "severity", "metrics", "flags"];
    return res.send(toCsvAnalytics(result.anomalies, fields));
  }

  res.json({ ...result, window: { since: since.value, until: until.value } });
});

// ---------------------------------------------------------------------------
// Routes — custom analytics: user-defined queries (Phase 15-B)
//
// A query is a structured JSON *spec* (filters + group_by + aggregations +
// window), NOT SQL.  validateQuerySpec enforces a field/operator whitelist and a
// prototype-pollution guard; runQuery (src/customQuery.js) executes it purely in
// JS over the tenant-scoped, time-windowed raw envelopes the DB returns — so there
// is no injection surface and no SQLite-vs-Postgres divergence.  Queries can be run
// ad-hoc or saved to a per-tenant library and re-run by id.
//
// Note: getEventsForQuery loads the tenant's events in the [since, until) window
// into memory before aggregating (the same fetch-then-aggregate model as the other
// analytics endpoints).  `since`/`until` are therefore the way to bound the working
// set on a large tenant; callers querying big stores should always supply them.
// ---------------------------------------------------------------------------

/**
 * Run a validated spec against the caller's tenant and shape the response.
 * Shared by the ad-hoc and saved-query-run routes.
 */
async function executeCustomQuery(tenantId, spec) {
  const events = await db.getEventsForQuery(tenantId, {
    since: spec.since,
    until: spec.until
  });
  return runQuery(events, spec, { now: new Date() });
}

/**
 * POST /analytics/query — run an ad-hoc custom-analytics query.
 * Body: a query spec (see src/customQuery.js). Read- + tenant-scoped.
 */
app.post("/analytics/query", requireReadAccess, async (req, res) => {
  const { ok, errors, normalized } = validateQuerySpec(req.body);
  if (!ok) {
    return res.status(400).json({ error: "Bad Request", message: "Invalid query spec", details: errors });
  }
  const result = await executeCustomQuery(req.tenant_id, normalized);
  res.json(result);
});

/**
 * POST /analytics/saved-queries — save a named query to the tenant's library.
 * Body: { name, spec }. Requires a WRITE-scoped key (mutates tenant data).
 * 400 invalid spec/name, 409 duplicate name.
 */
app.post("/analytics/saved-queries", requireApiKey("write"), async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return res.status(400).json({ error: "Bad Request", message: "A non-empty 'name' is required" });
  }
  if (name.length > 120) {
    return res.status(400).json({ error: "Bad Request", message: "'name' must be ≤ 120 characters" });
  }
  const { ok, errors, normalized } = validateQuerySpec(body.spec);
  if (!ok) {
    return res.status(400).json({ error: "Bad Request", message: "Invalid query spec", details: errors });
  }

  const now = new Date().toISOString();
  try {
    const saved = await db.createSavedQuery({
      id: `sq_${crypto.randomUUID().replace(/-/g, "")}`,
      tenantId: req.tenant_id,
      name,
      spec: normalized,
      createdAt: now,
      updatedAt: now
    });
    res.status(201).json(saved);
  } catch (err) {
    if (err && err.code === "SAVED_QUERY_CONFLICT") {
      return res.status(409).json({ error: "Conflict", message: err.message });
    }
    throw err;
  }
});

/**
 * GET /analytics/saved-queries — list the tenant's saved queries (newest first).
 */
app.get("/analytics/saved-queries", requireReadAccess, async (req, res) => {
  const queries = await db.listSavedQueries(req.tenant_id);
  res.json({ saved_queries: queries });
});

/**
 * GET /analytics/saved-queries/:id — fetch one saved query (tenant-scoped). 404 if absent.
 */
app.get("/analytics/saved-queries/:id", requireReadAccess, validatePathParams, async (req, res) => {
  const saved = await db.getSavedQuery(req.params.id, req.tenant_id);
  if (!saved) return res.status(404).json({ error: "Not Found", message: "Saved query not found" });
  res.json(saved);
});

/**
 * POST /analytics/saved-queries/:id/run — run a saved query by id (tenant-scoped).
 * Re-validates the stored spec defensively before executing. 404 if absent.
 */
app.post("/analytics/saved-queries/:id/run", requireReadAccess, validatePathParams, async (req, res) => {
  const saved = await db.getSavedQuery(req.params.id, req.tenant_id);
  if (!saved) return res.status(404).json({ error: "Not Found", message: "Saved query not found" });
  const { ok, errors, normalized } = validateQuerySpec(saved.spec);
  if (!ok) {
    return res.status(422).json({ error: "Unprocessable Entity", message: "Stored query spec is invalid", details: errors });
  }
  const result = await executeCustomQuery(req.tenant_id, normalized);
  res.json({ ...result, saved_query: { id: saved.id, name: saved.name } });
});

/**
 * DELETE /analytics/saved-queries/:id — remove a saved query (tenant-scoped).
 * Requires a WRITE-scoped key. 404 if absent.
 */
app.delete("/analytics/saved-queries/:id", requireApiKey("write"), validatePathParams, async (req, res) => {
  const removed = await db.deleteSavedQuery(req.params.id, req.tenant_id);
  if (!removed) return res.status(404).json({ error: "Not Found", message: "Saved query not found" });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Webhooks (Phase 16-A) — registration & management
//
// A webhook is a tenant-scoped outbound endpoint: a target URL plus an event-type
// filter. Registration only here; delivery (16-B) and signing (16-C) build on it.
// The target URL is validated by the SSRF guard (src/ssrf.js) at registration —
// loopback/private/link-local targets are rejected — and again at delivery time.
// Self-hosters can permit specific private targets via WEBHOOK_TARGET_ALLOWLIST
// (comma-separated host or host:port entries).
// ---------------------------------------------------------------------------

/** The configured allowlist of host[:port] targets that bypass the private-range block. */
function webhookAllowlist() {
  return process.env.WEBHOOK_TARGET_ALLOWLIST || "";
}

/**
 * POST /webhooks — register a webhook. Requires a WRITE-scoped key.
 * Body: { target_url, event_types?, enabled? }. 400 on invalid URL/filter/SSRF.
 */
app.post("/webhooks", requireApiKey("write"), async (req, res) => {
  const result = validateCreateWebhook(req.body, { allowlist: webhookAllowlist() });
  if (!result.ok) {
    return res.status(400).json({ error: "Bad Request", message: "Invalid webhook", details: result.errors });
  }
  const now = new Date().toISOString();
  // Mint a per-webhook signing secret (Phase 16-C). It is returned to the caller
  // exactly ONCE here, and never again — GET/list responses omit it (the delivery
  // engine reads it internally via getWebhookSigningSecret to sign payloads).
  const signingSecret = generateSigningSecret();
  const saved = await db.createWebhook({
    id: `wh_${crypto.randomUUID().replace(/-/g, "")}`,
    tenantId: req.tenant_id,
    targetUrl: result.value.target_url,
    eventTypes: result.value.event_types,
    enabled: result.value.enabled,
    signingSecret,
    createdAt: now,
    updatedAt: now
  });
  res.status(201).json({ ...saved, signing_secret: signingSecret });
});

/**
 * GET /webhooks — list the tenant's webhooks (newest first).
 */
app.get("/webhooks", requireReadAccess, async (req, res) => {
  const webhooks = await db.listWebhooks(req.tenant_id);
  res.json({ webhooks });
});

/**
 * GET /webhooks/:id — fetch one webhook (tenant-scoped). 404 if absent.
 */
app.get("/webhooks/:id", requireReadAccess, validatePathParams, async (req, res) => {
  const webhook = await db.getWebhook(req.params.id, req.tenant_id);
  if (!webhook) return res.status(404).json({ error: "Not Found", message: "Webhook not found" });
  res.json(webhook);
});

/**
 * PATCH /webhooks/:id — partial update (target_url / event_types / enabled).
 * Requires a WRITE-scoped key. 400 on invalid fields, 404 if absent.
 */
app.patch("/webhooks/:id", requireApiKey("write"), validatePathParams, async (req, res) => {
  const result = validateUpdateWebhook(req.body, { allowlist: webhookAllowlist() });
  if (!result.ok) {
    return res.status(400).json({ error: "Bad Request", message: "Invalid webhook update", details: result.errors });
  }
  const updated = await db.updateWebhook(
    req.params.id,
    req.tenant_id,
    result.value,
    new Date().toISOString()
  );
  if (!updated) return res.status(404).json({ error: "Not Found", message: "Webhook not found" });
  res.json(updated);
});

/**
 * DELETE /webhooks/:id — remove a webhook (tenant-scoped).
 * Requires a WRITE-scoped key. 404 if absent.
 */
app.delete("/webhooks/:id", requireApiKey("write"), validatePathParams, async (req, res) => {
  const removed = await db.deleteWebhook(req.params.id, req.tenant_id);
  if (!removed) return res.status(404).json({ error: "Not Found", message: "Webhook not found" });
  res.status(204).end();
});

/**
 * GET /webhooks/:id/deliveries — recent delivery attempts for a webhook
 * (Phase 16-D). Read- + tenant-scoped. 404 if the webhook isn't this tenant's.
 *
 * Query params (all optional):
 *   since — ISO-8601 inclusive lower bound on created_at (created_at >= since)
 *   until — ISO-8601 exclusive upper bound on created_at (created_at <  until)
 *   limit — max rows (1–1000, default 100)
 */
app.get("/webhooks/:id/deliveries", requireReadAccess, validatePathParams, validateQueryParams, async (req, res) => {
  // 404 (not 403) when the webhook isn't the tenant's — don't leak existence.
  const webhook = await db.getWebhook(req.params.id, req.tenant_id);
  if (!webhook) return res.status(404).json({ error: "Not Found", message: "Webhook not found" });

  const since = parseIsoBound(req.query.since);
  const until = parseIsoBound(req.query.until);
  if (!since.ok || !until.ok) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Query parameters 'since' and 'until' must be ISO-8601 timestamps"
    });
  }
  const limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 100;
  const deliveries = await db.listWebhookDeliveries(req.params.id, req.tenant_id, {
    since: since.value,
    until: until.value,
    limit
  });
  res.json({ webhook_id: req.params.id, deliveries });
});

/**
 * GET /metrics/prometheus — Prometheus text format scrape endpoint
 *
 * Exports event counters, session/workflow gauges, per-type breakdowns,
 * HTTP request counts, and latency histograms.
 *
 * This endpoint is intentionally unauthenticated so Prometheus scrapers can
 * reach it without an API key.  To restrict access, place this behind a
 * network-layer control (reverse proxy, firewall, etc.).
 */
app.get("/metrics/prometheus", async (_req, res) => {
  // Use server-wide (no tenant filter) stats for Prometheus
  const dbStats = await db.getMetrics(null);
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(getPrometheusText(dbStats));
});

// GET /stream — Server-Sent Events endpoint for real-time dashboard updates
// Enforces connection limits: global and per-tenant
app.get("/stream", requireReadAccess, (req, res) => {
  const tenantId = req.tenant_id || "default";

  // ATOMIC: Create connection ID and reserve slot BEFORE any limit checks
  // This prevents TOCTOU (time-of-check, time-of-use) race conditions by ensuring
  // limit checks are performed AFTER incrementing counters, not before.
  if (!sseClients.has(tenantId)) {
    sseClients.set(tenantId, new Map());
  }
  const tenantMap = sseClients.get(tenantId);
  const connectionId = crypto.randomUUID();
  tenantMap.set(connectionId, res);

  // NOW check limits after reserving the slot
  // If we exceed limits, we'll rollback by deleting the connection
  const globalConnectionCount = Array.from(sseClients.values()).reduce((sum, map) => sum + map.size, 0);
  if (globalConnectionCount > MAX_SSE_CONNECTIONS) {
    // Rollback: remove the connection we just added
    tenantMap.delete(connectionId);
    if (tenantMap.size === 0) sseClients.delete(tenantId);

    logger.warn(
      { tenant_id: tenantId, global_connections: globalConnectionCount, max: MAX_SSE_CONNECTIONS },
      "SSE connection limit exceeded (global)"
    );
    res.setHeader("Retry-After", "60");
    return res.status(429).json({
      error: "Too Many Requests",
      message: "Server has reached maximum concurrent SSE connections"
    });
  }

  // Check per-tenant connection limit (after increment)
  const tenantConnectionCount = tenantMap.size;
  if (tenantConnectionCount > MAX_SSE_PER_TENANT) {
    // Rollback: remove the connection we just added
    tenantMap.delete(connectionId);
    if (tenantMap.size === 0) sseClients.delete(tenantId);

    logger.warn(
      { tenant_id: tenantId, tenant_connections: tenantConnectionCount, max: MAX_SSE_PER_TENANT },
      "SSE connection limit exceeded (per-tenant)"
    );
    res.setHeader("Retry-After", "60");
    return res.status(429).json({
      error: "Too Many Requests",
      message: `This tenant has reached its maximum concurrent SSE connections (${MAX_SSE_PER_TENANT})`
    });
  }

  // Log warning if approaching capacity (at 80%)
  if (tenantConnectionCount >= Math.floor(MAX_SSE_PER_TENANT * 0.8)) {
    logger.warn(
      { tenant_id: tenantId, tenant_connections: tenantConnectionCount, max: MAX_SSE_PER_TENANT },
      "SSE tenant connection usage at 80%"
    );
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  // Track whether cleanup has been done to prevent double-free
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const clientMap = sseClients.get(tenantId);
    if (clientMap) {
      clientMap.delete(connectionId);
      if (clientMap.size === 0) sseClients.delete(tenantId);
    }
  };

  // Track last activity for timeout detection (90 seconds of inactivity)
  let lastActivityAt = Date.now();
  const IDLE_TIMEOUT_MS = 90_000;

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
      lastActivityAt = Date.now();
    } catch (_) {
      clearInterval(heartbeat);
      clearTimeout(idleTimer);
      cleanup();
    }
  }, 15000);

  // Timeout to close connections with no activity for 90 seconds
  const idleTimer = setInterval(() => {
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs >= IDLE_TIMEOUT_MS) {
      try { res.end(); } catch (_) {}
      clearInterval(heartbeat);
      clearInterval(idleTimer);
      cleanup();
      logger.debug({ tenant_id: tenantId, connection_id: connectionId }, "SSE connection closed due to idle timeout");
    }
  }, 15000);

  res.aepTenantId = tenantId;
  res.aepConnectionId = connectionId;

  req.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(idleTimer);
    cleanup();
    logger.debug({ tenant_id: tenantId, connection_id: connectionId }, "SSE client disconnected");
  });

  logger.debug(
    { tenant_id: tenantId, connection_id: connectionId, tenant_connections: tenantConnectionCount + 1 },
    "SSE client connected"
  );
});

// ---------------------------------------------------------------------------
// Routes — ingest (write endpoint, requires API key with write scope)
// ---------------------------------------------------------------------------

// Issue #65 — per-event HMAC signature verification accepts ONLY the payload-
// covering v2 canonical form (an explicit signature.canon:"v2" marker that
// verifies deep; see verifySignature). The legacy v1 form, the unmarked
// "transition" mode, the REQUIRE_CANON_V2 escape hatch, and the RFC 8594 v1
// deprecation headers were all removed in Phase E (BREAKING) — v1 was retired
// across the server and all three published SDKs (npm @surpradhan/aep >= 0.4.0,
// PyPI agent-event-protocol >= 0.3.0, Go sdks/go/v0.3.0).

// POST /events — ingest a single event
// Rate limiting is applied per-key AFTER authentication resolves req.api_key_id.
app.post("/events", requireApiKey("write"), ingestRateLimit, enforceQuota, async (req, res) => {
  await db.incrementCounter("received");

  const event = req.body;

  // ------------------------------------------------------------------
  // Signature verification
  // ------------------------------------------------------------------
  const hmacSecret = req.api_key_record && req.api_key_record.hmac_secret;
  if (hmacSecret) {
    // `marked` = the emitter declared a canonicalization version via
    // signature.canon. Retained for the signature observability counters
    // (issue #65 Phase A); for an accepted signature it is always true (the only
    // accepted form is an explicit canon:"v2"), but rejections may be unmarked.
    const marked = !!(event && event.signature && typeof event.signature === "object"
      && event.signature.canon !== undefined);
    // Issue #65 — only a payload-covering v2 signature is accepted: an explicit
    // canon:"v2" marker that verifies against the deep form. A missing/non-"v2"
    // marker or a digest mismatch → 401 below with an actionable error.
    const { valid, canon, error } = verifySignature(event, hmacSecret);
    if (!valid) {
      recordSignatureRejection({ marked });
      await db.incrementCounter("rejected");
      pushRejection({
        event_id:   event.id,
        event_type: sanitizeInput(event.type),
        session_id: sanitizeInput(event.session_id),
        reason:     "signature_invalid",
        detail:     sanitizeInput(error),
        errors:     null,
        tenant_id:  req.tenant_id
      });
      logger.warn(
        { event_id: event.id, session_id: event.session_id, reason: sanitizeInput(error) },
        "event rejected: signature verification failed"
      );
      return res.status(401).json({
        accepted: false,
        error:    "Signature verification failed",
        detail:   sanitizeInput(error)
      });
    }

    // Accepted: classify by effective canonical form for signature telemetry
    // (issue #65 Phase A). With v1 retired this is always "v2", but the counter
    // is kept so the Prometheus/JSON metrics series stays stable.
    recordSignatureVerification({ form: canon, marked });
  }

  // ------------------------------------------------------------------
  // Schema validation
  // ------------------------------------------------------------------
  const { valid, errors } = validateEvent(event);
  if (!valid) {
    await db.incrementCounter("rejected");
    pushRejection({
      event_id:   event.id,
      event_type: sanitizeInput(event.type),
      session_id: sanitizeInput(event.session_id),
      reason:     "schema_invalid",
      detail:     null,
      errors:     errors.map(sanitizeInput),
      tenant_id:  req.tenant_id
    });
    logger.warn(
      { event_id: event.id, errors },
      "event rejected: schema validation failed"
    );
    return res.status(400).json({ accepted: false, errors });
  }

  // ------------------------------------------------------------------
  // Persist
  // ------------------------------------------------------------------
  const { isDuplicate } = await db.insertEvent(event, req.tenant_id);

  if (isDuplicate) {
    await db.incrementCounter("duplicates");
    logger.debug(
      { event_id: event.id, session_id: event.session_id, tenant_id: req.tenant_id },
      "duplicate event discarded"
    );
    return res.status(200).json({ accepted: true, duplicate: true, id: event.id });
  }

  // Account the accepted event against the project's quota cache so the
  // in-memory usage stays correct between DB refreshes (see middleware/quota.js).
  recordAccepted(req.project_id || "default");

  logger.debug(
    { event_id: event.id, type: event.type, session_id: event.session_id, tenant_id: req.tenant_id },
    "event ingested"
  );

  broadcastSse("event.received", event, req.tenant_id);

  // Fan the event out to any matching, enabled webhooks (Phase 16-B). This is
  // fire-and-forget and gated by WEBHOOKS_ENABLED — it never blocks or fails the
  // ingest response, and is a no-op when delivery is disabled.
  scheduleDelivery(event, req.tenant_id);

  return res.status(202).json({ accepted: true, duplicate: false, id: event.id });
});

// ---------------------------------------------------------------------------
// SSE broadcast with tenant-aware filtering
// ---------------------------------------------------------------------------

function broadcastSse(eventName, data, senderTenantId) {
  if (!sseClients.size) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;

  // Determine which tenants should receive this broadcast
  // - If senderTenantId is null: broadcast to ALL tenants (admin event)
  // - If senderTenantId is specified: broadcast only to that tenant's clients
  const targetTenants = senderTenantId === null || senderTenantId === undefined
    ? Array.from(sseClients.keys())
    : [senderTenantId];

  for (const tenantId of targetTenants) {
    const clientMap = sseClients.get(tenantId);
    if (!clientMap) continue;

    for (const [connectionId, client] of clientMap) {
      try {
        client.write(payload);
      } catch (_) {
        clientMap.delete(connectionId);
      }
    }

    // Clean up empty tenant entries
    if (clientMap.size === 0) {
      sseClients.delete(tenantId);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes — Rejection log
// ---------------------------------------------------------------------------

// GET /rejections — return recent rejected events (most-recent first, tenant-scoped)
app.get("/rejections", requireReadAccess, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_REJECTIONS);
  // Filter to this tenant's rejections if a specific tenant, or all if admin/dashboard
  const filtered = req.tenant_id
    ? recentRejections.filter(r => r.tenant_id === req.tenant_id)
    : recentRejections;
  res.json({
    rejections: [...filtered].reverse().slice(0, limit),
    total:      filtered.length
  });
});

// ---------------------------------------------------------------------------
// Routes — Admin API (key management)
// ---------------------------------------------------------------------------

// POST /admin/keys — generate a new API key
app.post("/admin/keys", requireAdminAuth, async (req, res) => {
  const { tenantId, projectId, label, scopes, hmacSecret } = req.body || {};

  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "'tenantId' is required and must be a non-empty string" });
  }

  const validScopes    = ["read", "write"];
  const resolvedScopes = scopes || ["read", "write"];
  if (!Array.isArray(resolvedScopes) || !resolvedScopes.every(s => validScopes.includes(s))) {
    return res.status(400).json({
      error: "'scopes' must be an array containing one or more of: " + validScopes.join(", ")
    });
  }

  // If a project is named, it must exist. Defaults to the seeded 'default'
  // project (unlimited) so existing key-creation calls keep working unchanged.
  const resolvedProjectId = projectId || "default";
  if (typeof resolvedProjectId !== "string") {
    return res.status(400).json({ error: "'projectId' must be a string" });
  }
  const project = await db.getProject(resolvedProjectId);
  if (!project) {
    return res.status(400).json({ error: `Project not found: '${resolvedProjectId}'` });
  }

  try {
    const result = await generateApiKey({
      tenantId,
      projectId:  resolvedProjectId,
      label:      label      || "",
      scopes:     resolvedScopes,
      hmacSecret: hmacSecret || null
    });

    logger.info(
      { tenant_id: result.tenantId, project_id: result.projectId, key_id: result.id, label: result.label },
      "API key created"
    );

    return res.status(201).json({
      message:        "API key created. Store the key securely — it will not be shown again.",
      key:            result.key,
      id:             result.id,
      keyPrefix:      result.keyPrefix,
      tenantId:       result.tenantId,
      projectId:      result.projectId,
      label:          result.label,
      scopes:         result.scopes,
      signingEnabled: !!hmacSecret
    });
  } catch (err) {
    logger.error({ err }, "failed to create API key");
    return res.status(500).json({ error: sanitizeInput(err.message) });
  }
});

// GET /admin/keys — list all API keys (no raw keys or hmac_secret)
app.get("/admin/keys", requireAdminAuth, async (_req, res) => {
  const keys = (await db.listApiKeys()).map(k => ({
    id:        k.id,
    keyPrefix: k.key_prefix,
    tenantId:  k.tenant_id,
    projectId: k.project_id || "default",
    label:     k.label,
    scopes:    JSON.parse(k.scopes || "[]"),
    createdAt: k.created_at,
    revokedAt: k.revoked_at || null,
    active:    !k.revoked_at
  }));
  res.json({ keys });
});

// DELETE /admin/keys/:id — revoke an API key
app.delete("/admin/keys/:id", requireAdminAuth, async (req, res) => {
  const key = await db.getApiKeyById(req.params.id);
  if (!key) {
    return res.status(404).json({ error: "API key not found" });
  }
  if (key.revoked_at) {
    return res.status(409).json({ error: "API key is already revoked", revokedAt: key.revoked_at });
  }
  await db.revokeApiKey(req.params.id);
  logger.info({ key_id: req.params.id }, "API key revoked");
  res.json({ ok: true, message: "API key revoked", id: req.params.id });
});

/**
 * GET /admin/keys/:id/access-log — API-key usage audit trail (Phase 14 PR-E).
 *
 * Admin-scoped. Returns the most-recent-first access records for one key, with an
 * optional `since`/`until` ISO-8601 window and `limit` (1–1000, default 100).
 * `enabled` reflects whether ACCESS_LOG_ENABLED is on — an empty log with
 * `enabled:false` means recording is simply off, not that the key was unused.
 */
app.get("/admin/keys/:id/access-log", requireAdminAuth, validateQueryParams, async (req, res) => {
  const key = await db.getApiKeyById(req.params.id);
  if (!key) {
    return res.status(404).json({ error: "API key not found" });
  }

  const since = parseIsoBound(req.query.since);
  const until = parseIsoBound(req.query.until);
  if (!since.ok || !until.ok) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Query parameters 'since' and 'until' must be ISO-8601 timestamps"
    });
  }

  const limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 100;
  const { total, entries } = await db.getApiKeyAccessLog(req.params.id, {
    since: since.value,
    until: until.value,
    limit
  });

  res.json({
    api_key_id: req.params.id,
    key_prefix: key.key_prefix,
    enabled: isAccessLogEnabled(),
    total,
    entries,
    window: { since: since.value, until: until.value }
  });
});

// ---------------------------------------------------------------------------
// Routes — Admin: projects / tiers / quotas (Phase 13 PR-C)
// ---------------------------------------------------------------------------

/**
 * Serialise a project DB row for API responses.  Adds a `usage` field (current
 * accepted-event count for the project's tenant) so operators can see headroom.
 */
async function serializeProject(row, includeUsage = false) {
  const region = row.region ?? null; // null = unspecified (no residency requirement)
  const out = {
    id:            row.id,
    name:          row.name,
    tenantId:      row.tenant_id,
    tier:          row.tier,
    eventQuota:    row.event_quota ?? null,    // null = unlimited
    retentionDays: row.retention_days ?? null, // null = unlimited
    region,                                    // data-residency label (Phase 14 PR-G)
    // True when this deployment's storage region satisfies the project's declared
    // region (or it asks for none/global). False = data is NOT physically in the
    // required region (a signal — AEP does not route storage by region).
    regionEnforced: isRegionEnforced(region),
    createdAt:     row.created_at
  };
  if (includeUsage) {
    out.usage = await db.getProjectEventCount(row.tenant_id);
  }
  return out;
}

// POST /admin/projects — create a project on a named tier.
// The tier's default event_quota / retention_days are materialised onto the
// project row; either can be overridden per-project via the request body.
app.post("/admin/projects", requireAdminAuth, async (req, res) => {
  const { name, tenantId, tier, eventQuota, retentionDays, region } = req.body || {};

  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "'tenantId' is required and must be a non-empty string" });
  }

  const resolvedTier = tier || DEFAULT_TIER;
  if (!isValidTier(resolvedTier)) {
    return res.status(400).json({
      error: "'tier' must be one of: " + TIER_NAMES.join(", ")
    });
  }

  // Data-residency region (Phase 14 PR-G): optional. Unspecified → null.
  if (!isValidRegion(region)) {
    return res.status(400).json({
      error: "'region' must be one of: EU, US, APAC, global (or omitted)"
    });
  }
  const resolvedRegion = normalizeRegion(region);

  // Per-project overrides: undefined → inherit tier default; null → unlimited.
  const policy = getTierPolicy(resolvedTier);
  const resolvedQuota = eventQuota === undefined ? policy.event_quota : eventQuota;
  const resolvedRetention = retentionDays === undefined ? policy.retention_days : retentionDays;

  if (resolvedQuota !== null && (!Number.isInteger(resolvedQuota) || resolvedQuota < 0)) {
    return res.status(400).json({ error: "'eventQuota' must be a non-negative integer or null (unlimited)" });
  }
  if (resolvedRetention !== null && (!Number.isInteger(resolvedRetention) || resolvedRetention < 0)) {
    return res.status(400).json({ error: "'retentionDays' must be a non-negative integer or null (unlimited)" });
  }

  const record = {
    id:             crypto.randomUUID(),
    name:           typeof name === "string" ? name : "",
    tenant_id:      tenantId,
    tier:           resolvedTier,
    event_quota:    resolvedQuota,
    retention_days: resolvedRetention,
    created_at:     new Date().toISOString(),
    region:         resolvedRegion
  };

  try {
    await db.createProject(record);
    logger.info(
      { project_id: record.id, tenant_id: record.tenant_id, tier: record.tier },
      "project created"
    );
    return res.status(201).json({ project: await serializeProject(record) });
  } catch (err) {
    logger.error({ err }, "failed to create project");
    return res.status(500).json({ error: sanitizeInput(err.message) });
  }
});

// GET /admin/projects — list all projects (with current usage).
app.get("/admin/projects", requireAdminAuth, async (_req, res) => {
  const rows = await db.listProjects();
  const projects = await Promise.all(rows.map(r => serializeProject(r, true)));
  res.json({ projects });
});

// GET /admin/projects/:id — fetch a single project (with current usage).
app.get("/admin/projects/:id", requireAdminAuth, async (req, res) => {
  const row = await db.getProject(req.params.id);
  if (!row) {
    return res.status(404).json({ error: "Project not found" });
  }
  res.json({ project: await serializeProject(row, true) });
});

// ---------------------------------------------------------------------------
// Start + graceful shutdown
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Initialise the storage backend (open connection + run migrations) BEFORE
  // we start accepting traffic. The DB API is async now, so this is awaited.
  db.init()
    .then(() => {
      const httpServer = app.listen(port, () => {
        logger.info(
          { port, url: `http://localhost:${port}` },
          "AEP ingest server started"
        );

        if (!process.env.DASHBOARD_TOKEN) {
          logger.warn("DASHBOARD_TOKEN not set — dashboard is open (dev mode)");
        }
        if (!process.env.ADMIN_TOKEN) {
          logger.warn("ADMIN_TOKEN not set — /admin/* endpoints will return 503");
        } else {
          logger.info("Admin API enabled");
        }
      });

      // ── Graceful shutdown ──────────────────────────────────────────────────
      //
      // On SIGTERM / SIGINT:
      //   1. Stop accepting new connections (httpServer.close)
      //   2. Let in-flight requests finish
      //   3. Close the storage backend connection
      //   4. Exit cleanly
      //
      // A hard timeout forces exit after 30 s in case requests stall.

      function shutdown(signal) {
        logger.info({ signal }, "graceful shutdown initiated");

        httpServer.close(async () => {
          logger.info("HTTP server closed — all in-flight requests drained");
          try {
            await db.closeDb();
            logger.info("database connection closed");
          } catch (err) {
            logger.error({ err }, "error closing database");
          }
          logger.info("shutdown complete");
          process.exit(0);
        });

        setTimeout(() => {
          logger.error("shutdown timeout exceeded — forcing exit");
          process.exit(1);
        }, 30_000).unref();
      }

      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT",  () => shutdown("SIGINT"));
    })
    .catch((err) => {
      logger.error({ err }, "failed to initialise storage backend — exiting");
      process.exit(1);
    });
}

module.exports = { app };
