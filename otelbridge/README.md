# AEP OpenTelemetry Collector Bridge

> An OpenTelemetry Collector **exporter** that converts spans into Agent Event Protocol (AEP) events and sends them to an AEP ingest server.

This lets any OTEL-instrumented system (Datadog, New Relic, Jaeger, OpenLLMetry, LangChain/LangGraph via OTEL, etc.) emit to AEP through a standard Collector pipeline — no application code changes.

```
instrumented app ──OTLP──▶ OTEL Collector ──▶ AEP exporter ──HTTP──▶ AEP ingest (/events)
                           (otlp receiver)     (span→event)
```

## Module layout

```
otelbridge/
├── exporters/aepexporter/      # the AEP exporter component
│   ├── config.go               # config schema + validation + defaults
│   ├── factory.go              # Collector exporter factory (traces)
│   ├── exporter.go             # batches events, emits via the AEP Go client
│   ├── mapper.go               # pdata span → AEP event (classification rules)
│   └── mapper_test.go          # unit tests (no server required)
├── receivers/aepotlpreceiver/  # (note: we use the standard OTLP receiver)
├── examples/app.go             # demo instrumented app (env-driven OTLP endpoint)
├── builder-config.yaml         # ocb config to build a Collector with this exporter
├── collector-config.yaml       # Collector pipeline config for the demo
├── Dockerfile                  # builds the custom Collector via ocb
├── examples/Dockerfile         # builds the demo app
└── docker-compose.yml          # app → collector → AEP, with API-key bootstrap
```

The receiver side intentionally reuses the **standard OTLP receiver** — see `receivers/aepotlpreceiver/README.md`.

## Span → event mapping

Implemented in `exporters/aepexporter/mapper.go`, mirroring the reference mappers
(`sdks/python/aep/otel/mapper.py`, `sdks/go/aep/otel/mapper.go`).

Classification priority: **error > handoff > tool > task > default**.

| Span | AEP event type |
|------|----------------|
| status=error **and** name contains `error` | `error.raised` |
| name contains `handoff` | `handoff.completed` |
| name contains `tool` **and** kind ∈ {CLIENT, SERVER} | `tool.result` |
| name contains `task`, status≠error | `task.completed` |
| name contains `task`, status=error | `task.failed` |
| (otherwise) | `task.completed` |

Context preserved:
- `trace_id` → AEP `trace_id` (32-hex)
- `session_id` = `ses_<trace_id[:16]>` (parity with the Python/Go reference mappers)
- parent span id → `causation_id` (omitted for root spans)
- `service.name` → `source` = `agent://<service.name>` (falls back to `agent://unknown`)
- `gen_ai.*` attributes → `payload.gen_ai`; other attributes → `payload.attributes`

## Configuration

```yaml
exporters:
  aep:
    server_url: http://localhost:8787   # required
    api_key: ${env:AEP_API_KEY}         # bearer token for /events (see "API key")
    batch_size: 100                     # max events per ingest request
    flush_interval: 5s
```

## Building the Collector (ocb)

The `aep` exporter is a custom component, so it is **not** in the prebuilt
`otel/opentelemetry-collector-contrib` image. Build a distribution that includes it:

```bash
go install go.opentelemetry.io/collector/cmd/builder@v0.96.0
cd otelbridge
builder --config builder-config.yaml      # -> ./_build/aep-collector
./_build/aep-collector --config collector-config.yaml
```

## API key (important)

`POST /events` always requires a provisioned API key — there is **no** dev-mode
bypass (`src/server.js`: `requireApiKey("write")`). Create one via the admin API:

```bash
export ADMIN_TOKEN=...    # the server must be started with this set
curl -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"tenantId":"demo","label":"otel-collector","scopes":["read","write"]}'
# use the returned "key" as AEP_API_KEY for the exporter
```

The demo `docker-compose.yml` automates this with an `aep-bootstrap` service.

## Testing

The exporter is verified with `go test` (no server needed — tests build `ptrace.Traces` in-memory):

```bash
cd otelbridge
go test ./exporters/... -v
```

There is no local Go toolchain in the authoring environment; everything here was
verified inside `golang:1.21` via Docker (the module uses
`replace github.com/surpradhan/aep-go => ../sdks/go`, so the SDK must be present
at that relative path):

```bash
docker run --rm -v "$PWD/..":/src:ro golang:1.21 sh -c '
  mkdir -p /work/sdks && cp -r /src/otelbridge /work/otelbridge && cp -r /src/sdks/go /work/sdks/go
  cd /work/otelbridge && go mod tidy && go build ./... && go vet ./... && go test ./...'
```

## Status

**Verified (in Docker, `golang:1.21`):**
- ✅ `exporters/aepexporter` builds, vets, and unit tests pass (classification, trace-context preservation, root-span handling, service-name fallback, payload separation, empty traces).
- ✅ `examples/app.go` builds.
- ✅ `gofmt` clean.

**Not yet verified end-to-end (validate locally before relying on it):**
- 🟡 The ocb Collector build (`builder-config.yaml` / `Dockerfile`).
- 🟡 The full `docker-compose` stack (app → collector → AEP ingest), including the API-key bootstrap.
- 🟡 An integration test against a live AEP server (unit tests cover mapping; an end-to-end emit test is still to come).

## Dependencies

- `go.opentelemetry.io/collector/{component,consumer,exporter,pdata}` v0.96.0 / pdata v1.3.0
- `github.com/surpradhan/aep-go` (local, via `replace`) — for `CreateEvent` and the ingest `Client`
