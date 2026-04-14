"use strict";

const crypto  = require("crypto");
const express = require("express");
const path    = require("path");
const { version: SERVER_VERSION } = require("../package.json");

const { validateEvent }        = require("./validator");
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
const { metricsMiddleware, getPrometheusText } = require("./metrics");
const { ingestRateLimit }      = require("./middleware/rateLimit");

const app  = express();
const port = process.env.PORT || 8787;

// ---------------------------------------------------------------------------
// In-memory rejection log — last 200 rejected events (schema/signature fails)
// ---------------------------------------------------------------------------
const recentRejections = [];
const MAX_REJECTIONS   = 200;
function pushRejection({ event_id, event_type, session_id, reason, detail, errors }) {
  recentRejections.push({
    id:         crypto.randomUUID(),
    ts:         new Date().toISOString(),
    event_id:   event_id   || null,
    event_type: event_type || null,
    session_id: session_id || null,
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
// ---------------------------------------------------------------------------

const sseClients = new Set();

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
app.get("/health", (_req, res) => {
  let dbOk = false;
  try {
    db._db.prepare("SELECT 1").get();
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
app.get("/ready", (_req, res) => {
  let dbOk = false;
  let tablesOk = false;
  try {
    db._db.prepare("SELECT 1").get();
    dbOk = true;
    // Verify the schema is migrated by checking that the events table exists.
    const row = db._db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get();
    tablesOk = !!row;
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
  res.sendFile(path.join(__dirname, "openapi.json"));
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
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
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
app.get("/sessions", requireReadAccess, (req, res) => {
  const { limit, cursor } = req.query;
  const result = db.getPaginatedSessions(req.tenant_id, { limit, cursor });
  res.json({ sessions: result.sessions, next_cursor: result.next_cursor });
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
app.get("/sessions/:sessionId/events", requireReadAccess, (req, res) => {
  const { type = "", q = "", limit, cursor } = req.query;
  const result = db.getPaginatedEvents(req.params.sessionId, {
    type, q, tenantId: req.tenant_id, limit, cursor
  });
  res.json({
    session_id:  req.params.sessionId,
    events:      result.events,
    next_cursor: result.next_cursor
  });
});

// GET /sessions/:sessionId/tree — session and all descendants as a recursive tree
app.get("/sessions/:sessionId/tree", requireReadAccess, (req, res) => {
  const tree = db.getSessionTree(req.params.sessionId, req.tenant_id);
  if (!tree) {
    return res.status(404).json({ error: "Session not found", session_id: req.params.sessionId });
  }
  res.json(tree);
});

// GET /sessions/:sessionId/export — download as JSON or CSV
app.get("/sessions/:sessionId/export", requireReadAccess, (req, res) => {
  const sessionId = req.params.sessionId;
  const format    = (req.query.format || "json").toLowerCase();
  const { type = "", q = "" } = req.query;
  const events = db.getSessionEvents(sessionId, { type, q, tenantId: req.tenant_id });

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${sessionId}-events.csv"`);
    return res.send(toCsv(events));
  }

  res.setHeader("Content-Disposition", `attachment; filename="${sessionId}-events.json"`);
  return res.json({ session_id: sessionId, events });
});

// GET /workflows/:traceId — all sessions sharing a trace_id assembled into a tree
app.get("/workflows/:traceId", requireReadAccess, (req, res) => {
  const workflow = db.getWorkflow(req.params.traceId, req.tenant_id);
  if (!workflow) {
    return res.status(404).json({ error: "Workflow not found", trace_id: req.params.traceId });
  }
  res.json(workflow);
});

// GET /metrics — counters + session count + workflow metrics (JSON)
app.get("/metrics", requireReadAccess, (req, res) => {
  res.json(db.getMetrics(req.tenant_id));
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
app.get("/metrics/prometheus", (_req, res) => {
  // Use server-wide (no tenant filter) stats for Prometheus
  const dbStats = db.getMetrics(null);
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(getPrometheusText(dbStats));
});

// GET /stream — Server-Sent Events endpoint for real-time dashboard updates
app.get("/stream", requireReadAccess, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch (_) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 15000);

  res.aepTenantId = req.tenant_id;

  sseClients.add(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    logger.debug({ tenant_id: req.tenant_id }, "SSE client disconnected");
  });

  logger.debug({ tenant_id: req.tenant_id }, "SSE client connected");
});

// ---------------------------------------------------------------------------
// Routes — ingest (write endpoint, requires API key with write scope)
// ---------------------------------------------------------------------------

// POST /events — ingest a single event
// Rate limiting is applied per-key AFTER authentication resolves req.api_key_id.
app.post("/events", requireApiKey("write"), ingestRateLimit, (req, res) => {
  db.incrementCounter("received");

  const event = req.body;

  // ------------------------------------------------------------------
  // Signature verification
  // ------------------------------------------------------------------
  const hmacSecret = req.api_key_record && req.api_key_record.hmac_secret;
  if (hmacSecret) {
    const { valid, error } = verifySignature(event, hmacSecret);
    if (!valid) {
      db.incrementCounter("rejected");
      pushRejection({
        event_id:   event.id,
        event_type: event.type,
        session_id: event.session_id,
        reason:     "signature_invalid",
        detail:     error,
        errors:     null
      });
      logger.warn(
        { event_id: event.id, session_id: event.session_id, reason: error },
        "event rejected: signature verification failed"
      );
      return res.status(401).json({
        accepted: false,
        error:    "Signature verification failed",
        detail:   error
      });
    }
  }

  // ------------------------------------------------------------------
  // Schema validation
  // ------------------------------------------------------------------
  const { valid, errors } = validateEvent(event);
  if (!valid) {
    db.incrementCounter("rejected");
    pushRejection({
      event_id:   event.id,
      event_type: event.type,
      session_id: event.session_id,
      reason:     "schema_invalid",
      detail:     null,
      errors
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
  const { isDuplicate } = db.insertEvent(event, req.tenant_id);

  if (isDuplicate) {
    db.incrementCounter("duplicates");
    logger.debug(
      { event_id: event.id, session_id: event.session_id, tenant_id: req.tenant_id },
      "duplicate event discarded"
    );
    return res.status(200).json({ accepted: true, duplicate: true, id: event.id });
  }

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
  for (const client of sseClients) {
    try {
      if (!client.aepTenantId || client.aepTenantId === senderTenantId) {
        client.write(payload);
      }
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes — Rejection log
// ---------------------------------------------------------------------------

// GET /rejections — return recent rejected events (most-recent first)
app.get("/rejections", requireReadAccess, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_REJECTIONS);
  res.json({
    rejections: [...recentRejections].reverse().slice(0, limit),
    total:      recentRejections.length
  });
});

// ---------------------------------------------------------------------------
// Routes — Admin API (key management)
// ---------------------------------------------------------------------------

// POST /admin/keys — generate a new API key
app.post("/admin/keys", requireAdminAuth, (req, res) => {
  const { tenantId, label, scopes, hmacSecret } = req.body || {};

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

  try {
    const result = generateApiKey({
      tenantId,
      label:      label      || "",
      scopes:     resolvedScopes,
      hmacSecret: hmacSecret || null
    });

    logger.info({ tenant_id: result.tenantId, key_id: result.id, label: result.label }, "API key created");

    return res.status(201).json({
      message:        "API key created. Store the key securely — it will not be shown again.",
      key:            result.key,
      id:             result.id,
      keyPrefix:      result.keyPrefix,
      tenantId:       result.tenantId,
      label:          result.label,
      scopes:         result.scopes,
      signingEnabled: !!hmacSecret
    });
  } catch (err) {
    logger.error({ err }, "failed to create API key");
    return res.status(500).json({ error: err.message });
  }
});

// GET /admin/keys — list all API keys (no raw keys or hmac_secret)
app.get("/admin/keys", requireAdminAuth, (_req, res) => {
  const keys = db.listApiKeys().map(k => ({
    id:        k.id,
    keyPrefix: k.key_prefix,
    tenantId:  k.tenant_id,
    label:     k.label,
    scopes:    JSON.parse(k.scopes || "[]"),
    createdAt: k.created_at,
    revokedAt: k.revoked_at || null,
    active:    !k.revoked_at
  }));
  res.json({ keys });
});

// DELETE /admin/keys/:id — revoke an API key
app.delete("/admin/keys/:id", requireAdminAuth, (req, res) => {
  const key = db.getApiKeyById(req.params.id);
  if (!key) {
    return res.status(404).json({ error: "API key not found" });
  }
  if (key.revoked_at) {
    return res.status(409).json({ error: "API key is already revoked", revokedAt: key.revoked_at });
  }
  db.revokeApiKey(req.params.id);
  logger.info({ key_id: req.params.id }, "API key revoked");
  res.json({ ok: true, message: "API key revoked", id: req.params.id });
});

// ---------------------------------------------------------------------------
// Start + graceful shutdown
// ---------------------------------------------------------------------------

if (require.main === module) {
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

  // ── Graceful shutdown ────────────────────────────────────────────────────
  //
  // On SIGTERM / SIGINT:
  //   1. Stop accepting new connections (httpServer.close)
  //   2. Let in-flight requests finish
  //   3. Close the SQLite connection
  //   4. Exit cleanly
  //
  // A hard timeout forces exit after 30 s in case requests stall.

  function shutdown(signal) {
    logger.info({ signal }, "graceful shutdown initiated");

    httpServer.close(() => {
      logger.info("HTTP server closed — all in-flight requests drained");
      try {
        db.closeDb();
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
}

module.exports = { app };
