"use strict";

const crypto  = require("crypto");
const express = require("express");
const path    = require("path");
const { version: SERVER_VERSION } = require("../package.json");

const { validateEvent, sanitizeInput }        = require("./validator");
const db                       = require("./db");
const { verifySignature }      = require("./signature");
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
app.get("/sessions/:sessionId/export", requireReadAccess, validatePathParams, async (req, res) => {
  const sessionId = req.params.sessionId;
  const format    = (req.query.format || "json").toLowerCase();
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

// GET /metrics — counters + session count + workflow metrics (JSON)
app.get("/metrics", requireReadAccess, async (req, res) => {
  const dbStats = await db.getMetrics(req.tenant_id);
  // Signature-form telemetry (issue #65) is process-wide / server-scoped, not
  // tenant-filtered — surfaced alongside the DB counters for convenience.
  res.json({ ...dbStats, signatures: getSignatureMetrics() });
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

// Per-tenant "first-seen" set for legacy-v1 signature acceptance logging
// (issue #65, Phase A). We log the first v1 ingest per tenant at info level for
// attribution (tenant_id + source), then drop to debug to avoid log spam. The
// set is bounded so a flood of distinct tenant ids can't grow it unboundedly —
// past the cap we simply log at debug.
const v1SeenTenants = new Set();
const V1_SEEN_TENANTS_MAX = 10000;

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
    // signature.canon. Effective form classification (issue #65) is independent
    // of the marker (transition mode classifies an unmarked sig by what matched).
    const marked = !!(event && event.signature && typeof event.signature === "object"
      && event.signature.canon !== undefined);
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

    // Accepted: classify by effective canonical form for retirement telemetry.
    recordSignatureVerification({ form: canon, marked });

    // Per-tenant attribution for who is still on legacy v1, via logs (NOT a
    // high-cardinality metric label). First v1 ingest per tenant → info; the
    // rest → debug, so dashboards/log search can surface the at-risk population
    // without flooding the log stream.
    if (canon === "v1") {
      const tenantId = req.tenant_id;
      const firstForTenant = !v1SeenTenants.has(tenantId) && v1SeenTenants.size < V1_SEEN_TENANTS_MAX;
      if (firstForTenant) v1SeenTenants.add(tenantId);
      const logFields = { tenant_id: tenantId, source: sanitizeInput(event.source), marked };
      const msg = "accepted legacy v1 (envelope-only) signature — emitter should migrate to v2 (issue #65)";
      if (firstForTenant) logger.info(logFields, msg);
      else logger.debug(logFields, msg);
    }
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

// ---------------------------------------------------------------------------
// Routes — Admin: projects / tiers / quotas (Phase 13 PR-C)
// ---------------------------------------------------------------------------

/**
 * Serialise a project DB row for API responses.  Adds a `usage` field (current
 * accepted-event count for the project's tenant) so operators can see headroom.
 */
async function serializeProject(row, includeUsage = false) {
  const out = {
    id:            row.id,
    name:          row.name,
    tenantId:      row.tenant_id,
    tier:          row.tier,
    eventQuota:    row.event_quota ?? null,    // null = unlimited
    retentionDays: row.retention_days ?? null, // null = unlimited
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
  const { name, tenantId, tier, eventQuota, retentionDays } = req.body || {};

  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "'tenantId' is required and must be a non-empty string" });
  }

  const resolvedTier = tier || DEFAULT_TIER;
  if (!isValidTier(resolvedTier)) {
    return res.status(400).json({
      error: "'tier' must be one of: " + TIER_NAMES.join(", ")
    });
  }

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
    created_at:     new Date().toISOString()
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
