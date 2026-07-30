# AEP Setup & Integration Guide

**Event Protocol:** v0.2.0 · **Last Updated:** July 19, 2026

This guide walks you through setting up the AEP reference implementation and integrating event emission into your existing AI agents. By the end, your agents will emit structured, traceable events that you can observe in real time through the AEP dashboard.

---

## Table of Contents

1. [What is AEP?](#1-what-is-aep)
2. [Prerequisites](#2-prerequisites)
3. [Installation & Server Setup](#3-installation--server-setup)
4. [AEP Envelope Schema](#4-aep-envelope-schema)
5. [Core Event Types](#5-core-event-types)
6. [Integration Steps](#6-integration-steps)
7. [Emitting Events (SDKs & Helper)](#7-emitting-events-sdks--helper)
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

```bash
ADMIN_TOKEN=change-me npm run ingest
```

You should see:

```
AEP ingest listening on http://localhost:8787
```

**What "dev mode" does and doesn't open.** When `DASHBOARD_TOKEN` is unset, the
dashboard and read endpoints (`/sessions`, `/metrics`, `/workflows`, `/stream`)
are open for local convenience. **Ingest is different:** `POST /events` *always*
requires a write-scoped API key — there is no keyless bypass. So you need
`ADMIN_TOKEN` set (to mint a key) before you can emit events, even in dev.

For a network-accessible deployment, also set `DASHBOARD_TOKEN` to lock down the
dashboard and read APIs:

```bash
ADMIN_TOKEN=change-me DASHBOARD_TOKEN=change-me npm run ingest
```

### Step 3: Provision an API key (required before emitting)

Emitting events requires a write-scoped key. With `ADMIN_TOKEN` set, mint one:

```bash
curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"my-org","label":"dev key","scopes":["read","write"]}'
```

The response includes the raw key — **shown once only**. Export it so the
example emitter and SDKs pick it up automatically:

```bash
export AEP_API_KEY=aep_<your-key>
```

Then every ingest request sends `Authorization: Bearer $AEP_API_KEY`. The
bundled emitter (`npm run emit:example`) and the demo scripts read `AEP_API_KEY`
from the environment; a 401 means it is unset or invalid.

> **Full auth reference:** See [AUTH.md](./AUTH.md) for API key scopes, HMAC signing setup, tenant isolation, and dashboard token configuration.

### Step 4: Verify the server is running

```bash
curl http://localhost:8787/health
```

Expected response:

```json
{ "ok": true, "service": "aep-ingest", "version": "1.0.0", "checks": { "db": "ok" } }
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

Wherever your agent performs a meaningful action — receives a task, calls a tool, reads memory — construct an event and emit it to the ingest server. Section 7 covers the official SDKs (the recommended path) and a raw-HTTP helper for languages without an SDK.

### Step 3: Chain events with causation_id

When one event directly causes the next, pass the first event's `id` as the `causation_id` of the second. This creates a causal chain that the dashboard renders as a connected timeline and DAG.

---

## 7. Emitting Events (SDKs & Helper)

The recommended way to emit events is one of the **official AEP SDKs**, which build the envelope, validate it, sign it, handle retries and rate-limit back-off, and talk to the ingest server for you — so you don't hand-roll the envelope or HTTP. For languages without an SDK, a minimal raw-HTTP helper is shown at the end as a fallback.

| Language | Package | Reference |
|---|---|---|
| Python | `pip install -e "sdks/python[dev]"` | [sdks/python/README.md](./sdks/python/README.md) |
| Go | `go get github.com/surpradhan/agent-event-protocol/sdks/go@latest` | [sdks/go/README.md](./sdks/go/README.md) |

The SDK READMEs are the canonical reference for each client — this guide cross-links to them rather than restating their APIs.

### Python SDK (recommended)

```python
from aep import create_event, AEPClient

# Build a spec-compliant event (id + time are auto-generated)
event = create_event(
    source="agent://my-agent",
    type="task.created",
    session_id=session_id,
    trace_id=trace_id,
    payload={"task": "summarise document"},
    causation_id=prior_event_id,  # optional: chains to a prior event
)

# Emit to the ingest server
with AEPClient(server_url="http://localhost:8787", api_key="aep_...") as client:
    result = client.emit(event)
    # {"accepted": True, "duplicate": False, "id": "evt_..."}
```

`AEPClient` reads `AEP_INGEST_URL` and `AEP_API_KEY` from the environment automatically. The package also provides `AsyncAEPClient` (async + `emit_batch`), `validate_event()`, and `sign_event()` / `verify_signature()`. See the [Python SDK README](./sdks/python/README.md) for the async client, batch emit, HMAC signing, and multi-agent helpers.

### Go SDK (recommended)

```go
import "github.com/surpradhan/agent-event-protocol/sdks/go/aep"

event, _ := aep.CreateEvent(
    "agent://my-agent",
    aep.EventTypeTaskCreated,
    sessionID, traceID,
    map[string]interface{}{"task": "analyze document"},
    nil, // optional overrides (causation_id, agent_role, etc.)
)

client := aep.NewClient()
client.SetAPIKey("aep_...")
resp, _ := client.Emit(context.Background(), event)
```

The Go SDK also provides `AsyncClient` (concurrent `EmitBatch`), `ValidateEvent()`, and `SignEvent()` / `VerifySignature()`. See the [Go SDK README](./sdks/go/README.md) for full usage.

### Raw HTTP fallback (any language)

If there is no SDK for your language, emitting is a plain JSON POST to `/events`. The minimal Node.js helper below constructs the envelope, generates IDs and timestamps, and posts the event — port the same pattern to any HTTP-capable language.

#### JavaScript / Node.js

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

> **Using Python or Go?** Prefer the official SDKs above instead of a hand-rolled POST — they validate, sign, and retry for you. This raw helper is only for languages AEP doesn't yet ship a client for. For other languages (Rust, Java, etc.), the pattern is identical: construct a JSON object matching the envelope schema (Section 4) and POST it to `/events`. AEP is language-agnostic.

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

> **SDK example apps:** For the same end-to-end pattern using the official clients, see the runnable multi-agent demos in [`sdks/python/demos/`](./sdks/python/demos/) and [`sdks/go/examples/`](./sdks/go/examples/).

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

`--timeout <seconds>` (env `AEP_TIMEOUT`, default `30`) bounds how long a command waits on a silent server before giving up — the timer measures *inactivity*, so a large export that keeps streaming never trips it. Use `--timeout 0` to disable it for a transfer that legitimately stalls.

The CLI has 12 top-level commands. `export` additionally has an `export bulk` subcommand (documented as part of `export` below, not as a separate command).

| Command | What it does | Example |
|---|---|---|
| `aep init` | Guided first-run onboarding wizard: checks server health, mints an API key with the admin token, verifies it with a test event | `aep init --admin-token dev-admin` |
| `aep emit` | Emit a single event to the ingest server | `aep emit --type task.created --source agent://x --session ses_abc --trace trc_xyz --key $AEP_API_KEY --payload '{"task":"test"}'` |
| `aep session <id>` | Print the event timeline for a session | `aep session ses_abc --key $AEP_API_KEY` |
| `aep export <id>` | Export session events to JSON or CSV | `aep export ses_abc --format csv --out events.csv --key $AEP_API_KEY` |
| `aep export bulk` | Bulk DB export (all tenants/sessions) to local filesystem or S3 — an operator job, wired to cron / a k8s CronJob in production | `aep export bulk --sink s3 --bucket my-bucket --since 2026-01-01` |
| `aep audit <export\|verify\|render>` | Build, verify, or render a tamper-evident, HMAC-signed audit bundle | `aep audit export ses_abc --out bundle.json --key $AEP_API_KEY` |
| `aep workflow <traceId>` | Print the full multi-agent workflow tree, or (`--graph`) the cross-session causation graph | `aep workflow trc_xyz --key $AEP_API_KEY` |
| `aep analytics <subcommand>` | Policy-enforcement, performance, custom & anomaly analytics | `aep analytics performance --since 2026-07-01 --key $AEP_API_KEY` |
| `aep metrics` | Print this tenant's server metrics (`GET /metrics`, JSON) | `aep metrics --key $AEP_API_KEY` |
| `aep webhooks <subcommand>` | Register & manage outbound webhooks | `aep webhooks create --url https://example.com/hook --key $AEP_API_KEY` |
| `aep compliance report` | Compliance report templates (SOC2/HIPAA/GDPR/EU AI Act) | `aep compliance report --framework soc2 --key $AEP_API_KEY` |
| `aep admin keys <subcommand>` | Manage API keys (create / list / delete) | `aep admin keys create --label dev --admin-token $ADMIN_TOKEN` |
| `aep validate <file>` | Validate a local event JSON file | `aep validate examples/sample-event.json` |

Commands with subcommands, and their key flags (run `aep <command> --help`, or `aep <command> <subcommand> --help`, for the full list):

- **`aep export bulk`** — `--tenant <id>` (default: all tenants with a project row), `--all-tenants` (also include tenants with events but no project row), `--sink local|s3`, `--dir <path>`, `--bucket <name>`, `--region <r>`, `--endpoint <url>`, `--prefix <key>`, `--since`/`--until <iso>`, `--format jsonl|csv|parquet` (default jsonl), `--compression none|gzip|brotli` (default gzip), `--dry-run`, `--json`. S3 credentials come from the standard AWS credential chain — never passed as flags. Equivalent to `npm run export`.
- **`aep audit export <session_id>`** — `--out <file>`, `--type`, `--q`, `--allow-empty` (export even with 0 matching events), `--pdf [file]` (also render a human-readable PDF alongside the JSON bundle). Requires `AUDIT_SIGNING_SECRET`.
  - **`aep audit verify <bundle.json>`** — `--json`. Exit code `0` = valid, `1` = invalid/tampered. Requires `AUDIT_SIGNING_SECRET`.
  - **`aep audit render <bundle.json>`** — `--out <file>`, `--force` (render even when verification fails). Requires `AUDIT_SIGNING_SECRET`.
- **`aep analytics policy-blocked`** / **`performance`** — `--since`/`--until <iso>`, `--limit <n>` (1–1000, default 20), `--json`.
  - **`aep analytics anomalies`** — `--since`/`--until <iso>`, `--threshold <n>` (modified-z cutoff, default 3.5), `--limit <n>` (1–1000, default 50), `--json`.
  - **`aep analytics query`** — `--file <path>` or `--spec <json>` (query spec), `--save <name>` (save to the tenant library), `--list` (list saved queries), `--run <id>` (run a saved query), `--delete <id>`, `--json`.
- **`aep webhooks`** — `list`, `get <id>`, `create --url <target> [--events <list>] [--disabled]`, `update <id> [--url] [--events] [--enable|--disable]`, `delete <id>`, `deliveries <id> [--since] [--until] [--limit]`. `--events` is a comma-separated list of event types or `*` for all. `--json` switches `list`/`create`/`update`/`deliveries` from a compact summary to the raw response; `get` always prints the raw response; `delete` has no JSON output (204, no body). `create` returns a one-time `signing_secret` (shown once — store it).
- **`aep compliance report`** — `--framework soc2|hipaa|gdpr|eu_ai_act` (required), `--session <id>` / `--trace <id>` (optional integrity proof-point, at most one), `--since`/`--until <iso>`, `--json`, `--out <file>`, `--pdf <file>`.
- **`aep admin keys`** — `create --label <label> [--scopes read,write] [--tenant-id <id>] [--json]`, `list [--json]`, `delete <id>`. Requires `ADMIN_TOKEN` or `AEP_ADMIN_TOKEN` — either the env var or the global `--admin-token <token>` flag (as in the table example above).

Interactive API docs are also available at `http://localhost:8787/docs` (Swagger UI) — useful for exploring endpoints without writing curl commands.

---

## 14. API Reference

Authentication requirements: `[key:write]` = API key with write scope; `[key:read or dash]` = API key with read scope OR dashboard token; `[admin]` = `ADMIN_TOKEN` bearer; `[metrics]` = `METRICS_TOKEN` bearer; `[none]` = no auth.

> **API versioning:** the consumer-facing endpoints below are also served under the `/v1` prefix (e.g. `POST /v1/events`). The unversioned paths shown remain supported for backward compatibility, and every response includes an `API-Version: 1` header. Infra endpoints (`/health`, `/ready`, `/metrics/prometheus`), the dashboard/docs UI (`/dashboard`, `/docs`, `/openapi.json`), and `/admin/*` are **not** versioned.

The server exposes 45 routes, grouped below by area.

### Ingest

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/events` | key:write | Ingest a single event. Returns 202 (accepted), 200 (duplicate), 400 (validation error), 401 (auth/signature failure). |

### Read / Query

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/sessions` | key:read or dash | Paginated session list. Query: `?limit=<1-500>`, `?cursor=<token>`. |
| GET | `/sessions/:id` | key:read or dash | Single session metadata lookup. 404 if it does not exist for the tenant. |
| GET | `/sessions/:id/events` | key:read or dash | Ordered event timeline. Query: `?type`, `?q`, `?role`, `?limit=<1-1000>`, `?cursor`. |
| GET | `/sessions/:id/tree` | key:read or dash | Session and all descendants as a recursive tree. |
| GET | `/sessions/:id/export` | key:read or dash | Export events. Query: `?format=json\|csv`, `?type`, `?q`, `?role`. |
| GET | `/sessions/:id/audit-bundle` | key:read or dash | Tamper-evident, HMAC-signed audit bundle for one session. Query: `?format=json\|pdf`. 503 if `AUDIT_SIGNING_SECRET` is unset. |
| GET | `/workflows` | key:read or dash | Paginated list of the tenant's distinct `trace_id`s. Query: `?limit=<1-500>`, `?cursor`. |
| GET | `/workflows/:traceId` | key:read or dash | All sessions sharing a `trace_id`, assembled into a workflow tree. |
| GET | `/workflows/:traceId/graph` | key:read or dash | Cross-session causation graph (nodes + edges) for the whole trace, with cross-session edges flagged. |
| GET | `/workflows/:traceId/audit-bundle` | key:read or dash | Signed audit bundle covering every session in the trace. Query: `?format=json\|pdf`. 503 if `AUDIT_SIGNING_SECRET` is unset. |
| GET | `/rejections` | key:read or dash | Recent rejected events (schema/signature failures), tenant-scoped. Query: `?limit`. |

### Analytics

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/analytics/policy-blocked` | key:read or dash | Aggregates `policy.blocked` events. Query: `?since`, `?until`, `?limit`, `?format=json\|csv`. |
| GET | `/analytics/performance` | key:read or dash | p50/p95/p99 latency by tool/agent/session/operation. Query: `?since`, `?until`, `?limit`, `?format=json\|csv`. |
| GET | `/analytics/anomalies` | key:read or dash | Flags workflows deviating from baseline (robust modified-z). Query: `?since`, `?until`, `?threshold`, `?limit`, `?format=json\|csv`. |
| POST | `/analytics/query` | key:read or dash | Run an ad-hoc custom-analytics query (structured JSON spec, not SQL). |
| POST | `/analytics/saved-queries` | key:write | Save a named query to the tenant's library. Body: `{ name, spec }`. 409 on duplicate name. |
| GET | `/analytics/saved-queries` | key:read or dash | List the tenant's saved queries, newest first. |
| GET | `/analytics/saved-queries/:id` | key:read or dash | Fetch one saved query. 404 if absent. |
| POST | `/analytics/saved-queries/:id/run` | key:read or dash | Run a saved query by id. |
| DELETE | `/analytics/saved-queries/:id` | key:write | Delete a saved query. |

### Webhooks

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/webhooks` | key:write | Register a webhook. Body: `{ target_url, event_types?, enabled? }`. SSRF-guarded; returns a one-time `signing_secret`. |
| GET | `/webhooks` | key:read or dash | List the tenant's webhooks, newest first. |
| GET | `/webhooks/:id` | key:read or dash | Fetch one webhook. 404 if absent. |
| PATCH | `/webhooks/:id` | key:write | Partial update (`target_url` / `event_types` / `enabled`). |
| DELETE | `/webhooks/:id` | key:write | Remove a webhook. |
| GET | `/webhooks/:id/deliveries` | key:read or dash | Recent delivery attempts for a webhook. Query: `?since`, `?until`, `?limit`. |

### Compliance

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/compliance/report` | key:read or dash | Framework-mapped compliance report. Query: `?framework=soc2\|hipaa\|gdpr\|eu_ai_act` (required), `?session`, `?trace` (at most one), `?since`, `?until`, `?format=json\|pdf`. |

### Admin (unversioned — `/admin/*`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/admin/keys` | admin | Generate a new API key. Body: `{ tenantId, projectId?, label?, scopes?, hmacSecret? }`. Raw key shown once only. |
| GET | `/admin/keys` | admin | List all API keys. Raw keys and secrets never returned. |
| DELETE | `/admin/keys/:id` | admin | Revoke a key immediately. |
| GET | `/admin/keys/:id/access-log` | admin | API-key usage audit trail (opt-in via `ACCESS_LOG_ENABLED`). Query: `?since`, `?until`, `?limit`. |
| POST | `/admin/projects` | admin | Create a project on a named tier (event quota / retention / data-residency region). |
| GET | `/admin/projects` | admin | List all projects, each with current usage. |
| GET | `/admin/projects/:id` | admin | Fetch a single project, with current usage. 404 if absent. |

### Auth & misc

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/auth/sse-ticket` | key:read or dash | Exchange a credential for a short-lived (30s), one-time SSE ticket, so it never appears in the `/stream` URL. |
| GET | `/stream` | key:read or dash (or SSE ticket) | Server-Sent Events. Delivers `event.received` / `rejection.received` frames in real time. Heartbeat every 15 seconds. |
| GET | `/metrics` | key:read or dash | Counters: received, accepted, rejected, duplicates, by-type breakdown, session/workflow counts, max tree depth. Query: `?since`, `?until`. |
| GET | `/metrics/prometheus` | metrics | Prometheus text format 0.0.4. Open in dev when `METRICS_TOKEN` is unset; 503 in production until it is set. Scrapers send `Authorization: Bearer <token>`. |
| GET | `/health` | none | Liveness probe. Returns `{ ok, service, version, checks: { db } }`. HTTP 503 if DB unreachable. |
| GET | `/ready` | none | Readiness probe. HTTP 200 only when DB is connected and migrations have run. Use for Kubernetes `readinessProbe`. |
| GET | `/dashboard` | dash (if set) | Serves the browser dashboard UI. |
| GET | `/dashboard.html` | dash (if set) | Alias of `/dashboard`. |
| GET | `/openapi.json` | none | OpenAPI 3.1 specification document. |
| GET | `/docs` | none | Swagger UI (rendered from CDN). |

---

## 15. Docker Deployment

For Docker Compose and direct Docker run instructions, see the [Docker section in README.md](./README.md#docker). The compose file mounts a named Docker volume (`aep_data`) for the SQLite database, maps port `8787` to the host (overridable via `HOST_PORT` in `.env`), and includes a built-in `HEALTHCHECK` that polls `GET /health`.

---

## 16. Production Considerations

> **Running AEP as a service?** For storage-backend selection (SQLite vs
> Postgres), multi-tenant projects / tiers / quotas, and the retention / pruning
> runbook (with cron and Kubernetes `CronJob` recipes), see the dedicated
> [OPERATIONS.md](./OPERATIONS.md) guide. The notes below remain the quick
> reference for a single-node deployment.

### Authentication & secrets

Set `ADMIN_TOKEN` and `DASHBOARD_TOKEN` before any network-accessible deployment. See [AUTH.md](./AUTH.md) for the full auth reference: API key scopes, HMAC signing setup, tenant isolation, dashboard token configuration, security notes, and key rotation guidance.

### Rate limiting

Per-API-key rate limiting is built in. The ingest endpoint enforces a fixed-window limit (default 300 req/min per key, configurable via `RATE_LIMIT_RPM`). Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers. Exceeding the limit returns HTTP 429 with a `Retry-After` header. Set `RATE_LIMIT_RPM=0` to disable.

### Persistent storage

Events and session metadata are stored in SQLite at `data/aep.db` by default and survive server restarts. The path is overridable via `DATABASE_PATH`. For higher throughput or multi-node deployments, switch to the built-in **PostgreSQL** backend (`STORAGE_BACKEND=postgres` + `DATABASE_URL`) — see [OPERATIONS.md §1–2](./OPERATIONS.md#1-choosing-a-storage-backend) — or place a message queue (Kafka, SQS) in front of the ingest endpoint.

### Deduplication at scale

Deduplication is enforced by a unique index on `events.id` in SQLite, detecting duplicates atomically without a prior read. At high scale with a distributed ingest tier, supplement with a Redis-backed dedupe layer using TTL expiry.

### Horizontal scaling

For high-throughput deployments, put a message queue (SQS, Kafka) in front of the ingest endpoint and process events asynchronously. The schema is designed with a PostgreSQL migration in mind.

### Schema evolution

Use the optional `schema` field in the envelope to version your payloads as they evolve. The `payload.$schema` field enables per-payload validation against schemas in `schemas/payloads/` — useful for enforcing structure on specific event types as your integration matures.

### Observability

`GET /metrics/prometheus` exports event counters, per-type breakdowns, HTTP request counts, and latency histograms in Prometheus text format 0.0.4. Wire this into your existing Prometheus/Grafana stack for production monitoring. In production, set `METRICS_TOKEN` and pass it to your scraper via the Prometheus `authorization` scrape config — the endpoint returns 503 until the token is set (see [SECURITY.md](./SECURITY.md) §8).

### OpenTelemetry

Already instrumented with OpenTelemetry? You can export spans to AEP without rewriting your code — add the `AEPSpanExporter` to your tracer provider:

```python
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from aep.otel import AEPSpanExporter

provider.add_span_processor(
    BatchSpanProcessor(AEPSpanExporter(server_url="http://localhost:8787", api_key="..."))
)
```

Spans are mapped to AEP event types with trace context preserved — `trace_id` carries through to the AEP trace/session and the parent span ID becomes `causation_id`, so multi-agent causation chains are reconstructed automatically. For mapping rules, batch tuning, and full examples, see [`sdks/python/aep/otel/README.md`](./sdks/python/aep/otel/README.md).

---

*End of guide. For the full version history and migration guides, see [CHANGELOG.md](./CHANGELOG.md).*
