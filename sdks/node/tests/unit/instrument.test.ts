/**
 * Unit tests for the LangGraph → AEP mapping (`LangGraphMapper` + `EmissionCore`).
 *
 * These drive the mapper with normalized callback info (plain objects, the shape
 * the LangChain handler adapter passes) + a recorder client — *without LangChain
 * installed*, because the mapper/core never import it. The real
 * `BaseCallbackHandler` patch is covered by the integration test.
 *
 * Mirrors the Python LangGraph instrumentor's coverage shape.
 */

import { describe, expect, it } from "vitest";

import { EmissionCore, LangGraphMapper } from "../../src/instrument";
import type { AEPEvent } from "../../src/types";

class Recorder {
  events: AEPEvent[] = [];
  _server_url = "mock";
  async emit(event: AEPEvent) {
    this.events.push(event);
    return { accepted: true };
  }
}

async function drive(
  fn: (m: LangGraphMapper) => void,
  opts: { client?: Recorder; maxRuns?: number } = {},
): Promise<{ rec: Recorder; core: EmissionCore }> {
  const rec = opts.client ?? new Recorder();
  const core = new EmissionCore(rec, opts.maxRuns ?? 10_000);
  fn(new LangGraphMapper(core));
  expect(await core.flush(5000)).toBe(true);
  return { rec, core };
}

const byType = (evs: AEPEvent[]) => evs.map((e) => e.type);
const dangling = (evs: AEPEvent[]) => {
  const ids = new Set(evs.map((e) => e.id));
  return evs.filter((e) => e.causation_id && !ids.has(e.causation_id as string)).map((e) => e.id);
};

