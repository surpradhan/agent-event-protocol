/**
 * Integration test for LangChain.js / LangGraph auto-instrumentation.
 *
 * Runs a REAL compiled `StateGraph` (orchestrator → worker-with-tool → finalize)
 * through `instrument()` and asserts the reconstructed DAG on a running AEP
 * server. Hermetic: no LLM / API key (nodes are plain functions; the tool is a
 * `DynamicTool`), and the whole suite auto-skips when no server is reachable.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { DynamicTool } from "@langchain/core/tools";

import { AEPClient } from "../../src/client";
import { flush, instrument, uninstrument } from "../../src/instrument";

const SERVER_URL = process.env.AEP_INGEST_URL ?? "http://localhost:8787";
const API_KEY = process.env.AEP_API_KEY;
let reachable = false;

beforeAll(async () => {
  try {
    const resp = await fetch(`${SERVER_URL.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    reachable = resp.ok;
  } catch {
    reachable = false;
  }
});

afterEach(async () => {
  await uninstrument();
});

function walkSessions(node: any): string[] {
  if (Array.isArray(node)) return node.flatMap(walkSessions);
  const sess = node.session ?? node;
  const out: string[] = [];
  if (sess.session_id) out.push(sess.session_id);
  for (const c of node.children ?? []) out.push(...walkSessions(c));
  return out;
}

describe("LangGraph instrumentation (live)", () => {
  it("emits a full DAG (orchestrator + node sub-agents + tool pair) to the server", async (ctx) => {
    if (!reachable) ctx.skip();

    const marker = `lc-${Math.floor(performance.now())}-${process.pid}`;

    const enabled = await instrument({ serverUrl: SERVER_URL, apiKey: API_KEY });
    expect(enabled).toBe(true);

    const weather = new DynamicTool({
      name: "get_weather",
      description: "weather",
      func: async (q: string) => `sunny in ${q}`,
    });

    const S = Annotation.Root({
      topic: Annotation<string>,
      notes: Annotation<string>,
      report: Annotation<string>,
    });

    const graph = new StateGraph(S)
      .addNode(`worker-${marker}`, async (state: any, config: any) => {
        const out = await weather.invoke(state.topic, config);
        return { notes: out };
      })
      .addNode(`finalize-${marker}`, async (state: any) => ({ report: `REPORT: ${state.notes}` }))
      .addEdge(START, `worker-${marker}`)
      .addEdge(`worker-${marker}`, `finalize-${marker}`)
      .addEdge(`finalize-${marker}`, END)
      .compile();

    const result = await graph.invoke({ topic: "Paris" });
    expect(result.report).toBe("REPORT: sunny in Paris");

    expect(await flush(10_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));

    const client = new AEPClient({ serverUrl: SERVER_URL, apiKey: API_KEY });
    const sessions = (await client.getSessions({ limit: 200 })).sessions as Array<
      Record<string, unknown>
    >;
    const sub = sessions.find((s) => String(s.source ?? "").includes(marker));
    expect(sub, "no marked sub-agent session recorded by server").toBeTruthy();

    const workflow = await client.getWorkflow(sub!.trace_id as string);
    expect((workflow.session_count as number) ?? 0).toBeGreaterThanOrEqual(2);

    const allEvents: Array<Record<string, unknown>> = [];
    for (const sid of walkSessions(workflow.tree ?? [])) {
      const evs = (await client.getSessionEvents(sid, { limit: 200 })).events as Array<
        Record<string, unknown>
      >;
      allEvents.push(...evs);
    }

    const types = new Set(allEvents.map((e) => e.type));
    expect(types.has("task.created")).toBe(true);
    expect(types.has("handoff.started")).toBe(true);
    expect(types.has("handoff.completed")).toBe(true);

    const called = allEvents.filter((e) => e.type === "tool.called");
    const toolResult = allEvents.filter((e) => e.type === "tool.result");
    expect(called.some((e) => (e.payload as any)?.tool_name === "get_weather")).toBe(true);
    expect(toolResult.length).toBeGreaterThanOrEqual(1);

    // Every causation_id in the workflow tree resolves to a real emitted event.
    const byId = new Map(allEvents.map((e) => [e.id as string, e]));
    const dangling = allEvents.filter((e) => e.causation_id && !byId.has(e.causation_id as string));
    expect(dangling).toEqual([]);
  });
});
