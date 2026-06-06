// OTEL Node SDK boot file — import BEFORE the "ai" package so the tracer
// provider is registered globally before `ai` calls `trace.getTracer("ai")`.
//
// Usage:  node --import ./tracing.mjs ./app.mjs
//
// service.name becomes the AEP source: agent://<service.name>.
// OTEL_EXPORTER_OTLP_ENDPOINT overrides the Collector address (default 4317).

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "vercel-ai-demo",
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317",
      }),
    ),
  ],
});

sdk.start();

const shutdown = () => sdk.shutdown().catch(() => undefined);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("beforeExit", shutdown);
