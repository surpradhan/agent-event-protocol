# Agent Event Protocol (AEP)

> Structured observability for AI agent systems — capture, trace, and debug agent workflows in real time.

[![CI](https://github.com/your-org/aep/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/aep/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

AEP is a lightweight, open protocol for observing AI agent execution. You emit events from your agents; AEP validates, stores, and visualises them — without changing how your agents run.

---

## Quick Start

**Requirements:** Node.js 20+

```bash
npm install
npm run ingest          # start the server
npm run emit:example    # emit a sample event
open http://localhost:8787/dashboard
```

**Demo scenarios:**
```bash
npm run demo:support    # support ticket triage
npm run demo:itops      # IT ops incident response
npm run demo:research   # research & synthesis
npm run demo:subagent   # orchestrator + 3 parallel sub-agents
```

---

## Features

- **Event protocol** — JSON Schema envelope with 12 event types (Task, Tool, Memory, Handoff, Error/Policy)
- **Ingest API** — schema validation, deduplication, HMAC signing, rate limiting
- **Live dashboard** — session timeline, causation DAG, multi-agent workflow tree, SSE-powered real-time updates
- **CLI** — `aep emit`, `session`, `export`, `workflow`, `validate`
- **Observability** — Prometheus metrics, structured JSON logs, health/readiness probes
- **Auth** — API key auth with tenant isolation; dev mode runs without any config

---

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Server port |
| `DATABASE_PATH` | `./data/aep.db` | SQLite path |
| `ADMIN_TOKEN` | *(unset)* | Enables `/admin/*` key management |
| `DASHBOARD_TOKEN` | *(unset)* | Secures dashboard (dev mode if unset) |

See [AUTH.md](./AUTH.md) for auth setup and [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## Docker

```bash
cp .env.example .env
docker compose up -d
```

---

## API & Docs

Interactive docs at `http://localhost:8787/docs` — or `GET /openapi.json` for the raw OpenAPI 3.1 spec.

---

## Testing

```bash
npm test                  # full suite (unit + integration)
npm run test:unit         # 55 unit tests
npm run test:integration  # 27 integration tests
```
