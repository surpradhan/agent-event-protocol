# Vercel AI SDK → AEP (via the OpenTelemetry bridge)

> Send Vercel AI SDK telemetry into AEP with **no new application code** — flip on
> `experimental_telemetry`, export OTLP to an OpenTelemetry Collector running the
> AEP exporter from [`otelbridge/`](../../otelbridge/), and your `generateText` /
> `streamText` / `generateObject` / `embed` / `toolCall` spans land in the AEP
> ingest as events.

This is a **docs-only integration** — AEP does **not** ship a separate Vercel AI
SDK instrumentor. The Vercel AI SDK already emits OpenTelemetry spans natively
when telemetry is enabled, and AEP's Phase 12a Collector exporter already maps
OTEL spans to AEP events. This page documents how to wire those two together and
is honest about what does and doesn't map cleanly.

```
your app (Vercel AI SDK)
  │
  │ experimental_telemetry: { isEnabled: true }
  ▼
OTEL spans (ai.generateText, ai.toolCall, ai.streamText, …)
  │ OTLP/gRPC or OTLP/HTTP
  ▼
OpenTelemetry Collector
  │ aep exporter (otelbridge/exporters/aepexporter)
  ▼
AEP ingest server  →  /dashboard
```

---

## 1. Enable telemetry in your Vercel AI SDK code

The Vercel AI SDK (`ai` package) emits OTEL spans when you pass
`experimental_telemetry: { isEnabled: true }` to any top-level function
(`generateText`, `streamText`, `generateObject`, `streamObject`, `embed`,
`embedMany`, `rerank`). Tool execution inside those calls is automatically
captured as `ai.toolCall` child spans — you do not have to instrument tools by
hand.

```ts
// app.ts
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Plan a 3-day trip to Lisbon.",
  tools: {
    web_search: tool({
      description: "Search the web",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `results for ${query}`,
    }),
  },
  experimental_telemetry: {
    isEnabled: true,
    functionId: "trip-planner",      // → resource.name + appended to operation.name
    metadata: {                       // → ai.telemetry.metadata.<key>
      "user.tier": "pro",
      "session.id": "ses_abc123",     // see "Session correlation" below
    },
  },
});
```

You also need a tracer provider configured **once at process start** that sends
spans to the Collector. Any standard OTEL Node setup works — the SDK does not
ship a tracer, it just calls `trace.getTracer("ai")`. A minimal setup using the
batch processor and OTLP/gRPC:

```ts
// tracing.ts — import this BEFORE any "ai" import
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    // service.name → AEP source = "agent://trip-planner-app"
    [ATTR_SERVICE_NAME]: "trip-planner-app",
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: "http://localhost:4317" }),
    ),
  ],
});
sdk.start();
process.on("SIGTERM", () => sdk.shutdown());
```

```bash
node --import ./tracing.js ./app.js
```

> `node --import` requires **Node ≥ 20.6** (or ≥ 18.19). On older 20.x point
> releases use `node --loader`/`-r` equivalents or upgrade Node.
>
> The snippets above are TypeScript (`tracing.ts` / `app.ts`); the run command
> uses the compiled `.js` output. If you'd rather skip the build step, the
> [`examples/vercel-ai-sdk/`](../../examples/vercel-ai-sdk/) directory ships the
> same wiring as runnable ES modules (`tracing.mjs` / `app.mjs`) you can
> `node --import ./tracing.mjs ./app.mjs` directly.

---

## 2. Run an OTEL Collector with the AEP exporter

The `aep` exporter is **not** in the prebuilt `otel/opentelemetry-collector-contrib`
image — it's a custom component in this repo's [`otelbridge/`](../../otelbridge/)
module. Build a Collector that includes it using the ocb (OpenTelemetry
Collector Builder) workflow documented in
[`otelbridge/README.md`](../../otelbridge/README.md):

```bash
go install go.opentelemetry.io/collector/cmd/builder@v0.96.0
cd otelbridge
GOTOOLCHAIN=auto builder --config builder-config.yaml   # → ./_build/aep-collector
```

Use this Collector config (drop-in replacement for `otelbridge/collector-config.yaml`
if your app speaks both OTLP/gRPC :4317 and OTLP/HTTP :4318):

```yaml
# collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    send_batch_size: 100
    timeout: 5s

exporters:
  aep:
    server_url: http://localhost:8787       # your AEP ingest server
    api_key: ${env:AEP_API_KEY}             # write-scoped key — see below
    batch_size: 100
    flush_interval: 5s

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [aep]
```

The exporter config keys (`server_url`, `api_key`, `batch_size`,
`flush_interval`) are the literal ones declared in
[`otelbridge/exporters/aepexporter/config.go`](../../otelbridge/exporters/aepexporter/config.go).

### Mint a write-scoped API key

