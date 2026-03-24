"use strict";

/**
 * src/auth.js — Authentication & authorisation middleware
 *
 * Three independent auth layers:
 *
 *   1. API Key auth  (requireApiKey)
 *      Used on all /events (write) and /sessions, /metrics, … (read) endpoints.
 *      Keys are bearer tokens of the form `aep_<48 hex chars>`.
 *      Each key is bound to a tenant; the resolved tenant_id is attached to
 *      req.tenant_id for the downstream handler.
 *
 *   2. Dashboard auth  (requireDashboardAuth)
 *      Protects GET /dashboard.  Reads DASHBOARD_TOKEN from the environment.
 *      If the env var is not set the endpoint is open (dev-mode convenience).
 *      Accepts the token via:
 *        • Authorization: Bearer <token>  header
 *        • ?token=<token>                 query param  (browser-friendly)
 *
 *   3. Admin auth  (requireAdminAuth)
 *      Protects POST/GET /admin/* endpoints used for key management.
 *      Reads ADMIN_TOKEN from the environment.
 *      If ADMIN_TOKEN is not set all admin endpoints return 503.
 *      Accepts the token via Authorization: Bearer <token> only.
 *
 * Key management helpers exported for use in server.js:
 *   generateApiKey({ tenantId, label, scopes, hmacSecret })
 *     → { key, id, keyPrefix, tenantId, label, scopes }
 *
 * Internal helpers:
 *   hashKey(rawKey)   — SHA-256 hex digest used as the DB lookup key
 */

const crypto = require("crypto");

// Lazy-loaded to break the circular dep db → migrate → (nothing) and
// auth → db; db is required after it has been initialised by server.js.
let _db = null;
function getDb() {
  if (!_db) _db = require("./db");
  return _db;
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of a raw key string.
 * @param {string} key
 * @returns {string}
 */
function hashKey(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Constant-time string comparison that also handles length differences.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  try {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) {
      // Still run timingSafeEqual on same-length slices to avoid early-exit
      // timing leak, then return false.
      crypto.timingSafeEqual(
        Buffer.alloc(ab.length, 0),
        Buffer.alloc(ab.length, 0)
      );
      return false;
    }
    return crypto.timingSafeEqual(ab, bb);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a bearer token from the Authorization header.
 * Returns null if not present or malformed.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractBearer(req) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    return token || null;
  }
  return null;
}

/**
 * Extract an API key from the request.
 * Checks Authorization: Bearer and X-API-Key header (in that order).
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractApiKey(req) {
  const bearer = extractBearer(req);
  if (bearer) return bearer;
  const xKey = req.headers["x-api-key"];
  return xKey ? xKey.trim() : null;
}

/**
 * Extract a token from Authorization: Bearer header or ?token query param.
 * Used for dashboard auth where browser navigation uses query params.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractBearerOrQuery(req) {
  return extractBearer(req) || (req.query.token ? String(req.query.token) : null);
}

// ---------------------------------------------------------------------------
// API Key management
// ---------------------------------------------------------------------------

/**
 * Generate a new API key, persist it to the DB, and return the one-time
 * visible raw key alongside the stored record metadata.
 *
 * @param {{ tenantId: string, label?: string, scopes?: string[], hmacSecret?: string|null }} opts
 * @returns {{ key: string, id: string, keyPrefix: string, tenantId: string, label: string, scopes: string[] }}
 */
function generateApiKey({ tenantId, label = "", scopes = ["read", "write"], hmacSecret = null }) {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("tenantId is required and must be a non-empty string");
  }

  const id     = crypto.randomUUID();
  const rawKey = "aep_" + crypto.randomBytes(24).toString("hex"); // aep_ + 48 hex chars
  const keyHash   = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12); // "aep_" + first 8 hex chars

  getDb().createApiKey({
    id,
    key_hash:    keyHash,
    key_prefix:  keyPrefix,
    tenant_id:   tenantId,
    label,
    scopes:      JSON.stringify(scopes),
    hmac_secret: hmacSecret,
    created_at:  new Date().toISOString()
  });

  return { key: rawKey, id, keyPrefix, tenantId, label, scopes };
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

/**
 * Express middleware that validates an API key and enforces a permission scope.
 *
 * On success:
 *   req.tenant_id        — the tenant bound to the key
 *   req.api_key_id       — the key's UUID
 *   req.api_key_scopes   — string[] of granted scopes
 *   req.api_key_record   — full DB row (includes hmac_secret for ingest use)
 *
 * @param {'read'|'write'|null} scope  Required scope; null = any valid key.
 * @returns {import('express').RequestHandler}
 */
function requireApiKey(scope) {
  return (req, res, next) => {
    const rawKey = extractApiKey(req);

    if (!rawKey) {
      return res.status(401).json({
        error: "API key required",
        hint:  "Supply via  Authorization: Bearer <key>  or  X-API-Key: <key>  header"
      });
    }

    const keyHash = hashKey(rawKey);
    const record  = getDb().getApiKeyByHash(keyHash);

    if (!record) {
      return res.status(401).json({ error: "Invalid API key" });
    }

    if (record.revoked_at) {
      return res.status(401).json({ error: "API key has been revoked" });
    }

    if (scope) {
      const grantedScopes = JSON.parse(record.scopes || "[]");
      if (!grantedScopes.includes(scope)) {
        return res.status(403).json({
          error: `Insufficient scope — key requires '${scope}' permission`,
          granted: grantedScopes
        });
      }
    }

    req.tenant_id      = record.tenant_id;
    req.api_key_id     = record.id;
    req.api_key_scopes = JSON.parse(record.scopes || "[]");
    req.api_key_record = record;

    next();
  };
}

