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

> **Ingest is the exception — it is authenticated in every mode.** `POST /events` always requires a write-scoped API key; there is no keyless/dev bypass. To emit events locally you must set `ADMIN_TOKEN`, mint a key via `POST /admin/keys`, and pass it as a bearer token (the bundled emitter and demo scripts read it from `AEP_API_KEY`). "Dev mode" only relaxes the dashboard and read endpoints.

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
| `AUDIT_SIGNING_SECRET` | For audit export/verify | Server-side HMAC secret that signs/verifies tamper-evident audit bundles (`aep audit`). Distinct from per-API-key HMAC secrets. When unset, audit export/verify fail with a clear error. |

See `.env.example` for the full annotated template.

> **Note (issue #65 Phase E):** the server now accepts **only** payload-covering
> `canon:"v2"` per-event signatures. The legacy v1 form, the transition mode, the
> `REQUIRE_CANON_V2` strict-mode flag (and its `=false` escape hatch), and the
> `SIGNATURE_V1_SUNSET` / RFC 8594 deprecation headers have all been removed.

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

The signature is a top-level field in the event envelope and MUST carry the
`canon: "v2"` marker (the only form the server accepts — see
[Canonicalization](#canonicalization-signaturecanon-v2)):

```json
{
  "specversion": "0.2.0",
  "id": "…",
  "signature": {
    "alg":   "hmac-sha256",
    "value": "<base64-encoded HMAC digest>",
    "canon": "v2"
  },
  "…": "…"
}
```

**Canonical form algorithm** (the v2, payload-covering rule — emitters must
implement identically):

1. Build the event object (all fields populated, **without** the `signature` key).
2. Recursively sort **every** object's keys **alphabetically**, at every nesting
   level (arrays keep their order). This covers nested payloads too.
3. `JSON.stringify` the result with no extra whitespace.
4. Compute `HMAC-SHA256(canonical_string, secret)` over the UTF-8 bytes of the canonical string.
5. Base64-encode the raw 32-byte digest.
6. Add `signature: { alg: "hmac-sha256", value: "<base64>", canon: "v2" }` to the event object.

### Node.js emitter example

```js
const crypto = require('crypto');

// Deep, payload-covering canonical form (v2): recursively key-sort the object.
function canonicalizeV2(value) {
  if (Array.isArray(value)) return value.map(canonicalizeV2);
  if (value && typeof value === 'object') {
    // Null-prototype accumulator so a payload key literally named "__proto__"
    // round-trips as an own key instead of mutating the prototype (which would
    // silently drop it and diverge from the server's digest).
    const out = Object.create(null);
    for (const k of Object.keys(value).sort()) out[k] = canonicalizeV2(value[k]);
    return out;
  }
  return value;
}

function signEvent(event, secret) {
  const copy = Object.assign({}, event);
  delete copy.signature; // must not sign itself
  const canonical  = JSON.stringify(canonicalizeV2(copy));
  const hmac       = crypto
    .createHmac('sha256', secret)
    .update(canonical, 'utf8')
    .digest('base64');
  return Object.assign({}, event, { signature: { alg: 'hmac-sha256', value: hmac, canon: 'v2' } });
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
| 401 | `signature.canon` is not `"v2"` (absent, `"v1"`, or any other value) |
| 401 | Signature value does not match the v2 (deep) HMAC — e.g. a tampered payload |
| 400 | Event fails schema validation (separate from signature) |

### Canonicalization (`signature.canon: "v2"`)

The server accepts **one** per-event signature form: the payload-covering **v2**
canonical form. The signer drops `signature`, then recursively key-sorts the
**whole** event (envelope *and* nested payloads) before HMAC, so a v2 signature
detects payload tampering — it is the same deep rule the Phase 14 audit bundle
uses for its `content_digest`.

A signed event MUST carry the explicit marker:

```json
"signature": { "alg": "hmac-sha256", "value": "<base64>", "canon": "v2" }
```

The verifier accepts a signature **iff**:

- `signature.canon === "v2"` is present, **and**
- the value verifies against the deep (v2) form.

Everything else is rejected with `401`:

| Signature | Result |
|---|---|
| `canon: "v2"`, deep-valid | **accepted** (`202`) |
| `canon: "v2"` but payload-tampered (deep HMAC fails) | **rejected** (`401`) |
| `canon: "v1"` | **rejected** (`401`) |
| *absent* marker — **even if it would verify deep** | **rejected** (`401`) |
| any non-`v2` / unknown marker | **rejected** (`401`) |

The `401` carries an actionable message:

> `Signature must use canon:"v2" (payload-covering). Set canon:"v2" or upgrade your AEP SDK.`

(For unrecognised marker values the error reads: `Unsupported canon '<value>' — only canon:"v2" is accepted.`)

Why require the *explicit* marker (and reject unmarked-but-deep)? The published
v2-default SDKs all set `canon:"v2"`, so requiring it doesn't break them — only
legacy emitters are turned away. The marker is outside HMAC coverage, but this is
safe: acceptance **also** requires the deep HMAC to verify, which an attacker
cannot forge without the secret, so adding/stripping the marker can't manufacture
a valid signature.

**v2 is the default in all three SDKs** (Node, Python, Go) and they are published
(npm `@surpradhan/aep` >= 0.4.0, PyPI `agent-event-protocol` >= 0.3.0, Go
`sdks/go` >= v0.3.0), so newly-signed events carry `canon: "v2"` and payload
coverage out of the box. An SDK's explicit `canon: "v1"` option still exists but
the server rejects what it emits.

> **History (issue #65):** the server previously also accepted a legacy v1
> (envelope-only) form and an unmarked "transition" mode, gated by a
> `REQUIRE_CANON_V2` flag and signalled via RFC 8594 `Deprecation`/`Sunset`
> headers (`SIGNATURE_V1_SUNSET`). Those were retired in stages and **removed
> entirely in Phase E** — only the v2 form remains.

> **Cross-language note:** byte-exact v2 across the Node/Python/Go SDKs requires
> a shared number-serialization rule (this server uses ECMAScript
> `JSON.stringify` semantics). Typical payloads (strings, integers, booleans,
> nested objects/arrays) agree across runtimes; the Go SDK additionally implements
> ECMAScript `Number`-to-string and string-escaping rules so float and special-
> character edge cases also match. All three SDKs default to the same v2 bytes,
> locked by a shared server-derived known-answer vector. Delivered in issue #59.

**Observability (issue #65).** The server classifies every signature verification
by its canonical form and exposes it on `GET /metrics/prometheus`:

- `aep_signature_verifications_total{form="v2",marked="true"|"false"}` — accepted
  signatures (`marked` = a `signature.canon` field was present; accepted events
  are always `form="v2"`). The same counts appear under `signatures` in the JSON
  `GET /metrics`.
- `aep_signature_verifications_rejected_total{marked="true"|"false"}` — failures.

These labels are deliberately low cardinality (no tenant/source/key).

---

## Audit Export (tamper-evident bundles)

> Phase 14. PR-A shipped the JSON bundle + CLI; PR-B the HTTP download
> endpoints (`GET /sessions/{id}/audit-bundle`, `GET /workflows/{traceId}/audit-bundle`);
> PR-C the PDF report rendering (`aep audit render`, `?format=pdf`).

`aep audit export` packages a session's events into a signed, offline-verifiable
bundle. The bundle carries two cryptographic checks:

1. **`manifest.content_digest`** — a SHA-256 over the canonical, ordered event
   sequence. Modifying any event (including nested payloads), reordering events,
   or adding/dropping one changes this digest.
2. **`signature`** — an HMAC-SHA256 over the manifest, keyed by
   `AUDIT_SIGNING_SECRET`. Because `content_digest` is part of the manifest, the
   signature transitively covers the events, and the manifest itself cannot be
   edited without invalidating the signature.

This provides **tamper *detection*** — not storage immutability. The
`AUDIT_SIGNING_SECRET` is a *server-side* key, separate from the per-API-key HMAC
secrets above (which sign individual events in transit). Keep it secret and
stable: rotating it invalidates signatures on previously exported bundles.

```bash
export AUDIT_SIGNING_SECRET=$(openssl rand -hex 32)

# Build a signed bundle for a session (events fetched via the read API):
aep audit export ses_abc123 --out bundle.json

# Verify it offline anywhere the secret is available (exit 0 = valid, 1 = tampered):
aep audit verify bundle.json
aep audit verify bundle.json --json   # machine-readable result

# Render a verified bundle as a human-readable PDF report for compliance review:
aep audit render bundle.json --out report.pdf
aep audit export ses_abc123 --out bundle.json --pdf   # JSON + PDF companion in one step
```

The PDF is a *rendering only* — integrity guarantees attach to the JSON bundle,
and the report prints the bundle's content digest (and the verification result
it was rendered with) so a reviewer can tie it back to a verified bundle.
`aep audit render` refuses to render a bundle that fails verification unless
`--force` is passed, in which case the report states INVALID - TAMPERING
DETECTED prominently. Over HTTP, append `?format=pdf` to either audit-bundle
endpoint to download the report instead of the JSON bundle.

If `AUDIT_SIGNING_SECRET` is unset, these commands fail with a clear error
(mirroring how `ADMIN_TOKEN` gates the `/admin/*` routes).

> **Note on scope:** v2 per-event signatures cover the full event including nested
> payloads (the deep canonical form removes the `signature` field then sorts every
> key recursively). The audit bundle adds a separate `content_digest` over the
> *ordered sequence* of events in a session export, making post-export tampering
> (event deletion, reordering, or payload edits) detectable offline — complementary
> to per-event signing, not a substitute.

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
