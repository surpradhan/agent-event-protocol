# AEP Auth & Multi-Tenancy

This document covers authentication, tenant isolation, and HMAC signature verification for the AEP ingest server.

## Overview

The server has three independent auth layers:

| Layer | Protects | Credential |
|---|---|---|
| API Key | `/events` (write), `/sessions*`, `/metrics`, `/workflows*`, `/stream` (read) | `aep_<48 hex chars>` bearer token |
| Dashboard Token | `GET /dashboard` (browser UI) | Arbitrary secret set in `DASHBOARD_TOKEN` env var |
| Admin Token | `/admin/keys*` (key management) | Arbitrary secret set in `ADMIN_TOKEN` env var |

If `DASHBOARD_TOKEN` is not set, the dashboard and all read endpoints are **open** (dev-mode convenience). Production deployments should set both `DASHBOARD_TOKEN` and `ADMIN_TOKEN`.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_TOKEN` | For key management | Secret used to authenticate `/admin/*` requests |
| `DASHBOARD_TOKEN` | For dashboard protection | Secret used to authenticate dashboard access and read-only API calls |
| `PORT` | No (default: `8787`) | TCP port the server listens on |
| `DATABASE_PATH` | No (default: `./data/aep.db`) | Path to the SQLite database |
| `LOG_LEVEL` | No (default: `info`) | Pino log level: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `LOG_PRETTY` | No (default: `false`) | Set to `true` for human-readable logs (requires `pino-pretty`; dev only) |
| `RATE_LIMIT_RPM` | No (default: `300`) | Max `POST /events` requests per API key per 60-second window. `0` disables. |

See `.env.example` for the full annotated template.

---

## API Keys

### Format

Keys are 52-character strings with the prefix `aep_`:

```
aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3
```

The raw key is only shown **once** at creation. The server stores only its SHA-256 hash. If you lose a key, revoke it and generate a new one.

### Scopes

Each key has one or more scopes:

| Scope | Grants access to |
|---|---|
| `write` | `POST /events` |
| `read` | All `GET` endpoints: `/sessions`, `/metrics`, `/workflows`, `/stream` |

Most keys should have `["read", "write"]`. Read-only keys are useful for dashboards or monitoring agents that should not ingest events.

### Passing a Key

**Option A — Authorization header (recommended):**
```
Authorization: Bearer aep_a3f9e1c2d4b5f6…
```

**Option B — X-API-Key header:**
```
X-API-Key: aep_a3f9e1c2d4b5f6…
```

### Generating a Key

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

Response:

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

### Listing Keys

```bash
curl -s http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Raw keys and HMAC secrets are **never** returned by this endpoint.

### Revoking a Key

```bash
curl -s -X DELETE http://localhost:8787/admin/keys/<key-id> \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Revocation is immediate. Subsequent requests with the revoked key receive HTTP 401.

---

## Tenant Isolation

Every API key is bound to a **tenant ID** (an arbitrary string you choose, e.g. `"acme-corp"` or `"team-alpha"`).

- **On ingest** — the tenant ID from the API key is stored with every event. The `tenant` field in the event envelope is preserved in the raw payload for reference but does not affect routing.
- **On reads** — all endpoints (`/sessions`, `/metrics`, `/workflows`, `/stream`) automatically filter results to the caller's tenant. A key scoped to `acme-corp` cannot see events belonging to `beta-inc`.
- **Dashboard token** — grants full read access across all tenants. Use it for the admin dashboard only.

### Default tenant

Events ingested before auth was enabled (migration 001 only) are assigned to the `default` tenant. To access them programmatically, generate a key with `tenantId: "default"`.

---

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

### Signature protocol

The signature is a top-level field in the event envelope:

```json
{
  "specversion": "0.2.0",
  "id": "…",
  "signature": {
    "alg":   "hmac-sha256",
    "value": "<base64-encoded HMAC digest>"
  },
  "…": "…"
}
```

**Canonical form algorithm** (emitters must implement identically):

1. Build the event object (all fields populated, **without** the `signature` key).
2. Collect all top-level key names and sort them **alphabetically**.
3. `JSON.stringify(event, sortedKeys)` — this emits only the listed keys in sorted order, no extra whitespace.
4. Compute `HMAC-SHA256(canonical_string, secret)` over the UTF-8 bytes of the canonical string.
5. Base64-encode the raw 32-byte digest.
6. Add `signature: { alg: "hmac-sha256", value: "<base64>" }` to the event object.

### Node.js emitter example

```js
const crypto = require('crypto');

function signEvent(event, secret) {
  const copy = Object.assign({}, event);
  delete copy.signature; // must not sign itself
  const sortedKeys = Object.keys(copy).sort();
  const canonical  = JSON.stringify(copy, sortedKeys);
  const hmac       = crypto
    .createHmac('sha256', secret)
    .update(canonical, 'utf8')
    .digest('base64');
  return Object.assign({}, event, { signature: { alg: 'hmac-sha256', value: hmac } });
}

// Usage
const signedEvent = signEvent(myEvent, process.env.AEP_HMAC_SECRET);
await fetch('http://localhost:8787/events', {
  method:  'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + process.env.AEP_API_KEY
  },
  body: JSON.stringify(signedEvent)
});
```

### Verification errors

| HTTP status | Meaning |
|---|---|
| 401 | Signature missing (key requires signing) |
| 401 | Signature algorithm not `hmac-sha256` |
| 401 | Signature value is missing or wrong |
| 400 | Event fails schema validation (separate from signature) |

---

## Rate Limiting

Ingest requests (`POST /events`) are rate-limited per API key using an in-process fixed-window counter.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_RPM` | `300` | Maximum requests per key per 60-second window |

Set `RATE_LIMIT_RPM=0` to disable rate limiting entirely (not recommended in production).

### Response headers

Every `POST /events` response includes:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Configured RPM ceiling for this key |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |

### Rate limit exceeded

When the limit is breached the server returns HTTP **429** with a `Retry-After` header:

```json
{
  "error": "Rate limit exceeded",
  "limit": 300,
  "retryAfter": 42
}
```

Rate limits are per API key — keys issued to different tenants have independent counters. Requests that fail authentication before reaching the rate-limit middleware are not counted.

---

## Dashboard Auth

Access the dashboard at:

```
http://localhost:8787/dashboard
```

If `DASHBOARD_TOKEN` is configured, the server redirects unauthenticated requests to a login page. After sign-in, the token is stored in `sessionStorage` and included as an `Authorization: Bearer` header on all subsequent API calls.

You can also deep-link directly with the token:

```
http://localhost:8787/dashboard?token=<DASHBOARD_TOKEN>
```

The token is stripped from the URL after being saved to sessionStorage.

**SSE / real-time stream** — `EventSource` in browsers does not support custom headers. The dashboard passes the token as `?token=<tok>` on the `/stream` endpoint. The server accepts the token via query param for SSE connections only.

---

## Security Notes

- **Transport** — Deploy behind HTTPS in production. API keys and HMAC secrets transmitted over plain HTTP can be intercepted.
- **HMAC secrets** — Stored as plaintext in the SQLite database. For production, consider encrypting the DB or using an external secrets manager (Vault, AWS Secrets Manager, etc.).
- **Admin token** — Set `ADMIN_TOKEN` to a long random string (≥ 32 chars). The admin API can create and revoke keys for any tenant.
- **Dashboard token** — The dashboard token grants full cross-tenant read access. Treat it as an admin credential.
- **Key rotation** — Revoke old keys via `DELETE /admin/keys/:id` before replacing them.
- **Timing attacks** — All token comparisons use `crypto.timingSafeEqual` to prevent timing-based leaks.
