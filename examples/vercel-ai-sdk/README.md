# Vercel AI SDK → AEP — minimal worked example

A tiny illustrative wiring of the Vercel AI SDK's `experimental_telemetry` into
AEP through the OpenTelemetry Collector bridge. **Not** part of any CI suite —
running it end-to-end needs an LLM API key, a running Collector built with the
AEP exporter, and a running AEP server. See
[`docs/integrations/vercel-ai-sdk.md`](../../docs/integrations/vercel-ai-sdk.md)
for the full walkthrough and the honest caveats about how Vercel's `ai.*`
spans currently map onto AEP event types.

## Files

| File                    | What it is                                                        |
| ----------------------- | ----------------------------------------------------------------- |
| `tracing.mjs`           | Boot file — initializes the OTEL Node SDK, points it at the Collector. |
| `app.mjs`               | A single `generateText` call with one tool, telemetry enabled.    |
| `collector-config.yaml` | Drop-in Collector config that exports to the AEP ingest server.   |

## Run it

> Prerequisites: Node ≥ 20.6 (needed for `node --import`), an `OPENAI_API_KEY` (or swap the model for any
> `@ai-sdk/*` provider you prefer), the AEP server running on `:8787` with
> `ADMIN_TOKEN` set, and an OTEL Collector built via ocb with the AEP exporter
> (see [`otelbridge/README.md`](../../otelbridge/README.md)).

```bash
# 1. Install Vercel AI SDK + OTEL deps in this directory. (npm writes a
#    package.json + node_modules here; both are gitignored — see .gitignore —
#    so they won't be accidentally committed to the AEP repo.)
npm init -y >/dev/null
npm install ai @ai-sdk/openai zod \
  @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-grpc \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @opentelemetry/sdk-trace-base

# 2. Mint a write-scoped AEP API key
export ADMIN_TOKEN=dev-admin
export AEP_API_KEY=$(curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"tenantId":"demo","label":"vercel-ai-sdk","scopes":["read","write"]}' \
  | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).key))")

# 3. Start the Collector (built per otelbridge/README.md)
../../otelbridge/_build/aep-collector --config ./collector-config.yaml &

# 4. Run the demo
export OPENAI_API_KEY=sk-...
node --import ./tracing.mjs ./app.mjs

# 5. Open the dashboard — your trace will show one AEP session
open http://localhost:8787/dashboard
```

You will see one AEP session (id `ses_<trace_id[:16]>`) containing one
`task.completed` event per Vercel span, with `payload.span_name` indicating
which Vercel operation it was (e.g. `ai.generateText`, `ai.toolCall`,
`ai.generateText.doGenerate`). `gen_ai.*` attributes are nested under
`payload.gen_ai`; the rest of the `ai.*` attributes are under
`payload.attributes`. Causation between spans is preserved via `causation_id`.

For an explanation of *why* every span lands as `task.completed` today — and
the small Collector-processor patch you can drop in to break tool calls and
errors out into `tool.result` / `error.raised` — see the integration doc.
