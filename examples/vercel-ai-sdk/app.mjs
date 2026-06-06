// Minimal Vercel AI SDK example with telemetry → AEP via the OTEL Collector.
//
// Boot the OTEL Node SDK FIRST (see tracing.mjs); then run:
//   node --import ./tracing.mjs ./app.mjs
//
// Needs OPENAI_API_KEY (or swap to any other @ai-sdk/* provider).
// Vercel emits ai.generateText / ai.generateText.doGenerate / ai.toolCall spans;
// the Collector's `aep` exporter (otelbridge/) maps them into AEP events.

import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "What is the weather in Lisbon? Use the get_weather tool.",
  tools: {
    get_weather: tool({
      description: "Look up the current weather for a city.",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, tempC: 22, summary: "sunny" }),
    }),
  },
  experimental_telemetry: {
    isEnabled: true,
    // functionId → operation.name suffix + resource.name. Lands in
    // payload.attributes."ai.telemetry.functionId" on every AEP event.
    functionId: "weather-demo",
    // metadata → payload.attributes."ai.telemetry.metadata.<key>". A handy
    // way to attach a stable correlation id (the AEP session_id is always
    // derived from the OTEL trace; metadata is for your own filtering).
    metadata: {
      "demo.kind": "vercel-ai-sdk-otel-bridge",
    },
    // Off by default — uncommenting these includes the prompt + tool
    // args/results in payload.attributes. Mind PII before enabling, especially
    // in production. Left disabled here to match the default Vercel behavior.
    // recordInputs: true,
    // recordOutputs: true,
  },
});

console.log("Vercel AI SDK result:");
console.log("  text:", result.text);
console.log("  toolCalls:", result.toolCalls?.length ?? 0);
console.log(
  "  → see AEP dashboard at http://localhost:8787/dashboard for the trace.",
);
