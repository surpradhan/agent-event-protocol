"use strict";

/**
 * Unit tests for the pure cross-session causation graph builder (no DB / I/O).
 * Covers node projection + ordering, session grouping, intra- vs cross-session
 * edge classification, root detection, and dangling-causation handling.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { buildWorkflowGraph } = require("../../src/workflowGraph");

const NOW = new Date("2026-06-15T12:00:00Z");

function ev(o = {}) {
  return {
    specversion: "0.2.0",
    id: o.id,
    time: o.time ?? "2026-06-01T00:00:00Z",
    source: o.source ?? "agent://a",
    type: o.type ?? "task.created",
    session_id: o.session_id ?? "ses_1",
    trace_id: o.trace_id ?? "trc_1",
    parent_session_id: o.parent_session_id,
    agent_role: o.agent_role,
    causation_id: o.causation_id,
    payload: o.payload ?? {}
  };
}

describe("buildWorkflowGraph — empty / shape", () => {
  test("empty input yields an empty graph", () => {
    const g = buildWorkflowGraph([], { trace_id: "trc_1", now: NOW });
    assert.equal(g.trace_id, "trc_1");
    assert.equal(g.session_count, 0);
    assert.equal(g.event_count, 0);
    assert.equal(g.edge_count, 0);
    assert.equal(g.cross_session_edge_count, 0);
    assert.deepEqual(g.sessions, []);
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
    assert.deepEqual(g.root_ids, []);
    assert.equal(g.generated_at, NOW.toISOString());
  });

  test("non-array input is treated as empty", () => {
    assert.equal(buildWorkflowGraph(null, { now: NOW }).event_count, 0);
  });

  test("derives trace_id from events when not passed", () => {
    const g = buildWorkflowGraph([ev({ id: "e1", trace_id: "trc_z" })], { now: NOW });
    assert.equal(g.trace_id, "trc_z");
  });
});

describe("buildWorkflowGraph — nodes & sessions", () => {
  test("nodes are time-ordered and projected", () => {
    const g = buildWorkflowGraph([
      ev({ id: "e2", time: "2026-06-01T00:00:02Z" }),
      ev({ id: "e1", time: "2026-06-01T00:00:01Z" }),
    ], { now: NOW });
    assert.deepEqual(g.nodes.map((n) => n.id), ["e1", "e2"]);
    assert.equal(g.nodes[0].type, "task.created");
    assert.ok("payload" in g.nodes[0]);
  });

  test("sessions are grouped with event counts, ordered by first appearance", () => {
    const g = buildWorkflowGraph([
      ev({ id: "a1", session_id: "ses_a", time: "2026-06-01T00:00:00Z", agent_role: "orchestrator" }),
      ev({ id: "b1", session_id: "ses_b", time: "2026-06-01T00:00:05Z", agent_role: "subagent" }),
      ev({ id: "a2", session_id: "ses_a", time: "2026-06-01T00:00:10Z" }),
    ], { now: NOW });
    assert.equal(g.session_count, 2);
    assert.deepEqual(g.sessions.map((s) => [s.session_id, s.event_count]), [
      ["ses_a", 2],
      ["ses_b", 1],
    ]);
    assert.equal(g.sessions[0].agent_role, "orchestrator");
  });
});

describe("buildWorkflowGraph — edges & cross-session classification", () => {
  test("intra-session causation edge is not cross_session", () => {
    const g = buildWorkflowGraph([
      ev({ id: "p", session_id: "ses_a", time: "2026-06-01T00:00:00Z" }),
      ev({ id: "c", session_id: "ses_a", time: "2026-06-01T00:00:01Z", causation_id: "p" }),
    ], { now: NOW });
    assert.equal(g.edge_count, 1);
    assert.equal(g.cross_session_edge_count, 0);
    assert.deepEqual(g.edges[0], { from: "p", to: "c", cross_session: false });
  });

  test("a causation edge spanning two sessions is flagged cross_session", () => {
    // handoff in ses_a causes a task.created in ses_b
    const g = buildWorkflowGraph([
      ev({ id: "h", session_id: "ses_a", type: "handoff.started", time: "2026-06-01T00:00:00Z" }),
      ev({ id: "t", session_id: "ses_b", type: "task.created", time: "2026-06-01T00:00:01Z", causation_id: "h" }),
    ], { now: NOW });
    assert.equal(g.edge_count, 1);
    assert.equal(g.cross_session_edge_count, 1);
    assert.equal(g.edges[0].cross_session, true);
  });

  test("a causation_id pointing outside the graph yields no edge (dangling)", () => {
    const g = buildWorkflowGraph([
      ev({ id: "c", session_id: "ses_a", causation_id: "not_in_graph" }),
    ], { now: NOW });
    assert.equal(g.edge_count, 0);
    // the node is a root (no in-graph parent)
    assert.deepEqual(g.root_ids, ["c"]);
  });

  test("roots are nodes without an in-graph causation parent", () => {
    const g = buildWorkflowGraph([
      ev({ id: "r1", time: "2026-06-01T00:00:00Z" }),
      ev({ id: "r2", time: "2026-06-01T00:00:01Z", causation_id: "external" }),
      ev({ id: "k", time: "2026-06-01T00:00:02Z", causation_id: "r1" }),
    ], { now: NOW });
    assert.deepEqual(g.root_ids.sort(), ["r1", "r2"]);
  });

  test("a realistic two-session workflow: 1 cross-session edge, 2 sessions", () => {
    const g = buildWorkflowGraph([
      ev({ id: "t1", session_id: "ses_orch", type: "task.created", time: "2026-06-01T00:00:00Z" }),
      ev({ id: "h1", session_id: "ses_orch", type: "handoff.started", time: "2026-06-01T00:00:01Z", causation_id: "t1" }),
      ev({ id: "t2", session_id: "ses_sub", type: "task.created", time: "2026-06-01T00:00:02Z", causation_id: "h1" }),
      ev({ id: "r2", session_id: "ses_sub", type: "task.completed", time: "2026-06-01T00:00:03Z", causation_id: "t2" }),
    ], { now: NOW });
    assert.equal(g.session_count, 2);
    assert.equal(g.event_count, 4);
    assert.equal(g.edge_count, 3);
    assert.equal(g.cross_session_edge_count, 1); // only h1→t2 crosses
    assert.deepEqual(g.root_ids, ["t1"]);
  });
});
