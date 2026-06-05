/**
 * Minimal AEP Node SDK demo: build a small causation chain (orchestrator task +
 * a tool call/result) and emit it to a running AEP server, then read the session
 * back. Runs against a local server:
 *
 *   ADMIN_TOKEN=ta node src/server.js          # in the repo root, to start a server
 *   # mint a write key, then:
 *   AEP_INGEST_URL=http://localhost:8787 AEP_API_KEY=<key> node sdks/node/demos/emit.mjs
 *
 * Run after building the package (`npm run build` in sdks/node).
 */
import { AEPClient, createEvent } from "../dist/index.js";

const traceId = `trc_demo_${Date.now()}`;
const sessionId = `ses_demo_${Date.now()}`;
const client = new AEPClient(); // reads AEP_INGEST_URL / AEP_API_KEY

const task = createEvent("agent://demo", "task.created", sessionId, traceId, {
  goal: "demonstrate the Node SDK",
}, { agentRole: "orchestrator", subject: "node-sdk-demo" });

const toolCall = createEvent("agent://demo", "tool.called", sessionId, traceId, {
  tool_name: "search",
  arguments: { q: "agent observability" },
}, { agentRole: "orchestrator", causationId: task.id });

const toolResult = createEvent("agent://demo", "tool.result", sessionId, traceId, {
  tool_name: "search",
  output: "42 results",
}, { agentRole: "orchestrator", causationId: toolCall.id });

const done = createEvent("agent://demo", "task.completed", sessionId, traceId, {
  status: "completed",
}, { agentRole: "orchestrator", causationId: task.id });

await client.emitBatch([task, toolCall, toolResult, done]);
console.log(`Emitted 4 events on trace ${traceId}.`);

await new Promise((r) => setTimeout(r, 300));
const { events } = await client.getSessionEvents(sessionId);
console.log(`Server recorded ${events?.length ?? 0} events for ${sessionId}:`);
for (const e of events ?? []) console.log(`  ${e.type}  (causation: ${e.causation_id ?? "—"})`);
console.log(`\nDashboard: ${process.env.AEP_INGEST_URL ?? "http://localhost:8787"}/dashboard`);
