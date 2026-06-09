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
| `SIGNATURE_V1_SUNSET` | No (default: unset) | ISO-8601 date (e.g. `2026-09-06`) after which the legacy v1 signature form will be rejected. When set, drives the RFC 8594 `Sunset` header on accepted v1-signed ingest (issue #65, Phase B). Unset → no `Sunset` header. v1 is **still accepted** regardless. |
| `REQUIRE_CANON_V2` | No (default: `false`) | Opt-in strict mode (issue #65, Phase C). `true`/`1` → the server **rejects** per-event signatures that are not an explicit `canon:"v2"` deep signature (v1, unmarked, and any non-`v2` marker → `401`). Default off → transition mode (v1 **and** v2 accepted). **Independent of `SIGNATURE_V1_SUNSET`** — passing the sunset date does not auto-enable this; turning it on is an explicit operator decision. The global default flip to strict is a later phase of #65. |

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
| 401 | Unsupported `signature.canon` (must be `v1` or `v2`) |
| 401 | Legacy v1 (or unmarked) signature rejected because `REQUIRE_CANON_V2` strict mode is enabled (issue #65, Phase C) |
| 400 | Event fails schema validation (separate from signature) |

### Canonicalization versions (`signature.canon`) — issue #59

The canonical form above (steps 1–6) is **v1**: it sorts only the *top-level*
keys and passes them as `JSON.stringify`'s array replacer, which — as a side
effect — drops nested object contents (a `payload` serializes as `{}`). So a v1
signature covers the **envelope but not nested payloads**.

**v2** is a deep canonical form: drop `signature`, then recursively key-sort the
**whole** event (envelope *and* nested payloads) before HMAC. A v2 signature
therefore detects payload tampering — and it is the same deep rule the Phase 14
audit bundle uses for its `content_digest`.

Events MAY declare their form with an optional `signature.canon` field:

```json
"signature": { "alg": "hmac-sha256", "value": "<base64>", "canon": "v2" }
```

The server verifier is version-aware **and backward-compatible**:

| `signature.canon` | Verified against |
|---|---|
| `"v2"` | deep form only |
| `"v1"` | shallow (envelope-only) form only |
| *absent* | **transition mode** — accepted if it matches *either* form |

Transition mode keeps every existing emitter working unchanged (legacy shallow
emitters, and the Go SDK which already signs the deep form without a marker) with
no security weakening — both forms are HMAC-keyed by the same secret.

**v2 is now the default in all three SDKs** (Node, Python, Go — issue #59 default
flip), so newly-signed events carry `canon: "v2"` and payload coverage without
opt-in. v1 is **legacy** but still accepted by the server during the transition,
and remains selectable via `canon: "v1"` (e.g. to talk to a server that predates
version-aware verification). The server keeps **transition mode** — it does *not*
yet require v2. Hard-retiring v1 (the server requiring `canon: "v2"`) is a separate,
later, breaking change that needs a deprecation window; it is tracked separately
from issue #59.

> **Cross-language note:** byte-exact v2 across the Node/Python/Go SDKs requires
> a shared number-serialization rule (this server uses ECMAScript
> `JSON.stringify` semantics). Typical payloads (strings, integers, booleans,
> nested objects/arrays) agree across runtimes; the Go SDK additionally implements
> ECMAScript `Number`-to-string and string-escaping rules so float and special-
> character edge cases also match. All three SDKs default to the same v2 bytes,
> locked by a shared server-derived known-answer vector. Tracked in issue #59.

**Observability (issue #65).** So v1 retirement can be data-driven, the server
classifies every signature verification by its *effective* canonical form and
exposes it on `GET /metrics/prometheus`:

- `aep_signature_verifications_total{form="v1"|"v2",marked="true"|"false"}` —
  accepted signatures by effective form (`marked` = a `signature.canon` field was
  present). The same counts appear under `signatures` in the JSON `GET /metrics`.
- `aep_signature_verifications_rejected_total{marked="true"|"false"}` — failures.

These labels are deliberately low cardinality (no tenant/source/key). For
per-tenant attribution, the first legacy-v1 ingest per tenant is logged at `info`
(with `tenant_id` + `source`); the rest at `debug`. This is observability only —
it does **not** change what the server accepts.

**Deprecation signaling (issue #65, Phase B).** v1 (envelope-only, no payload
coverage) is **deprecated** in favour of v2 (payload-covering, the SDK default).
When the server accepts an *effective-v1* signature on ingest, the success
response (`202`, or `200` for a duplicate) now carries [RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)
deprecation headers so emitters can detect that they should migrate:

| Header | Value | When |
|---|---|---|
| `Deprecation` | `true` | Always, on accepted v1 ingest |
| `Link` | `<…/issues/65>; rel="deprecation"` | Always, on accepted v1 ingest |
| `Sunset` | RFC 7231 IMF-fixdate (e.g. `Sun, 06 Sep 2026 00:00:00 GMT`) | Only when `SIGNATURE_V1_SUNSET` is configured |

Set `SIGNATURE_V1_SUNSET` (an ISO-8601 date, e.g. `2026-09-06`) to advertise the
date after which v1 will be rejected. When unset, only `Deprecation`/`Link` are
emitted (no committed date yet); a set-but-unparseable value is ignored with a
startup warning. v2-signed, unsigned, and rejected requests get **no** deprecation
headers.

**Opt-in strict mode (issue #65, Phase C).** Security-sensitive deployments can
enforce payload-covering (v2) signatures *today* by setting `REQUIRE_CANON_V2`
(`true`/`1`, case-insensitive). It is **off by default** and non-breaking until
an operator turns it on. When **on**, the verifier accepts a signature **iff**:

- `signature.canon === "v2"` is present, **and**
- the signature verifies against the deep (v2) form.

Everything else is rejected with `401`:

| Signature | Strict mode (`REQUIRE_CANON_V2=true`) |
|---|---|
| `canon: "v2"`, deep-valid | **accepted** (`202`) |
| `canon: "v1"` | **rejected** (`401`) |
| *absent* marker — **even if it would verify deep** (e.g. a pre-v0.3.0 Go emitter) | **rejected** (`401`) |
| any non-`v2` / unknown marker | **rejected** (`401`) |
| `canon: "v2"` but payload-tampered (deep HMAC fails) | **rejected** (`401`) |

The `401` carries an actionable message:

> `Signature uses the deprecated v1 canonicalization; this server requires canon:"v2". Upgrade to a v2-default AEP SDK or sign with { canon: "v2" }.`

A strict rejection is a **hard `401`**, so (unlike an *accepted* v1 ingest under
Phase B) it carries **no** `Deprecation`/`Sunset` headers. Rejections still
increment `aep_signature_verifications_rejected_total`.

Why require the *explicit* marker (and reject unmarked-but-deep)? The current
v2-default SDKs all set `canon:"v2"`, so requiring it doesn't break them — only
true legacy/v1 emitters are turned away. The marker is outside HMAC coverage, but
this is safe: strict mode **also** requires the deep HMAC to verify, which an
attacker cannot forge without the secret, so adding/stripping the marker can't
manufacture a valid signature.

`REQUIRE_CANON_V2` is **independent of `SIGNATURE_V1_SUNSET`** — reaching the
sunset date does **not** auto-enable strict mode (that surprising auto-flip is
deliberately out of scope). Flipping the *global default* to strict (so the
server rejects v1 out of the box) is a separate, later, breaking phase of
issue #65.

This is **signaling only — v1 events are still accepted**. Hard rejection of v1
(the server requiring `canon: "v2"`) is a later, breaking phase of issue #65 and
needs a deprecation window first.

---

## Audit Export (tamper-evident bundles)

> Phase 14 PR-A. JSON bundles only; download endpoints and PDF rendering come in
> later PRs.

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
```

If `AUDIT_SIGNING_SECRET` is unset, both commands fail with a clear error
(mirroring how `ADMIN_TOKEN` gates the `/admin/*` routes).

> **Note on scope:** the per-event transport signature (above) canonicalizes only
> the envelope, so it does not by itself cover nested payload bytes. The audit
> bundle's `content_digest` uses a deeper serialization that *does* cover
> payloads, which is what makes the bundle suitable for compliance review.

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