describe("LangGraphMapper", () => {
  it("emits the orchestrator pair for a graph root", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null, name: "LangGraph", tags: [] });
      m.onChainEnd("root");
    });
    expect(byType(rec.events)).toEqual(["task.created", "task.completed"]);
    expect(rec.events.every((e) => e.agent_role === "orchestrator")).toBe(true);
    // The root is named by its runName ("LangGraph"); falls back to "graph" when absent.
    expect(rec.events[0]!.source).toBe("agent://LangGraph");
    expect(rec.events[0]!.payload.framework).toBe("langgraph");
    expect(rec.events[1]!.causation_id).toBe(rec.events[0]!.id);
    expect(new Set(rec.events.map((e) => e.trace_id)).size).toBe(1);
  });

  it("opens a node as a sub-agent via handoff and closes it", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null, name: "LangGraph" });
      m.onChainStart({ runId: "n1", parentRunId: "root", node: "worker", tags: ["graph:step:1"] });
      m.onChainEnd("n1");
      m.onChainEnd("root");
    });
    expect(byType(rec.events)).toEqual([
      "task.created", // root orchestrator
      "handoff.started", // root -> worker
      "task.created", // worker sub-agent
      "task.completed", // worker closes
      "handoff.completed", // root closes the handoff
      "task.completed", // root closes
    ]);
    const [rootOpen, ho, sub, subDone, hoDone] = rec.events;
    expect(ho!.causation_id).toBe(rootOpen!.id);
    expect(sub!.causation_id).toBe(ho!.id);
    expect(sub!.agent_role).toBe("subagent");
    expect(sub!.parent_session_id).toBe(rootOpen!.session_id);
    expect(sub!.source).toBe("agent://worker");
    expect(subDone!.causation_id).toBe(sub!.id);
    expect(hoDone!.causation_id).toBe(ho!.id);
    expect(dangling(rec.events)).toEqual([]);
    expect(new Set(rec.events.map((e) => e.trace_id)).size).toBe(1);
  });

  it("skips framework-internal hidden chains (e.g. __start__)", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null, name: "LangGraph" });
      m.onChainStart({
        runId: "start",
        parentRunId: "root",
        node: "__start__",
        tags: ["graph:step:0", "langsmith:hidden"],
      });
      m.onChainEnd("start");
      m.onChainEnd("root");
    });
    // No handoff/sub-agent for __start__; just the orchestrator pair.
    expect(byType(rec.events)).toEqual(["task.created", "task.completed"]);
  });

  it("ignores intermediate runnables (no langgraph_node, has parent)", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null, name: "LangGraph" });
      m.onChainStart({ runId: "mid", parentRunId: "root", node: null, name: "RunnableSeq" });
      m.onChainEnd("mid");
      m.onChainEnd("root");
    });
    expect(byType(rec.events)).toEqual(["task.created", "task.completed"]);
  });

  it("treats a node with an untracked parent as a root", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "orphan", parentRunId: "never-seen", node: "lonely" });
      m.onChainEnd("orphan");
    });
    // Becomes its own orchestrator (no handoff), still a clean pair.
    expect(byType(rec.events)).toEqual(["task.created", "task.completed"]);
    expect(rec.events[0]!.agent_role).toBe("orchestrator");
  });

  it("emits tool called/result on the node's session", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null, name: "LangGraph" });
      m.onChainStart({ runId: "n1", parentRunId: "root", node: "worker" });
      m.onToolStart({
        runId: "t1",
        parentRunId: "n1",
        name: "get_weather",
        input: '{"city":"Paris"}',
      });
      m.onToolEnd("t1", "sunny");
      m.onChainEnd("n1");
      m.onChainEnd("root");
    });
    const called = rec.events.find((e) => e.type === "tool.called")!;
    const result = rec.events.find((e) => e.type === "tool.result")!;
    const sub = rec.events.find((e) => e.type === "task.created" && e.agent_role === "subagent")!;
    expect(called.payload.tool_name).toBe("get_weather");
    expect(called.payload.arguments).toEqual({ city: "Paris" }); // JSON string coerced
    expect(called.session_id).toBe(sub.session_id);
    expect(called.causation_id).toBe(sub.id);
    expect(result.causation_id).toBe(called.id);
    expect(result.payload.output).toBe("sunny");
    expect(dangling(rec.events)).toEqual([]);
  });

  it("coerces a non-JSON tool input under `input`", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null });
      m.onToolStart({ runId: "t1", parentRunId: "root", name: "noop", input: "raw-text" });
      m.onToolEnd("t1", "ok");
      m.onChainEnd("root");
    });
    const called = rec.events.find((e) => e.type === "tool.called")!;
    expect(called.payload.arguments).toEqual({ input: "raw-text" });
  });

  it("emits error.raised on a tool error", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null });
      m.onToolStart({ runId: "t1", parentRunId: "root", name: "boom", input: "{}" });
      m.onToolError("t1", new Error("kaboom"));
      m.onChainEnd("root");
    });
    const err = rec.events.find((e) => e.type === "error.raised")!;
    expect(err.payload.tool_name).toBe("boom");
    expect(err.payload.error).toBe("kaboom");
    expect(rec.events.some((e) => e.type === "tool.result")).toBe(false);
  });

  it("emits task.failed on a chain error", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null });
      m.onChainStart({ runId: "n1", parentRunId: "root", node: "worker" });
      m.onChainError("n1", new Error("node blew up"));
      m.onChainEnd("root");
    });
    const failed = rec.events.find((e) => e.type === "task.failed")!;
    expect(failed.agent_role).toBe("subagent");
    expect(failed.payload.error).toBe("node blew up");
    // The sub-agent failure still closes the handoff on the parent.
    expect(rec.events.some((e) => e.type === "handoff.completed")).toBe(true);
    expect(dangling(rec.events)).toEqual([]);
  });

  it("two nodes form one trace with three sessions", async () => {
    const { rec } = await drive((m) => {
      m.onChainStart({ runId: "root", parentRunId: null });
      m.onChainStart({ runId: "a", parentRunId: "root", node: "researcher" });
      m.onChainEnd("a");
      m.onChainStart({ runId: "b", parentRunId: "root", node: "writer" });
      m.onChainEnd("b");
      m.onChainEnd("root");
    });
    expect(new Set(rec.events.map((e) => e.trace_id)).size).toBe(1);
    expect(new Set(rec.events.map((e) => e.session_id)).size).toBe(3);
    expect(rec.events.filter((e) => e.type === "handoff.started")).toHaveLength(2);
    expect(rec.events.filter((e) => e.type === "handoff.completed")).toHaveLength(2);
    expect(dangling(rec.events)).toEqual([]);
  });

  it("bounds the run table under many open nodes", async () => {
    const { core } = await drive(
      (m) => {
        m.onChainStart({ runId: "root", parentRunId: null });
        for (let i = 0; i < 50; i++) {
          m.onChainStart({ runId: `n${i}`, parentRunId: "root", node: `node${i}` });
        }
      },
      { maxRuns: 4 },
    );
    expect(core.runTable.size).toBeLessThanOrEqual(4);
    expect(core.evicted).toBeGreaterThanOrEqual(46);
  });

  it("swallows emit failures (host run unaffected)", async () => {
    class Boom {
      _server_url = "mock";
      async emit() {
        throw new Error("network down");
      }
    }
    // Must not throw.
    await drive(
      (m) => {
        m.onChainStart({ runId: "root", parentRunId: null });
        m.onChainEnd("root");
      },
      { client: new Boom() as unknown as Recorder },
    );
  });
});
