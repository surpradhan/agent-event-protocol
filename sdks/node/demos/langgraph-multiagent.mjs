/**
 * LangGraph.js multi-agent workflow with AEP auto-instrumentation.
 *
 * Phase 12g PR2 headline demo. A single `await instrument()` makes an unmodified
 * LangGraph `graph.invoke(...)` emit a full AEP event DAG — with no other code
 * changes. The graph run becomes the orchestrator, each node becomes a sub-agent
 * `task.*` reached via a `handoff.*`, and every tool call becomes a
 * `tool.called` / `tool.result` pair — all on one `trace_id`.
 *
 * Topology:
 *   graph (orchestrator)
 *     ├─ handoff ─► researcher  ── web_search tool ──┐
 *     └─ handoff ─► writer                           ▼
 *                                            (final report)
 *
 * Runs OFFLINE with no LLM API key — the nodes are plain functions and the tool
 * is a DynamicTool. The LangGraph runtime, its callbacks, and the AEP
 * instrumentation are all genuine.
 *
 * Build the SDK first (`npm run build` in sdks/node), then:
 *   ADMIN_TOKEN=ta node src/server.js                 # start a server (repo root)
 *   # mint a write key, then:
 *   AEP_INGEST_URL=http://localhost:8787 AEP_API_KEY=<key> \
 *     node sdks/node/demos/langgraph-multiagent.mjs
 */
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { DynamicTool } from "@langchain/core/tools";

import { AEPClient, flush, instrument, uninstrument } from "../dist/index.js";

const SERVER_URL = process.env.AEP_INGEST_URL ?? "http://localhost:8787";

// The entire integration: one line, before running the graph.
if (!(await instrument({ serverUrl: SERVER_URL, apiKey: process.env.AEP_API_KEY }))) {
  console.log("AEP instrumentation could not be enabled (is @langchain/langgraph installed?).");
}

const webSearch = new DynamicTool({
  name: "web_search",
  description: "Search the web and return a short summary.",
  func: async (q) => `42 sources found for '${q}'`,
});

const S = Annotation.Root({
  topic: Annotation,
  notes: Annotation,
  report: Annotation,
});

const graph = new StateGraph(S)
  .addNode("researcher", async (state, config) => {
    const notes = await webSearch.invoke(state.topic, config);
    return { notes };
  })
  .addNode("writer", async (state) => ({
    report: `REPORT — ${state.topic}: ${state.notes}. Ready to ship.`,
  }))
  .addEdge(START, "researcher")
  .addEdge("researcher", "writer")
  .addEdge("writer", END)
  .compile();

console.log("\n=== Running 2-node LangGraph workflow ===\n");
const result = await graph.invoke({ topic: "AI agent observability" });
console.log("report:", result.report);

await flush(10_000);
await new Promise((r) => setTimeout(r, 300));

console.log("\n=== AEP workflow (from server) ===");
try {
  const client = new AEPClient({ serverUrl: SERVER_URL, apiKey: process.env.AEP_API_KEY });
  const sessions = (await client.getSessions({ limit: 50 })).sessions ?? [];
  const orch = sessions.find((s) => s.agent_role === "orchestrator");
  if (!orch) {
    console.log("No orchestrator session found yet — is the server running?");
  } else {
    const tree = await client.getSessionTree(orch.session_id);
    const walk = (node, depth = 0) => {
      const sess = node.session ?? node;
      console.log(
        `  ${"  ".repeat(depth)}└─ ${sess.session_id} [${sess.agent_role}] (${sess.event_count ?? "?"} events)`,
      );
      for (const c of node.children ?? []) walk(c, depth + 1);
    };
    console.log(`Orchestrator session: ${orch.session_id}`);
    walk(tree);
  }
} catch (e) {
  console.log(`Server verification skipped (${e.message}).`);
}
await uninstrument();
console.log(`\nDashboard: ${SERVER_URL}/dashboard`);