`POST /events` always requires an API key — there is no dev-mode bypass. Mint one
through the admin API:

```bash
export ADMIN_TOKEN=dev-admin    # the AEP server must be started with this set
export AEP_API_KEY=$(curl -s -X POST http://localhost:8787/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"tenantId":"demo","label":"vercel-ai-sdk","scopes":["read","write"]}' \
  | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).key))")

./_build/aep-collector --config collector-config.yaml
```

The pre-existing demo `otelbridge/docker-compose.yml` already wires a
`aep-bootstrap` service that mints a key for you — you can drop a Vercel app
into that compose file instead of running the binary directly.

---

## 3. What you get in AEP — the honest mapping

Below is what the existing AEP Collector exporter (`otelbridge/exporters/aepexporter/mapper.go`)
actually does with the spans the Vercel AI SDK emits. **All Vercel AI SDK spans
are recorded with OTEL span kind `INTERNAL`** (the SDK's `recordSpan` uses
`tracer.startActiveSpan(name, { attributes }, fn)` with no explicit kind in
`ai@6.x`, which I verified directly in `node_modules/ai/dist/index.mjs`). The
mapper's classification priority is **error > handoff > tool > task > default**.

| Vercel span name           | What the AEP mapper does                                            | AEP event type    |
| -------------------------- | ------------------------------------------------------------------- | ----------------- |
| `ai.generateText`          | name has no `error`/`handoff`/`tool`/`task` substring → default     | `task.completed`  |
| `ai.generateText.doGenerate` | same — default                                                    | `task.completed`  |
| `ai.streamText`            | default                                                             | `task.completed`  |
| `ai.streamText.doStream`   | default                                                             | `task.completed`  |
| `ai.generateObject`        | default                                                             | `task.completed`  |
| `ai.streamObject`          | default                                                             | `task.completed`  |
| `ai.embed` / `ai.embedMany` | default                                                            | `task.completed`  |
| `ai.rerank`                | default                                                             | `task.completed`  |
| `ai.toolCall`              | name contains `tool`, **but** kind=INTERNAL (not CLIENT/SERVER) → tool rule does **not** fire → falls through to default | `task.completed`  |
| any of the above, **failed** | status=error, **but** name contains neither `error` (error rule skipped) nor `task` (so the `task.failed` branch is skipped too) → falls through to default | `task.completed`  |

Translation: with the **stock** Collector exporter, every Vercel AI SDK span
arrives at AEP as a `task.completed` event. The classification rules were
designed for span names like `task_*`, `tool_*`, `handoff_*` (see the demo in
`otelbridge/examples/app.go`) and don't have a hand-tuned pass for Vercel's
`ai.*` names. **This is a real and currently-not-mapped gap; see "Improving the
mapping" below.**

### What does carry over cleanly

Even with everything classified as `task.completed`, the payload is rich:

- **Trace context.** OTEL `trace_id` → AEP `trace_id`; `session_id = ses_<trace_id[:16]>`
  (so all spans from one `generateText` call collapse into one AEP session);
  parent span id → `causation_id`, so the full causation DAG (the `generateText`
  span, its `doGenerate` child, every `ai.toolCall`) is preserved as parent/child
  AEP events under one session.
- **`service.name` → `source`.** Set `service.name` on your OTEL Resource and
  every event's `source` becomes `agent://<service.name>` (falls back to
  `agent://unknown`).
- **`gen_ai.*` attributes** land in `payload.gen_ai`. The Vercel AI SDK emits
  the full OTEL GenAI SIG set: `gen_ai.system` (= provider), `gen_ai.request.model`,
  `gen_ai.request.temperature`/`top_p`/`top_k`/`max_tokens`/`stop_sequences`/
  `frequency_penalty`/`presence_penalty`, `gen_ai.response.id`/`model`/
  `finish_reasons`, `gen_ai.usage.input_tokens`/`output_tokens`.
- **Everything else** (the `ai.*` attributes) lands in `payload.attributes`:
  - `operation.name` / `resource.name` (= `functionId`)
  - `ai.operationId` (e.g. `ai.generateText`, `ai.toolCall`)
  - `ai.telemetry.functionId` and every `ai.telemetry.metadata.<key>` you pass
  - `ai.model.provider` / `ai.model.id`
  - `ai.settings.<key>`, `ai.request.headers.<header>`
  - For tool spans: `ai.toolCall.name`, `ai.toolCall.id`, `ai.toolCall.args`,
    `ai.toolCall.result`
  - For LLM spans: `ai.prompt`
- **Span name** is preserved as `payload.span_name`, so even though the AEP
  event type is `task.completed`, you can filter by the underlying Vercel
  operation by querying `payload.span_name = "ai.toolCall"` etc.

