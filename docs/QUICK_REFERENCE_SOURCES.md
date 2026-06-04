# QUICK_REFERENCE.md Source Attribution

This document shows the exact file location, line number, and original code/documentation snippet for every environment variable, API endpoint, command, and curl example in `docs/QUICK_REFERENCE.md`.

---

## Environment Variables

### ADMIN_TOKEN

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 13, 23  
**Original:**
```markdown
| Admin Token | `/admin/keys*` (key management) | Arbitrary secret set in `ADMIN_TOKEN` env var |

| Variable | Required | Description |
|---|---|---|
| `ADMIN_TOKEN` | For key management | Secret used to authenticate `/admin/*` requests |
```

**File:** [.env.example](../.env.example)  
**Line:** 59  
**Original:**
```
ADMIN_TOKEN=
```

**File:** [SETUP.md](../SETUP.md)  
**Line:** 76  
**Original:**
```bash
ADMIN_TOKEN=change-me DASHBOARD_TOKEN=change-me npm run ingest
```

---

### DASHBOARD_TOKEN

**File:** [AUTH.md](../AUTH.md)  
**Line:** 12, 23  
**Original:**
```markdown
| Dashboard Token | `GET /dashboard` (browser UI) | Arbitrary secret set in `DASHBOARD_TOKEN` env var |

| `DASHBOARD_TOKEN` | For dashboard protection | Secret used to authenticate dashboard access and read-only API calls |
```

**File:** [.env.example](../.env.example)  
**Line:** 44-50  
**Original:**
```bash
# Token that protects GET /dashboard and all read endpoints when accessed via
# the browser dashboard.  Accepted via:
#   Authorization: Bearer <token>   (API calls)
#   ?token=<token>                  (browser URL — stripped after auth)
#
# If unset the dashboard and read endpoints are open (dev convenience mode).
# MUST be set in production.
DASHBOARD_TOKEN=
```

**File:** [SETUP.md](../SETUP.md)  
**Line:** 76  
**Original:**
```bash
ADMIN_TOKEN=change-me DASHBOARD_TOKEN=change-me npm run ingest
```

---

### AEP_API_KEY

**File:** [src/cli.js](../src/cli.js)  
**Line:** 16, 127  
**Original:**
```javascript
 *   2. Env vars:   AEP_SERVER      AEP_API_KEY

  --key    <token>  API key         (env: AEP_API_KEY)
```

**File:** [SETUP.md](../SETUP.md)  
**Line:** 205  
**Original:**
```javascript
const AEP_API_KEY = process.env.AEP_API_KEY    || "";
```

**File:** [examples/emit-example.js](../examples/emit-example.js)  
**Line:** 4  
**Original:**
```javascript
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";
```

---

### AEP_INGEST_URL

**File:** [SETUP.md](../SETUP.md)  
**Line:** 204  
**Original:**
```javascript
const AEP_URL     = process.env.AEP_INGEST_URL || "http://localhost:8787";
```

**File:** [examples/emit-example.js](../examples/emit-example.js)  
**Line:** 4  
**Original:**
```javascript
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";
```

**File:** [examples/demos/support-agent-demo.js](../examples/demos/support-agent-demo.js)  
**Line:** 4  
**Original:**
```javascript
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";
```

---

## API Key Format & Properties

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 38-42  
**Original:**
```markdown
Keys are 52-character strings with the prefix `aep_`:

```
aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3
```

The raw key is only shown **once** at creation. The server stores only its SHA-256 hash. If you lose a key, revoke it and generate a new one.
```

---

## Key Scopes

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 50-56  
**Original:**
```markdown
| Scope | Grants access to |
|---|---|
| `write` | `POST /events` |
| `read` | All `GET` endpoints: `/sessions`, `/metrics`, `/workflows`, `/stream` |

Most keys should have `["read", "write"]`. Read-only keys are useful for dashboards or monitoring agents that should not ingest events.
```

---

## Curl Examples

### Generate API Key

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 70-81  
**Original:**
```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "acme-corp",
    "label":    "Production ingest key",
    "scopes":   ["read", "write"]
  }'
```

**Response Example in AUTH.md**  
**Lines:** 83-95  
**Original:**
```json
{
  "message": "API key created. Store the key securely — it will not be shown again.",
  "key":       "aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
  "id":        "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "keyPrefix": "aep_a3f9e1c",
  "tenantId":  "acme-corp",
  "label":     "Production ingest key",
  "scopes":    ["read", "write"],
  "signingEnabled": false
}
```

**Also in SETUP.md**  
**Line:** 83  
**Original:**
```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"my-org","label":"dev key","scopes":["read","write"]}'
```

---

### List API Keys

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 101-102  
**Original:**
```bash
curl -s http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

### Revoke API Key

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 110-112  
**Original:**
```bash
curl -s -X DELETE http://localhost:8787/admin/keys/<key-id> \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

### Health Check

**File:** [SETUP.md](../SETUP.md)  
**Line:** 101  
**Original:**
```bash
curl http://localhost:8787/health
```

**Response in SETUP.md**  
**Line:** 106  
**Original:**
```json
{ "ok": true, "service": "aep-ingest", "version": "0.2.0" }
```

---

### Emit Single Event (JavaScript)

**File:** [SETUP.md](../SETUP.md)  
**Lines:** 204-235  
**Original:**
```javascript
const crypto = require("crypto");

const AEP_URL     = process.env.AEP_INGEST_URL || "http://localhost:8787";
const AEP_API_KEY = process.env.AEP_API_KEY    || "";
const SOURCE      = "agent://my-agent";

let sessionId, traceId;

function initSession() {
  sessionId = `ses_${crypto.randomUUID()}`;
  traceId   = `trc_${crypto.randomUUID()}`;
}

async function emit(type, payload, causationId = null) {
  const event = {
    specversion: "0.2.0",
    id:          `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    time:        new Date().toISOString(),
    source:      SOURCE,
    type,
    session_id:  sessionId,
    trace_id:    traceId,
    payload
  };
  if (causationId) event.causation_id = causationId;

  const res  = await fetch(`${AEP_URL}/events`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${AEP_API_KEY}`
    },
    body: JSON.stringify(event)
  });
  const body = await res.json();
  return { ...body, eventId: event.id };
}
```

---

### Use Authorization Header

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 59-62  
**Original:**
```markdown
**Option A — Authorization header (recommended):**
```
Authorization: Bearer aep_a3f9e1c2d4b5f6…
```
```

---

### Use X-API-Key Header

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 64-67  
**Original:**
```markdown
**Option B — X-API-Key header:**
```
X-API-Key: aep_a3f9e1c2d4b5f6…
```
```

**File:** [src/auth.js](../src/auth.js)  
**Line:** 104-111  
**Original:**
```javascript
 * Checks Authorization: Bearer and X-API-Key header (in that order).
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
 * Extract an API key from the X-API-Key header.
 * Returns null if not present or empty.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractXKey(req) {
  const xKey = req.headers["x-api-key"];
  return xKey && xKey.trim ? xKey.trim() : null;
}
```

---

## API Endpoints Reference

### POST /events

**File:** [SETUP.md](../SETUP.md)  
**Line:** 509  
**Original:**
```markdown
| POST | `/events` | key:write | Ingest a single event. Returns 202 (accepted), 200 (duplicate), 400 (validation error), 401 (auth failure). |
```

**File:** [AUTH.md](../AUTH.md)  
**Line:** 11  
**Original:**
```markdown
| API Key | `/events` (write), `/sessions*`, `/metrics`, `/workflows*`, `/stream` (read) | `aep_<48 hex chars>` bearer token |
```

---

### GET /health

**File:** [SETUP.md](../SETUP.md)  
**Line:** 513  
**Original:**
```markdown
| GET | `/health` | none | Liveness probe. Returns `{ ok, service, version, checks: { db } }`. HTTP 503 if DB unreachable. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 139, 144  
**Original:**
```javascript
 * GET /health — liveness probe

app.get("/health", (_req, res) => {
```

---

### GET /metrics

**File:** [SETUP.md](../SETUP.md)  
**Line:** 515  
**Original:**
```markdown
| GET | `/metrics` | key:read or dash | Counters: received, accepted, rejected, duplicates, by-type breakdown, session/workflow counts, max tree depth. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 319-320  
**Original:**
```javascript
// GET /metrics — counters + session count + workflow metrics (JSON)
app.get("/metrics", requireReadAccess, (req, res) => {
```

---

### GET /stream

**File:** [SETUP.md](../SETUP.md)  
**Line:** 517  
**Original:**
```markdown
| GET | `/stream` | key:read or dash | Server-Sent Events. Delivers `event.received` frames in real time. Heartbeat every 15 seconds. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 341, 343  
**Original:**
```javascript
// GET /stream — Server-Sent Events endpoint for real-time dashboard updates
...
app.get("/stream", requireReadAccess, (req, res) => {
```

---

### GET /sessions

**File:** [SETUP.md](../SETUP.md)  
**Line:** 519  
**Original:**
```markdown
| GET | `/sessions` | key:read or dash | Paginated session list. Query: `?limit=<1-500>`, `?cursor=<token>`. |
```

---

### GET /sessions/:id/events

**File:** [SETUP.md](../SETUP.md)  
**Line:** 520  
**Original:**
```markdown
| GET | `/sessions/:id/events` | key:read or dash | Ordered event timeline. Query: `?type`, `?q`, `?limit=<1-1000>`, `?cursor`. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 258, 272  
**Original:**
```javascript
 * GET /sessions/:sessionId/events

app.get("/sessions/:sessionId/events", requireReadAccess, validatePathParams, validateQueryParams, (req, res) => {
```

---

### GET /sessions/:id/export

**File:** [SETUP.md](../SETUP.md)  
**Line:** 521  
**Original:**
```markdown
| GET | `/sessions/:id/export` | key:read or dash | Export events. Query: `?format=json\|csv`, `?type`, `?q`. |
```

---

### GET /workflows/:traceId

**File:** [SETUP.md](../SETUP.md)  
**Line:** 522  
**Original:**
```markdown
| GET | `/workflows/:traceId` | key:read or dash | All sessions sharing a `trace_id`, assembled into a workflow tree. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 310-311  
**Original:**
```javascript
// GET /workflows/:traceId — all sessions sharing a trace_id assembled into a tree
app.get("/workflows/:traceId", requireReadAccess, validatePathParams, (req, res) => {
```

---

### GET /dashboard

**File:** [SETUP.md](../SETUP.md)  
**Line:** 523  
**Original:**
```markdown
| GET | `/dashboard` | dash (if set) | Serves the browser dashboard UI. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 231  
**Original:**
```javascript
app.get("/dashboard", requireDashboardAuth, (_req, res) => {
```

---

### POST /admin/keys

**File:** [SETUP.md](../SETUP.md)  
**Line:** 524  
**Original:**
```markdown
| POST | `/admin/keys` | admin | Generate a new API key. Body: `{ tenantId, label?, scopes?, hmacSecret? }`. Raw key shown once only. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 596-597  
**Original:**
```javascript
// POST /admin/keys — generate a new API key
app.post("/admin/keys", requireAdminAuth, (req, res) => {
```

---

### GET /admin/keys

**File:** [SETUP.md](../SETUP.md)  
**Line:** 525  
**Original:**
```markdown
| GET | `/admin/keys` | admin | List all API keys. Raw keys and secrets never returned. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 638-639  
**Original:**
```javascript
// GET /admin/keys — list all API keys (no raw keys or hmac_secret)
app.get("/admin/keys", requireAdminAuth, (_req, res) => {
```

---

### DELETE /admin/keys/:id

**File:** [SETUP.md](../SETUP.md)  
**Line:** 526  
**Original:**
```markdown
| DELETE | `/admin/keys/:id` | admin | Revoke a key immediately. |
```

**File:** [src/server.js](../src/server.js)  
**Line:** 653-654  
**Original:**
```javascript
// DELETE /admin/keys/:id — revoke an API key
app.delete("/admin/keys/:id", requireAdminAuth, (req, res) => {
```

---

## Commands

### npm run ingest

**File:** [package.json](../package.json)  
**Line:** 15  
**Original:**
```json
    "ingest": "node src/server.js",
```

**File:** [README.md](../README.md)  
**Line:** 31  
**Original:**
```bash
npm run ingest
```

**File:** [SETUP.md](../SETUP.md)  
**Line:** 64  
**Original:**
```bash
npm run ingest
```

---

### npm install

**File:** [SETUP.md](../SETUP.md)  
**Line:** 60  
**Original:**
```bash
npm install
```

---

## Port Configuration

**File:** [AUTH.md](../AUTH.md)  
**Line:** 25-26  
**Original:**
```markdown
| `PORT` | No (default: `8787`) | TCP port the server listens on |
```

**File:** [SETUP.md](../SETUP.md)  
**Line:** 110  
**Original:**
```markdown
> **Note:** The `version` field reflects the server build, not the AEP `specversion`. The server defaults to port `8787`. Set the `PORT` environment variable to change it (e.g., `PORT=9000 npm run ingest`).
```

---

## Tenant Isolation

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 115-130  
**Original:**
```markdown
## Tenant Isolation

Every API key is bound to a **tenant ID** (an arbitrary string you choose, e.g. `"acme-corp"` or `"team-alpha"`).

- **On ingest** — the tenant ID from the API key is stored with every event. The `tenant` field in the event envelope is preserved in the raw payload for reference but does not affect routing.
- **On reads** — all endpoints (`/sessions`, `/metrics`, `/workflows`, `/stream`) automatically filter results to the caller's tenant. A key scoped to `acme-corp` cannot see events belonging to `beta-inc`.
- **Dashboard token** — grants full read access across all tenants. Use it for the admin dashboard only.

### Default tenant

Events ingested before auth was enabled (migration 001 only) are assigned to the `default` tenant. To access them programmatically, generate a key with `tenantId: "default"`.
```

---

## HMAC-SHA256 Signature Verification

**File:** [AUTH.md](../AUTH.md)  
**Lines:** 141-178  
**Original:**
```markdown
## HMAC-SHA256 Signature Verification

Signature verification is **opt-in per API key**. When an API key is created with an `hmacSecret`, every event submitted via that key must carry a valid HMAC-SHA256 signature. Events without a signature or with a mismatched signature are rejected with HTTP 401.

Keys without an `hmacSecret` accept events regardless of whether a `signature` field is present.

### Enabling signing for a key

Pass `hmacSecret` when creating the key:

```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId":   "acme-corp",
    "label":      "Signed ingest key",
    "scopes":     ["write"],
    "hmacSecret": "my-very-secret-signing-key-32chars+"
  }'
```
```

---

## Interactive API Documentation

**File:** [SETUP.md](../SETUP.md)  
**Line:** 502  
**Original:**
```markdown
Interactive API docs are also available at `http://localhost:8787/docs` (Swagger UI) — useful for exploring endpoints without writing curl commands.
```

---

## Docker Deployment

**File:** [SETUP.md](../SETUP.md)  
**Lines:** 536-556  
**Original:**
```markdown
# Copy and configure environment variables
cp .env.example .env
# Edit .env: set ADMIN_TOKEN, DASHBOARD_TOKEN, and any other vars

# Start with Docker Compose
docker compose up -d
docker compose logs -f aep
```

---

## Summary of Sources

| Type | Primary Sources |
|------|-----------------|
| **Authentication** | [AUTH.md](../AUTH.md), [SETUP.md](../SETUP.md), [.env.example](../.env.example) |
| **Environment Variables** | [AUTH.md](../AUTH.md), [.env.example](../.env.example), [src/cli.js](../src/cli.js), [SETUP.md](../SETUP.md) |
| **API Endpoints** | [SETUP.md](../SETUP.md), [src/server.js](../src/server.js), [src/openapi.json](../src/openapi.json) |
| **Curl Examples** | [AUTH.md](../AUTH.md), [SETUP.md](../SETUP.md), [SECURITY.md](../SECURITY.md) |
| **Code Examples** | [SETUP.md](../SETUP.md), [examples/emit-example.js](../examples/emit-example.js) |
| **Commands** | [package.json](../package.json), [README.md](../README.md), [SETUP.md](../SETUP.md) |

