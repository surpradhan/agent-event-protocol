# AEP MVP

Minimal reference implementation for AEP v0.2:
- envelope validation (JSON Schema + core event type gate + optional payload schema validation)
- event factory utility
- HTTP ingest endpoint with id dedupe
- session/metrics APIs for demo observability
- browser dashboard for user-friendly event timelines
- CLI validator
- four concrete demos: support agent, IT ops agent, research agent, and a multi-agent sub-agent demo

## Requirements
- Node.js 18+ (tested with Node 19)

## Setup
```bash
npm install
```

## Validate event JSON
```bash
npm run validate -- ./examples/sample-event.json
```

## Run ingest API
```bash
npm run ingest
```

Health check:
```bash
curl http://localhost:8787/health
```

Dashboard:
```bash
http://localhost:8787/dashboard
```

## Emit a sample event
In a separate terminal while ingest is running:
```bash
npm run emit:example
```

## Run Concrete Agent Demos
In a separate terminal while ingest is running:

```bash
npm run demo:support
npm run demo:itops
npm run demo:research
npm run demo:subagent
```

Each demo emits a realistic event chain with shared `session_id` and `trace_id`:
- **support**: ticket triage, KB lookup, tool calls, resolution — `agent_role: standalone`
- **itops**: incident triage, metric check, policy block, handoff — `agent_role: standalone`
- **research**: search workflow, synthesis memory write, report completion — `agent_role: standalone`
- **subagent**: orchestrator spawning parallel web, arXiv, and patent retrieval sub-agents — demonstrates `agent_role: orchestrator/subagent` and `parent_session_id` linkage

## API Endpoints For Demo Value
- `GET /metrics`: overall counters (received, accepted, rejected, duplicates, by type)
- `GET /sessions`: session list with counts and timestamps
- `GET /sessions/:sessionId/events`: ordered timeline for one run
  Supports query params: `type=<eventType>` and `q=<searchText>`
- `GET /sessions/:sessionId/export?format=json|csv`: export filtered session events

## Dashboard Features
- Event type filter and free-text search across IDs/types/payloads
- Replay controls (`Prev`, `Autoplay`, `Next`) for step-by-step walkthrough
- One-click session export to JSON or CSV

## Notes
- Delivery semantics here are at-least-once.
- Dedupe is in-memory for MVP (replace with Redis/DB in production).

---

## Schema Changelog

### v0.2.0 (2026-03-22)

**Breaking changes**

| Field | Change |
|---|---|
| `specversion` | Value bumped from `"0.1.0"` to `"0.2.0"`. Events with the old value will fail envelope validation. |

**New fields (all optional)**

`parent_session_id` (string) — References the `session_id` of the agent that spawned this session. Absent on root/top-level and standalone sessions. Enables tree reconstruction without requiring callers to maintain external maps.

`agent_role` (enum: `"orchestrator"` | `"subagent"` | `"standalone"`) — Explicit node-type label. Allows a consumer to classify every session without inferring role from the presence/absence of `parent_session_id` alone.

**Payload schema validation**

`payload` now accepts an optional `$schema` property (string URI). When present, the validator resolves the schema from `schemas/payloads/` and validates the payload against it. Unknown or unresolvable `$schema` references produce a `[warn]` annotation but do not mark the event invalid, preserving backward compatibility. A built-in payload schema for `tool.called` is shipped at `schemas/payloads/tool-called.schema.json`.

### Migration guide: v0.1.0 → v0.2.0

1. **Update `specversion`** in every event from `"0.1.0"` to `"0.2.0"`. The `createEvent` factory handles this automatically; hand-crafted JSON files must be updated manually.

2. **`agent_role` and `parent_session_id` are optional** — no changes required for existing single-agent scenarios. Add `agent_role: "standalone"` to existing agents for clarity; it is not validated as required.

3. **Payload `$schema` is opt-in** — existing payloads without a `$schema` key continue to be accepted as plain objects with no change in behaviour.

4. **Validator warnings** — the updated `validateEvent()` returns entries prefixed with `[warn]` for unresolvable payload schemas. Callers that treat all `errors` entries as fatal should filter by the `[warn]` prefix or check the `valid` boolean (warnings do not flip it to `false`).
