# API Key Quick Reference

This guide covers API key management for the Agent Event Protocol (AEP) ingest server. It's designed for developers setting up the project for the first time.

> For detailed authentication information, see [AUTH.md](../AUTH.md). For full setup instructions, see [SETUP.md](../SETUP.md).

---

## Generating an API Key

### Prerequisites

1. Start the AEP ingest server with authentication enabled:

```bash
ADMIN_TOKEN=your-admin-secret DASHBOARD_TOKEN=your-dashboard-secret npm run ingest
```

You should see:
```
AEP ingest listening on http://localhost:8787
```

2. Keep your `ADMIN_TOKEN` value handy — you'll need it to create keys.

### Process

API keys are generated via the `/admin/keys` HTTP endpoint. The process is:

1. Send a POST request to `/admin/keys`
2. Include the `ADMIN_TOKEN` in the `Authorization` header
3. Specify the tenant ID, label, and scopes
4. Store the returned key securely (it's shown **only once**)

### Example: Create a Development Key

```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "my-org",
    "label": "development key",
    "scopes": ["read", "write"]
  }'
```

**Response:**
```json
{
  "message": "API key created. Store the key securely — it will not be shown again.",
  "key": "aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "keyPrefix": "aep_a3f9e1c2",
  "tenantId": "my-org",
  "label": "development key",
  "scopes": ["read", "write"],
  "signingEnabled": false
}
```

### Key Properties

- **Format:** `aep_<48 hex characters>` (52 characters total)
- **Shown once only:** After creation, the raw key is never returned. Store it securely immediately.
- **Tenant ID:** Each key is bound to a tenant. Keys from different tenants cannot see each other's events.
- **Scopes:** Define what the key can do (see Scopes section below).

### Scopes

| Scope | Grants Access |
|-------|---------------|
| `read` | All `GET` endpoints: `/sessions`, `/metrics`, `/workflows`, `/stream` |
| `write` | `POST /events` (event ingestion) |

Most keys should include both scopes: `["read", "write"]`

> Note: `/metrics/prometheus` (the Prometheus scrape endpoint) is intentionally
> unauthenticated and does not require a `read` key. The `read` scope above
> applies to the JSON `/metrics` endpoint.

---

## Setting API Keys in Environment Variables

After generating a key, store it in environment variables so your code can access it.

### Linux / macOS

**Temporary (current shell session only):**
```bash
export AEP_API_KEY="aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"
export AEP_INGEST_URL="http://localhost:8787"
```

**Permanent (add to your shell profile):**

For bash, add to `~/.bashrc`:
```bash
export AEP_API_KEY="aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"
export AEP_INGEST_URL="http://localhost:8787"
```

For zsh, add to `~/.zshrc`:
```bash
export AEP_API_KEY="aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"
export AEP_INGEST_URL="http://localhost:8787"
```

Then reload your shell:
```bash
source ~/.bashrc  # or source ~/.zshrc
```

**Using .env file (for development):**

Create a `.env` file in your project root:
```
AEP_API_KEY=aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3
AEP_INGEST_URL=http://localhost:8787
```

Load it before running your code. Use `set -a` so the variables are
**exported** to the child process (a plain `source .env` only sets shell
variables and will not populate `process.env`):
```bash
set -a; source .env; set +a
node your-agent.js
```

Alternatively, load it from within Node.js using the `dotenv` package (see
the [Using API Keys](#using-api-keys) section below).

### Windows (PowerShell)

**Temporary (current PowerShell session only):**
```powershell
$env:AEP_API_KEY = "aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"
$env:AEP_INGEST_URL = "http://localhost:8787"
```

**Permanent (user environment variables):**

Using PowerShell (run as Administrator):
```powershell
[Environment]::SetEnvironmentVariable("AEP_API_KEY", "aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3", "User")
[Environment]::SetEnvironmentVariable("AEP_INGEST_URL", "http://localhost:8787", "User")
```

Or via GUI:
1. Press `Win + X` and select "System"
2. Click "Advanced system settings"
3. Click "Environment Variables"
4. Under "User variables," click "New"
5. Add `AEP_API_KEY` and `AEP_INGEST_URL`

**Using .env file (for development):**

Create a `.env` file:
```
AEP_API_KEY=aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3
AEP_INGEST_URL=http://localhost:8787
```

Load it in Node.js with a package like `dotenv`:
```bash
npm install dotenv
```

```javascript
require('dotenv').config();
const apiKey = process.env.AEP_API_KEY;
```

> Note: `AEP_INGEST_URL` is used in examples and SDK-style usage, while the Node CLI uses `AEP_SERVER`.

---

## Using API Keys

### In Code (JavaScript/Node.js)

```javascript
const apiKey = process.env.AEP_API_KEY;
const ingestUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";

// Emit an event
const event = {
  specversion: "0.2.0",
  id: "evt_001",
  time: new Date().toISOString(),
  source: "agent://my-agent",
  type: "task.created",
  session_id: "ses_abc123",
  trace_id: "trc_xyz789",
  payload: { task: "example" }
};

const response = await fetch(`${ingestUrl}/events`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(event)
});

console.log(response.status); // 202 Accepted or 200 Duplicate
```

### In curl Commands

Use the `Authorization: Bearer` header (recommended):

```bash
curl -X POST http://localhost:8787/events \
  -H "Authorization: Bearer $AEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{...event JSON...}'
```

Alternative: Use the `X-API-Key` header:

```bash
curl -X POST http://localhost:8787/events \
  -H "X-API-Key: $AEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{...event JSON...}'
```

---

## Rotating API Keys

Key rotation is the process of retiring an old key and creating a new one. This should be done periodically or if a key is compromised.

### Recommended Workflow

1. **Create a new key** with the same tenant ID and scopes as the old key:

```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "my-org",
    "label": "production key (rotated)",
    "scopes": ["read", "write"]
  }'
```

2. **Store the new key securely** (e.g., in your secrets manager or CI/CD system).

3. **Update your deployment** to use the new key — update environment variables, secrets, or configuration files.

4. **Verify the new key works** by running a test event emission or read request.

5. **Monitor the old key** for a grace period (24–48 hours) to catch any services still using it.

6. **Revoke the old key** (see Revoking API Keys below).

### Safe Deployment Process

For production deployments:

```bash
# 1. Generate new key
NEW_KEY=$(curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"my-org","label":"prod key new","scopes":["read","write"]}' \
  | jq -r '.key')

# 2. Update your secrets (example: GitHub Secrets, AWS Secrets Manager, etc.)
# $ gh secret set AEP_API_KEY --body "$NEW_KEY"
# or use your platform's secrets update command

# 3. Deploy your updated application

# 4. After 24–48 hours, revoke the old key:
# curl -X DELETE http://localhost:8787/admin/keys/<old-key-id> \
#   -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Migration Guidance

- **Zero-downtime:** Support both old and new keys simultaneously for a grace period.
- **Gradual rollout:** Update services one by one so you can catch issues early.
- **Monitoring:** Watch logs for 401 authentication errors after revocation.
- **Documentation:** Note the rotation date and old key ID in your records.

---

## Revoking API Keys

Revoke a key to immediately disable it. Use the key ID returned when the key was created.

### Revoke a Specific Key

```bash
curl -s -X DELETE http://localhost:8787/admin/keys/f47ac10b-58cc-4372-a567-0e02b2c3d479 \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response:**
```
HTTP 200 OK
{
  "ok": true,
  "message": "API key revoked",
  "id": "<key-id>"
}
```

If the key does not exist, the endpoint may return `404`. If the key is already revoked, a `409` response is also possible.

After revocation:
- All subsequent requests with that key receive HTTP 401 (Unauthorized)
- Revocation is **immediate** — no grace period

### When to Revoke

- **Compromised key:** Revoke immediately if you suspect a key has been exposed
- **Unused key:** Clean up keys that are no longer needed
- **Key rotation:** Revoke the old key after verifying the new one works
- **Developer departure:** Revoke personal/development keys when team members leave

### List Keys Before Revoking

If you need to find the key ID to revoke:

```bash
curl -s http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.'
```

This shows all keys (without revealing the raw key values) so you can identify which to revoke.

### Cleanup Recommendations

- Maintain a list of active keys and their purpose (dev, staging, production, etc.)
- Regularly audit unused keys and revoke them
- Document key rotation dates and reasons
- Set alerts/notifications for unexpected revocation attempts (if available)

---

## Common curl Examples

> **API versioning:** the consumer-facing endpoints (`/events`, `/sessions`, `/workflows`, `/metrics`, `/stream`, …) are also served under the `/v1` prefix (e.g. `POST /v1/events`). The unversioned paths used below remain supported for backward compatibility, and every response includes an `API-Version: 1` header. Admin endpoints (`/admin/*`) and infra probes (`/health`, `/ready`, `/metrics/prometheus`) are unversioned.

### Health Check

Verify the server is running:

```bash
curl http://localhost:8787/health
```

**Response:**
```json
{ "ok": true, "service": "aep-ingest", "version": "1.0.0", "checks": { "db": "ok" } }
```

### Emit a Single Event

```bash
curl -s -X POST http://localhost:8787/events \
  -H "Authorization: Bearer $AEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "specversion": "0.2.0",
    "id": "evt_001",
    "time": "2026-06-04T10:30:00Z",
    "source": "agent://my-agent",
    "type": "task.created",
    "session_id": "ses_abc123",
    "trace_id": "trc_xyz789",
    "payload": { "task": "process data" }
  }'
```

**Expected Response:** HTTP 202 (Accepted) or 200 (Duplicate)

### List All API Keys

```bash
curl -s http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.'
```

### Get Sessions for Your Tenant

```bash
curl -s http://localhost:8787/sessions \
  -H "Authorization: Bearer $AEP_API_KEY" | jq '.'
```

### Get Events in a Session

```bash
curl -s http://localhost:8787/sessions/ses_abc123/events \
  -H "Authorization: Bearer $AEP_API_KEY" | jq '.'
```

### Export Session Events as CSV

```bash
curl -s "http://localhost:8787/sessions/ses_abc123/export?format=csv" \
  -H "Authorization: Bearer $AEP_API_KEY" > events.csv
```

---

## Security Best Practices

### Never Commit Keys

- **Do not** commit `.env` files with real keys to version control
- **Do not** paste keys into code files
- **Do not** share keys in Slack, email, or chat

Add to `.gitignore`:
```
.env
.env.local
.env.*.local
*.key
```

### Use Environment Variables

Always load keys from environment variables, not hardcoded values:

```javascript
// ✅ Good
const apiKey = process.env.AEP_API_KEY;

// ❌ Bad
const apiKey = "aep_a3f9e1c2d4b5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3";
```

### Rotate Compromised Credentials Immediately

If a key is exposed or compromised:

1. Revoke it immediately:
   ```bash
   curl -X DELETE http://localhost:8787/admin/keys/<compromised-key-id> \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

2. Generate a new key and update all deployments

3. Review logs to see if the compromised key was used

4. Update your deployment pipeline to prevent future exposures

### Use Least Privilege

- **Read-only keys:** Create keys with only `["read"]` scope for dashboards or monitoring agents
- **Write-only keys:** Create keys with only `["write"]` scope for agents that don't query existing data
- **Tenant isolation:** Each key is bound to a tenant — leverage this for multi-tenant deployments

### Store Keys Securely in Production

- **Secrets manager:** Use AWS Secrets Manager, HashiCorp Vault, or similar
- **CI/CD secrets:** GitHub Secrets, GitLab CI/CD Variables, etc.
- **Environment files:** Use `.env` only in development; never in production
- **Key rotation:** Rotate keys periodically (monthly or quarterly)

### Audit and Monitor

- Regularly list API keys and verify they're all still in use
- Monitor logs for 401 (Unauthorized) errors — may indicate a compromised key
- Document who has access to keys and why
- Review keys after team changes (departures, role changes)

---

## Related Documentation

- **[AUTH.md](../AUTH.md)** — Detailed authentication, HMAC signing, tenant isolation, dashboard & admin tokens
- **[SETUP.md](../SETUP.md)** — Full setup guide, event schema, core event types, integration examples
- **[README.md](../README.md)** — Project overview, features, architecture
- **[SECURITY.md](../SECURITY.md)** — Security guarantees, deployment checklist, vulnerability disclosure

---

**Last Updated:** July 19, 2026  
**Server Version:** 1.0.0 · **Event Protocol:** v0.2.0  
**Documentation:** [github.com/surpradhan/agent-event-protocol](https://github.com/surpradhan/agent-event-protocol)
