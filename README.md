# AEP MVP

Minimal reference implementation for AEP v0.1:
- envelope validation (JSON Schema + core event type gate)
- event factory utility
- HTTP ingest endpoint with id dedupe
- session/metrics APIs for demo observability
- browser dashboard for user-friendly event timelines
- CLI validator
- three concrete demos: support agent, IT ops agent, research agent

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
```

Each demo emits a realistic event chain with shared `session_id` and `trace_id`:
- support: ticket triage, KB lookup, tool calls, resolution
- itops: incident triage, metric check, policy block, handoff
- research: search workflow, synthesis memory write, report completion

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