> Note on inputs/outputs: by default the Vercel AI SDK **does not** export
> `ai.prompt`, `ai.toolCall.args`, `ai.toolCall.result`, or response content —
> set `experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true }`
> (or the `OTEL_INSTRUMENTATION_AI_SDK_*` env vars Vercel honors) if you want
> those in `payload.attributes`. Be mindful of PII before turning that on.

### Session correlation across calls

Two distinct `generateText()` invocations produce two distinct OTEL traces and
therefore two distinct AEP `trace_id`s and two distinct AEP `session_id`s. If
you want to stitch a multi-turn conversation into one logical AEP session, the
cleanest options today are:

1. Wrap the calls in your own outer OTEL span — every Vercel `ai.*` span will
   inherit that trace, and AEP derives one session from it.
2. Pass a stable id through `metadata` (e.g. `"session.id": "ses_abc123"`) —
   that surfaces as `payload.attributes."ai.telemetry.metadata.session.id"`, and
   you can query/group by it in AEP.

The Vercel `metadata` itself does **not** become the AEP `session_id` —
session_id is always derived from the OTEL trace.

---

## 4. Improving the mapping (optional)

If you want richer per-event-type classification (`tool.called`/`tool.result` for
`ai.toolCall`, `error.raised` for failed spans), there are three paths, in
increasing order of effort:

1. **Filter in the Collector before AEP.** Add the contrib `transformprocessor`
   to your Collector and rewrite `ai.toolCall`'s span kind to `CLIENT` (so the
   existing tool rule fires) and rename failed spans to contain `error` (so the
   error rule fires). This needs no AEP changes, but the stock
   [`otelbridge/builder-config.yaml`](../../otelbridge/builder-config.yaml) does
   **not** include `transformprocessor` — you'd add
   `github.com/open-telemetry/opentelemetry-collector-contrib/processor/transformprocessor`
   to `processors:` there and rebuild with ocb. Then:

   ```yaml
   processors:
     transform/aep_vercel:
       trace_statements:
         - context: span
           statements:
             - set(kind, SPAN_KIND_CLIENT) where name == "ai.toolCall"
             - set(name, Concat([name, "_error"], "")) where status.code == STATUS_CODE_ERROR and not IsMatch(name, ".*error.*")
   ```

   OTTL grammar varies across Collector versions; treat the snippet as a sketch
   and validate against your contrib release before deploying.

2. **Add a Vercel-specific classification pass to the AEP exporter.** A small
   patch to `otelbridge/exporters/aepexporter/mapper.go` that special-cases
   names starting with `ai.toolCall` / `ai.generateText` / etc. would map them
   to the obvious AEP types without losing the cross-language priority order.
   We'd take a PR.

3. **Write a first-party Vercel AI SDK instrumentor.** Vercel exposes
   `experimental_onToolCallStart` / `experimental_onToolCallFinish` and the
   global `setGlobalAiTelemetry` callbacks. These could be wired through the
   Node SDK's `EmissionCore`. We considered this for Phase 12g and chose the
   OTEL bridge path instead because (a) it requires no new instrumentor code,
   (b) Vercel's callback surface is `experimental_*` and has churned across
   minor versions, and (c) the OTEL bridge already exists. The OTEL path is the
   recommended one until a stable callback API ships.

---

## 5. End-to-end checklist

- [ ] `experimental_telemetry: { isEnabled: true }` set on each Vercel call you
      want to observe.
- [ ] OTEL Node SDK initialized **before** the `ai` import, with a `service.name`
      Resource attribute that you want as the AEP `source`.
- [ ] OTLP exporter pointing at the Collector (default OTLP/gRPC :4317, OTLP/HTTP :4318).
- [ ] Collector built via ocb to include the `aep` exporter
      ([`otelbridge/builder-config.yaml`](../../otelbridge/builder-config.yaml)).
- [ ] AEP ingest server reachable from the Collector at `server_url`.
- [ ] Write-scoped API key minted and exported as `AEP_API_KEY`.
- [ ] Events visible at `http://localhost:8787/dashboard` (or
      `GET /sessions/ses_<trace[:16]>/events`).

---

## 6. Worked example

See [`examples/vercel-ai-sdk/`](../../examples/vercel-ai-sdk/) for a minimal,
self-contained sketch — a `generateText` call with one tool, an OTEL Node SDK
boot file, and the Collector config. Running it end-to-end needs an LLM API
key, a running Collector, and a running AEP server, so the example is
**illustrative only** and there is no CI test for it.

---

## Verified against

- `ai@6.0.197` (telemetry source in `node_modules/ai/dist/index.mjs`)
- AEP OTEL Collector exporter — `otelbridge/exporters/aepexporter/mapper.go`
  (Phase 12a)
- AEP Python OTEL bridge — `sdks/python/aep/otel/mapper.py` (Phase 11)
- OpenTelemetry [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
