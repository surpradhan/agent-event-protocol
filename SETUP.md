# AEP Setup & Integration Guide

**Version:** 0.2.0 · **Last Updated:** March 24, 2026

This guide walks you through setting up the AEP reference implementation and integrating event emission into your existing AI agents. By the end, your agents will emit structured, traceable events that you can observe in real time through the AEP dashboard.

---

## Table of Contents

1. [What is AEP?](#1-what-is-aep)
2. [Prerequisites](#2-prerequisites)
3. [Installation & Server Setup](#3-installation--server-setup)
4. [AEP Envelope Schema](#4-aep-envelope-schema)
5. [Core Event Types](#5-core-event-types)
6. [Integration Steps](#6-integration-steps)
7. [The emit() Helper Function](#7-the-emit-helper-function)
8. [Chaining Events with causation_id](#8-chaining-events-with-causation_id)
9. [Mapping Agent Actions to Event Types](#9-mapping-agent-actions-to-event-types)
10. [Multi-Agent Systems](#10-multi-agent-systems)
11. [Full Integration Example](#11-full-integration-example)
12. [Observing Events in the Dashboard](#12-observing-events-in-the-dashboard)
13. [CLI Reference](#13-cli-reference)
14. [API Reference](#14-api-reference)
15. [Docker Deployment](#15-docker-deployment)
16. [Production Considerations](#16-production-considerations)

---

## 1. What is AEP?

The Agent Event Protocol (AEP) is a lightweight, domain-agnostic standard for capturing and observing AI agent activity. It defines a common envelope format and a small vocabulary of core event types that describe the lifecycle of any agent's work: tasks being created and completed, tools being called, memory being accessed, handoffs between agents, and policy enforcement.

AEP is purely an **observability layer** — it doesn't run your agents or change their behaviour. You emit events at key moments; AEP captures, validates, and visualises them.

AEP uses an **at-least-once delivery model**. Every event has a unique `id`, and the ingest server deduplicates by that ID atomically, so agents can safely retry without creating duplicate records. Events within a single agent run share a `session_id` and `trace_id`, making it easy to reconstruct the full chain of actions after the fact.

---

## 2. Prerequisites

- Node.js 20 or later (tested with Node 20 and 22)
- npm (comes with Node.js)
- A running agent (any language) that can make HTTP POST requests
- A terminal for running the ingest server

---

## 3. Installation & Server Setup

### Step 1: Install dependencies

From the project root:

```bash
npm install
```

### Step 2: Start the ingest server

**Dev mode** (no auth required — suitable for local development only):

```bash
npm run ingest
```

You should see:

```
AEP ingest listening on http://localhost:8787
```

**With auth enabled** (recommended for any network-accessible deployment):

```bash
ADMIN_TOKEN=change-me DASHBOARD_TOKEN=change-me npm run ingest
```

### Step 3: Generate an API key (auth mode only)

Once `ADMIN_TOKEN` is set, create an API key before emitting events:

```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"my-org","label":"dev key","scopes":["read","write"]}'
```

The response includes the raw key — **shown once only**. Store it somewhere safe, then use it on all subsequent requests:

```bash
Authorization: Bearer aep_<your-key>
```

> **Full auth reference:** See [AUTH.md](./AUTH.md) for API key scopes, HMAC signing setup, tenant isolation, and dashboard token configuration.

### Step 4: Verify the server is running

```bash
curl http://localhost:8787/health
```

Expected response:

```json
{ "ok": true, "service": "aep-ingest", "version": "0.2.0" }
```

> **Note:** The `version` field reflects the server build, not the AEP `specversion`. The server defaults to port `8787`. Set the `PORT` environment variable to change it (e.g., `PORT=9000 npm run ingest`).

---

## 4. AEP Envelope Schema

Every AEP event is a JSON object that conforms to the envelope schema. The envelope ensures a consistent structure so that any consumer (dashboards, analytics, alerting) can process events from any agent without custom parsing.

### Required fields

| Field | Type | Description |
|---|---|---|
| `specversion` | string | Protocol version. Must be `"0.2.0"` |
| `id` | string | Unique event identifier (UUID recommended) |
| `time` | string | ISO 8601 timestamp of when the event occurred |
| `source` | string | Identifier for the emitting agent (e.g., `"agent://my-agent"`) |
| `type` | string | One of the 12 core event types (see Section 5) |
| `session_id` | string | Groups all events from one agent run or conversation |
| `trace_id` | string | Groups events in one logical workflow or trace |
| `payload` | object | Event-specific data (free-form JSON object) |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `causation_id` | string | ID of the event that directly caused this one |
| `subject` | string | Subject or topic of the event |
| `idempotency_key` | string | Client-provided key for deduplication |
| `schema` | string | Payload schema identifier (e.g., `"aep.tool.called/1"`) |
| `content_type` | string | Payload media type (default: `"application/json"`) |
| `signature` | object | Cryptographic signature metadata |
| `tenant` | string | Multi-tenant namespace identifier |
| `labels` | object | Key-value string tags for filtering |
| `extensions` | object | Arbitrary extension data |
| `parent_session_id` | string | `session_id` of the parent agent that spawned this session. Omit for root/standalone sessions. *(Added in v0.2.0)* |
| `agent_role` | enum | Role of the agent: `"orchestrator"`, `"subagent"`, or `"standalone"`. *(Added in v0.2.0)* |

---

## 5. Core Event Types

AEP v0.2.0 defines exactly 12 core event types. The ingest server rejects any event whose type is not in this list. This constraint ensures a consistent, queryable vocabulary across all agents.

| Event Type | Category | When to Use |
|---|---|---|
| `task.created` | Task Lifecycle | Agent receives a new task or user request |
| `task.updated` | Task Lifecycle | Task state changes (e.g., progress update, priority change) |
| `task.completed` | Task Lifecycle | Agent finishes a task successfully |
| `task.failed` | Task Lifecycle | Agent fails to complete a task |
| `tool.called` | Tool Usage | Agent invokes an external tool or API |
| `tool.result` | Tool Usage | Agent receives a response from a tool |
| `memory.read` | Memory | Agent reads from a knowledge base or context store |
| `memory.write` | Memory | Agent writes to a knowledge base or context store |
| `handoff.started` | Handoff | Agent begins transferring control to another agent |
| `handoff.completed` | Handoff | Handoff is acknowledged or completed |
| `policy.blocked` | Governance | A policy or guardrail prevents an action |
| `error.raised` | Error | An unexpected error occurs during processing |

---

## 6. Integration Steps

Integrating AEP into an existing agent requires three things: generating session identifiers at startup, emitting events at key decision points, and chaining events together with `causation_id`.

### Step 1: Generate session identifiers

At the start of every agent run (or conversation), generate a `session_id` and `trace_id`. All events in this run share these two values, which is what ties them together in the dashboard.

```javascript
const sessionId = `ses_${crypto.randomUUID()}`;
const traceId   = `trc_${crypto.randomUUID()}`;
```

> **Note:** Any string format works. The demos use a prefix + UUID pattern for readability, but the format is not validated.

### Step 2: Emit events at key moments

Wherever your agent performs a meaningful action — receives a task, calls a tool, reads memory — construct an event and POST it to `/events`. Section 7 provides a ready-made helper function for this.

### Step 3: Chain events with causation_id

When one event directly causes the next, pass the first event's `id` as the `causation_id` of the second. This creates a causal chain that the dashboard renders as a connected timeline and DAG.

---

## 7. The emit() Helper Function

Below is a minimal helper function you can drop into any agent. It handles event construction, UUID generation, timestamping, and the HTTP POST to the ingest server.

### JavaScript / Node.js

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

### Python

```python
import uuid, datetime, os, requests

AEP_URL     = os.getenv("AEP_INGEST_URL", "http://localhost:8787")
AEP_API_KEY = os.getenv("AEP_API_KEY", "")
SOURCE      = "agent://my-agent"

session_id = None
trace_id   = None

def init_session():
    global session_id, trace_id
    session_id = f"ses_{uuid.uuid4()}"
    trace_id   = f"trc_{uuid.uuid4()}"

def emit(event_type, payload, causation_id=None):
    event = {
        "specversion": "0.2.0",
        "id":          f"evt_{uuid.uuid4().hex}",
        "time":        datetime.datetime.utcnow().isoformat() + "Z",
        "source":      SOURCE,
        "type":        event_type,
        "session_id":  session_id,
        "trace_id":    trace_id,
        "payload":     payload
    }
    if causation_id:
        event["causation_id"] = causation_id

    headers = {
        "Authorization": f"Bearer {AEP_API_KEY}",
        "Content-Type":  "application/json"
    }
    resp = requests.post(f"{AEP_URL}/events", json=event, headers=headers)
    body = resp.json()
    return {**body, "eventId": event["id"]}
```

> **Other languages (Go, Rust, Java, etc.):** The pattern is identical — construct a JSON object matching the envelope schema and POST it to `/events`. AEP is language-agnostic.

---

## 8. Chaining Events with causation_id

The `causation_id` field is the key to building a readable event timeline. Each time an event directly triggers the next action, pass the previous event's `id` forward. Here is what a typical chain looks like:

```javascript
// 1. Agent receives a task
const r1 = await emit("task.created", { task: "Summarize Q4 report" });

// 2. Agent calls a tool, caused by the task
const r2 = await emit("tool.called",
  { tool_name: "doc_reader", arguments: { file: "q4.pdf" } },
  r1.eventId  // chains to task.created
);

// 3. Tool returns a result
const r3 = await emit("tool.result",
  { tool_name: "doc_reader", output: { pages: 12, text: "..." } },
  r2.eventId  // chains to tool.called
);

// 4. Agent completes the task
const r4 = await emit("task.completed",
  { summary: "Revenue grew 15% YoY..." },
  r3.eventId  // chains to tool.result
);
```

In the dashboard, this chain renders as a connected timeline: `task.created → tool.called → tool.result → task.completed`, with full payload details at each step, and as a directed acyclic graph in the Causation DAG view.

---

## 9. Mapping Agent Actions to Event Types

Use this table as a quick reference for deciding which event type to emit at each point in your agent's logic.

| Your Agent Does This... | Emit This Event | Example Payload |
|---|---|---|
| Receives a user request or task | `task.created` | `{ task: "...", priority: "high" }` |
| Updates progress on a task | `task.updated` | `{ status: "in_progress", progress: 50 }` |
| Finishes a task successfully | `task.completed` | `{ result: "...", duration_ms: 1200 }` |
| Fails to complete a task | `task.failed` | `{ error: "timeout", retryable: true }` |
| Calls an external API or tool | `tool.called` | `{ tool_name: "search", arguments: {...} }` |
| Gets a response from a tool | `tool.result` | `{ tool_name: "search", output: {...} }` |
| Reads from a knowledge base | `memory.read` | `{ source: "kb", query: "..." }` |
| Stores something in memory | `memory.write` | `{ key: "summary", value: "..." }` |
| Hands off to another agent | `handoff.started` | `{ to_agent: "specialist", reason: "..." }` |
| Handoff is acknowledged | `handoff.completed` | `{ from_agent: "specialist" }` |
| A guardrail blocks an action | `policy.blocked` | `{ policy: "...", reason: "..." }` |
| An unexpected error occurs | `error.raised` | `{ error: "...", stack: "..." }` |

---

## 10. Multi-Agent Systems

AEP v0.2.0 adds first-class support for multi-agent and sub-agent architectures. Two optional envelope fields tie the hierarchy together:

- **`agent_role`** — set to `"orchestrator"` on the coordinating agent, `"subagent"` on agents spawned by it, and `"standalone"` for single agents with no parent/child relationship.
- **`parent_session_id`** — on each sub-agent, set this to the `session_id` of the agent that spawned it.

AEP uses these fields to reconstruct the full workflow tree automatically — no external mapping required.

### Example: orchestrator spawning a sub-agent

**Orchestrator agent** (runs first, spawns sub-agents):

```javascript
// Orchestrator sets its own session up normally
initSession(); // generates sessionId, traceId
const orchestratorSessionId = sessionId;
const sharedTraceId = traceId;

await emit("task.created", { task: "Research AI safety landscape" });
await emit("handoff.started", { to_agent: "web-search-agent" });
```

**Sub-agent** (spawned by the orchestrator):

```javascript
// Sub-agent uses the SAME traceId but its OWN sessionId
sessionId = `ses_${crypto.randomUUID()}`;
traceId   = sharedTraceId; // shared with orchestrator

const event = {
  // ... standard fields ...
  session_id:        sessionId,
  trace_id:          traceId,
  agent_role:        "subagent",
  parent_session_id: orchestratorSessionId  // links back to parent
};
```

In the dashboard's **Workflows view**, AEP assembles all sessions sharing the same `trace_id` into a collapsible nested tree, using `parent_session_id` to determine the hierarchy.

---

## 11. Full Integration Example

Here is a complete, runnable Node.js example of a support agent with AEP integrated. This mirrors the `support-agent-demo.js` included in the repository.

```javascript
const crypto = require("crypto");

const AEP_URL     = process.env.AEP_INGEST_URL || "http://localhost:8787";
const AEP_API_KEY = process.env.AEP_API_KEY    || "";
const SOURCE      = "agent://support-agent";
const sessionId   = `ses_support_${crypto.randomUUID()}`;
const traceId     = `trc_support_${crypto.randomUUID()}`;

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

  const res = await fetch(`${AEP_URL}/events`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${AEP_API_KEY}`
    },
    body: JSON.stringify(event)
  });
  return { ...(await res.json()), eventId: event.id };
}

async function handleTicket(ticketId, issue) {
  // 1. Task received
  const r1 = await emit("task.created", { ticket_id: ticketId, issue });

  // 2. Look up knowledge base
  const r2 = await emit("memory.read",
    { knowledge_base: "auth-runbook", query: issue },
    r1.eventId
  );

  // 3. Call ticketing system
  const r3 = await emit("tool.called",
    { tool_name: "ticketing.lookup", arguments: { ticket_id: ticketId } },
    r2.eventId
  );

  // ... your actual tool call logic here ...

  // 4. Tool returns result
  const r4 = await emit("tool.result",
    { tool_name: "ticketing.lookup", output: { last_error: "MFA assertion mismatch" } },
    r3.eventId
  );

  // 5. Task completed
  await emit("task.completed",
    { resolution: "Reset MFA binding", escalation_required: false },
    r4.eventId
  );

  console.log("Done. Session:", sessionId);
}

handleTicket("SUP-4217", "Cannot login after SSO migration");
```

Run a pre-built version of this with:

```bash
npm run demo:support
```

---

## 12. Observing Events in the Dashboard

Once the ingest server is running and your agent is emitting events, open the dashboard:

```
http://localhost:8787/dashboard
```

If `DASHBOARD_TOKEN` is set, the dashboard shows a login overlay on first load. Enter the token to sign in — it is stored in `sessionStorage` and sent as `Authorization: Bearer` on all subsequent API calls. You can also deep-link with `?token=<DASHBOARD_TOKEN>`.

The dashboard has two top-level tabs and updates in real time via a Server-Sent Events connection.

**Sessions view** — lists all agent sessions sorted by most recent activity. Selecting a session opens a right panel with two sub-tabs:
- *Timeline* — chronological event cards with type, timestamp, causation chain, payload, and replay controls (`Prev`, `Autoplay`, `Next`). Filter events by type or free-text search; export as JSON or CSV.
- *Causation DAG* — an SVG directed acyclic graph laying out events by causation depth, roots on the left and caused events flowing right. Cross-session causation edges appear as dashed stubs labelled "↗ cross-session".

**Workflows view** — groups sessions by `trace_id` and renders the agent hierarchy as a collapsible nested tree. Each node shows the session ID, `agent_role` badge, event count, and age. Clicking a node navigates to that session in the Sessions view. This is the primary view for multi-agent workflows.

**Real-time updates** — the dashboard connects to `GET /stream` on load and receives a push frame within milliseconds of every accepted event. A green pulsing **Live** indicator shows connection health. There is no polling.

---

## 13. CLI Reference

After `npm install`, the `aep` CLI is available via `npx aep` (or globally after `npm link`). It is useful during development for testing your integration, inspecting sessions, and validating event JSON without writing code.

```bash
aep --help             # global usage
aep <command> --help   # per-command help
```

Global flags on all commands: `--server <url>` (default `http://localhost:8787`), `--key <api-key>`. Both can be set via `AEP_SERVER` and `AEP_API_KEY` environment variables.

| Command | What it does | Example |
|---|---|---|
| `aep emit` | Emit a single event to the ingest server | `aep emit --type task.created --source agent://x --session ses_abc --trace trc_xyz --key $AEP_API_KEY --payload '{"task":"test"}'` |
| `aep session <id>` | Print the event timeline for a session | `aep session ses_abc --key $AEP_API_KEY` |
| `aep export <id>` | Export session events to JSON or CSV | `aep export ses_abc --format csv --out events.csv --key $AEP_API_KEY` |
| `aep workflow <traceId>` | Print the full multi-agent workflow tree | `aep workflow trc_xyz --key $AEP_API_KEY` |
| `aep validate <file>` | Validate a local event JSON file | `aep validate examples/sample-event.json` |

Interactive API docs are also available at `http://localhost:8787/docs` (Swagger UI) — useful for exploring endpoints without writing curl commands.

---

## 14. API Reference

Authentication requirements: `[key:write]` = API key with write scope; `[key:read or dash]` = API key with read scope OR dashboard token; `[admin]` = `ADMIN_TOKEN` bearer; `[none]` = no auth.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/events` | key:write | Ingest a single event. Returns 202 (accepted), 200 (duplicate), 400 (validation error), 401 (auth failure). |
| GET | `/health` | none | Liveness probe. Returns `{ ok, service, version, checks: { db } }`. HTTP 503 if DB unreachable. |
| GET | `/ready` | none | Readiness probe. HTTP 200 only when DB is connected and migrations have run. Use for Kubernetes `readinessProbe`. |
| GET | `/metrics` | key:read or dash | Counters: received, accepted, rejected, duplicates, by-type breakdown, session/workflow counts, max tree depth. |
| GET | `/metrics/prometheus` | none | Prometheus text format 0.0.4. Unauthenticated — restrict at the network layer if needed. |
| GET | `/stream` | key:read or dash | Server-Sent Events. Delivers `event.received` frames in real time. Heartbeat every 15 seconds. |
| GET | `/sessions` | key:read or dash | Paginated session list. Query: `?limit=<1-500>`, `?cursor=<token>`. |
| GET | `/sessions/:id/events` | key:read or dash | Ordered event timeline. Query: `?type`, `?q`, `?limit=<1-1000>`, `?cursor`. |
| GET | `/sessions/:id/export` | key:read or dash | Export events. Query: `?format=json\|csv`, `?type`, `?q`. |
| GET | `/sessions/:id/tree` | key:read or dash | Session and all descendants as a recursive tree. |
| GET | `/workflows/:traceId` | key:read or dash | All sessions sharing a `trace_id`, assembled into a workflow tree. |
| GET | `/dashboard` | dash (if set) | Serves the browser dashboard UI. |
| GET | `/openapi.json` | none | OpenAPI 3.1 specification document. |
| GET | `/docs` | none | Swagger UI (rendered from CDN). |
| POST | `/admin/keys` | admin | Generate a new API key. Body: `{ tenantId, label?, scopes?, hmacSecret? }`. Raw key shown once only. |
| GET | `/admin/keys` | admin | List all API keys. Raw keys and secrets never returned. |
| DELETE | `/admin/keys/:id` | admin | Revoke a key immediately. |

---

## 15. Docker Deployment

A production-ready Docker setup is included for deploying beyond localhost.

```bash
# Copy and configure environment variables
cp .env.example .env
# Edit .env: set ADMIN_TOKEN, DASHBOARD_TOKEN, and any other vars

# Start with Docker Compose
docker compose up -d
docker compose logs -f aep
```

The compose file mounts a named Docker volume (`aep_data`) for the SQLite database, maps port `8787` to the host (overridable via `HOST_PORT` in `.env`), and includes a built-in `HEALTHCHECK` that polls `GET /health`.

**Build and run the image directly:**

```bash
docker build -t aep-ingest .
docker run -p 8787:8787 \
  -e ADMIN_TOKEN=change-me \
  -e DASHBOARD_TOKEN=change-me \
  -v aep_data:/data \
  aep-ingest
```

---

## 16. Production Considerations

### Authentication & secrets

Set `ADMIN_TOKEN` and `DASHBOARD_TOKEN` before any network-accessible deployment. API keys are stored as SHA-256 hashes; raw keys are shown once on creation. For additional hardening, deploy behind HTTPS and consider storing HMAC secrets in an external secrets manager (Vault, AWS Secrets Manager, etc.).

### Rate limiting

Per-API-key rate limiting is built in. The ingest endpoint enforces a fixed-window limit (default 300 req/min per key, configurable via `RATE_LIMIT_RPM`). Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers. Exceeding the limit returns HTTP 429 with a `Retry-After` header. Set `RATE_LIMIT_RPM=0` to disable.

### Persistent storage

Events and session metadata are stored in SQLite at `data/aep.db` and survive server restarts. The path is overridable via `DATABASE_PATH`. For higher throughput or multi-node deployments, consider migrating to PostgreSQL or placing a message queue (Kafka, SQS) in front of the ingest endpoint.

### Deduplication at scale

Deduplication is enforced by a unique index on `events.id` in SQLite, detecting duplicates atomically without a prior read. At high scale with a distributed ingest tier, supplement with a Redis-backed dedupe layer using TTL expiry.

### Horizontal scaling

For high-throughput deployments, put a message queue (SQS, Kafka) in front of the ingest endpoint and process events asynchronously. The schema is designed with a PostgreSQL migration in mind.

### Schema evolution

Use the optional `schema` field in the envelope to version your payloads as they evolve. The `payload.$schema` field enables per-payload validation against schemas in `schemas/payloads/` — useful for enforcing structure on specific event types as your integration matures.

### Observability

`GET /metrics/prometheus` exports event counters, per-type breakdowns, HTTP request counts, and latency histograms in Prometheus text format 0.0.4. Wire this into your existing Prometheus/Grafana stack for production monitoring.

---

*End of guide. For the full version history and migration guides, see [CHANGELOG.md](./CHANGELOG.md).*