/**
 * Middleware that accepts either a valid API key (read scope) OR the
 * DASHBOARD_TOKEN.  Used on read endpoints so both the dashboard and
 * programmatic callers can access them.
 *
 * When the dashboard token matches:
 *   req.tenant_id = null   ← signals "all tenants" to the DB layer
 *   req.is_admin  = true
 *
 * When an API key matches:
 *   req.tenant_id = <key's tenant>
 *   req.is_admin  = false
 *
 * @returns {import('express').RequestHandler}
 */
function requireReadAccess(req, res, next) {
  const dashToken = process.env.DASHBOARD_TOKEN;

  // 1. Try dashboard token (grants full read, no tenant filter).
  if (dashToken) {
    const provided = extractBearerOrQuery(req);
    if (provided && safeEqual(provided, dashToken)) {
      req.tenant_id = null;
      req.is_admin  = true;
      return next();
    }
  }

  // 2. Try API key (grants tenant-scoped read).
  const rawKey = extractApiKey(req);
  if (rawKey) {
    const keyHash = hashKey(rawKey);
    const record  = getDb().getApiKeyByHash(keyHash);

    if (record && !record.revoked_at) {
      const scopes = JSON.parse(record.scopes || "[]");
      if (scopes.includes("read")) {
        req.tenant_id      = record.tenant_id;
        req.api_key_id     = record.id;
        req.api_key_scopes = scopes;
        req.is_admin       = false;
        return next();
      }
    }
  }

  // 3. If DASHBOARD_TOKEN is not configured, allow unauthenticated read access.
  //    This preserves backward-compat in dev environments where auth is not set up.
  if (!dashToken) {
    req.tenant_id = null;
    req.is_admin  = true;
    return next();
  }

  return res.status(401).json({
    error: "Authentication required",
    hint:  "Supply an API key via  Authorization: Bearer <key>  or  X-API-Key  header"
  });
}

/**
 * Middleware for GET /dashboard.
 * Requires DASHBOARD_TOKEN via Authorization: Bearer or ?token= query param.
 * If DASHBOARD_TOKEN is not configured, access is open (dev mode).
 *
 * @type {import('express').RequestHandler}
 */
function requireDashboardAuth(req, res, next) {
  const dashToken = process.env.DASHBOARD_TOKEN;

  if (!dashToken) {
    // Dev mode: no token configured → open access.
    return next();
  }

  const provided = extractBearerOrQuery(req);

  if (!provided || !safeEqual(provided, dashToken)) {
    // For browser navigation, serve a minimal login page instead of JSON 401.
    const isApiRequest =
      req.headers["accept"] && req.headers["accept"].includes("application/json");

    if (isApiRequest) {
      return res.status(401).json({ error: "Dashboard token required" });
    }

    // Serve a lightweight login page.
    return res.status(401).send(loginPageHtml());
  }

  next();
}

/**
 * Middleware for /admin/* endpoints.
 * Requires ADMIN_TOKEN via Authorization: Bearer.
 * Returns 503 if ADMIN_TOKEN is not configured.
 *
 * @type {import('express').RequestHandler}
 */
function requireAdminAuth(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    return res.status(503).json({
      error: "Admin API not configured",
      hint:  "Set the ADMIN_TOKEN environment variable to enable key management endpoints"
    });
  }

  const provided = extractBearer(req);

  if (!provided || !safeEqual(provided, adminToken)) {
    return res.status(401).json({ error: "Invalid admin token" });
  }

  next();
}

// ---------------------------------------------------------------------------
// Login page (served when dashboard token check fails in a browser context)
// ---------------------------------------------------------------------------

function loginPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>AEP Dashboard — Sign in</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
         font-family:"Segoe UI",sans-serif;background:#f6f8f4;}
    .box{background:#fff;border:1px solid #d7e1d9;border-radius:16px;padding:40px 36px;
         max-width:360px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.06);}
    h2{margin:0 0 8px;font-size:22px;color:#132018;}
    p{margin:0 0 24px;font-size:14px;color:#4c5f52;}
    input{width:100%;box-sizing:border-box;border:1px solid #d7e1d9;border-radius:9px;
          padding:10px 12px;font-size:14px;color:#132018;outline:none;}
    input:focus{border-color:#166534;}
    button{margin-top:14px;width:100%;padding:11px;border:none;border-radius:9px;
           background:#166534;color:#fff;font-size:15px;font-weight:600;cursor:pointer;}
    button:hover{background:#145c2d;}
    .err{color:#8a2d1f;font-size:13px;margin-top:10px;display:none;}
  </style>
</head>
<body>
<div class="box">
  <h2>AEP Dashboard</h2>
  <p>Enter your dashboard token to continue.</p>
  <input type="password" id="tok" placeholder="Dashboard token" autocomplete="current-password"/>
  <button onclick="go()">Sign in</button>
  <div class="err" id="err">Invalid token — please try again.</div>
</div>
<script>
  document.getElementById('tok').addEventListener('keydown', e => { if(e.key==='Enter') go(); });
  function go(){
    const t = document.getElementById('tok').value.trim();
    if(!t) return;
    // Redirect to dashboard with token in query string; dashboard JS will
    // store it in sessionStorage and strip it from the URL.
    window.location.href = '/dashboard?token=' + encodeURIComponent(t);
  }
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  hashKey,
  generateApiKey,
  requireApiKey,
  requireReadAccess,
  requireDashboardAuth,
  requireAdminAuth
};
