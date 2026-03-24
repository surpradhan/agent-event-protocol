/**
 * Sub-agent research demo (AEP v0.2)
 *
 * Illustrates a multi-agent hierarchy using parent_session_id and agent_role,
 * then exercises the Session Tree API and Workflow API to verify the server
 * correctly reconstructs the hierarchy.
 *
 * Topology:
 *
 *   orchestrator  (ses_orch_*)
 *   └─ sub-agent: web retrieval      (ses_ret_web_*)
 *   └─ sub-agent: arXiv retrieval    (ses_ret_arxiv_*)
 *   └─ sub-agent: patent retrieval   (ses_ret_patents_*)
 *
 * All sessions share a single trace_id so a consumer can reconstruct the tree.
 * Sub-agents carry parent_session_id = orchestrator's session_id.
 *
 * After emitting all events the demo calls:
 *   GET /sessions/:orchId/tree   — verifies the orchestrator's descendant tree
 *   GET /workflows/:traceId      — verifies the full workflow view
 *   GET /metrics                 — shows the new workflow_count / max_tree_depth fields
 *
 * The web-retrieval sub-agent also demonstrates payload.$schema: its
 * tool.called payload references a local payload schema so the validator
 * can enforce the shape of known tool call payloads.
 */

const { createEvent, emitScenario, scenarioEnvelope, wait } = require("./demo-utils");

const ts = Date.now();
const orchSessionId   = `ses_orch_${ts}`;
const webSessionId    = `ses_ret_web_${ts}`;
const arxivSessionId  = `ses_ret_arxiv_${ts}`;
const patentSessionId = `ses_ret_patents_${ts}`;
const traceId         = `trc_multiagent_${ts}`;

// ─── envelope helpers ─────────────────────────────────────────────────────────

const orchEnv = scenarioEnvelope({
  source: "agent://research-orchestrator",
  sessionId: orchSessionId,
  traceId,
  agentRole: "orchestrator"
});

const webEnv = scenarioEnvelope({
  source: "agent://retrieval-web",
  sessionId: webSessionId,
  traceId,
  agentRole: "subagent",
  parentSessionId: orchSessionId
});

const arxivEnv = scenarioEnvelope({
  source: "agent://retrieval-arxiv",
  sessionId: arxivSessionId,
  traceId,
  agentRole: "subagent",
  parentSessionId: orchSessionId
});

const patentEnv = scenarioEnvelope({
  source: "agent://retrieval-patents",
  sessionId: patentSessionId,
  traceId,
  agentRole: "subagent",
  parentSessionId: orchSessionId
});

// ─── event factories ──────────────────────────────────────────────────────────

async function buildOrchestratorEvents(spawnCausationId) {
  const e1 = createEvent({
    ...orchEnv,
    type: "task.created",
    payload: {
      objective: "Comprehensive landscape report: AI agent observability",
      subtasks: ["web-search", "arxiv-search", "patent-search"],
      output_format: "executive-briefing"
    }
  });

  await wait(20);

  // Orchestrator signals it is handing off parallel work via handoff.started
  const eHandoff = createEvent({
    ...orchEnv,
    type: "handoff.started",
    causation_id: e1.id,
    payload: {
      from_agent: "research-orchestrator",
      to_team: "retrieval-subagents",
      handoff_reason: "parallel retrieval across web, arXiv, and patents",
      sub_sessions: [webSessionId, arxivSessionId, patentSessionId]
    }
  });

  return { orchStart: e1, orchHandoff: eHandoff };
}

function buildWebRetrievalEvents(causationId) {
  const e1 = createEvent({
    ...webEnv,
    type: "task.created",
    causation_id: causationId,
    payload: {
      query: "AI agent observability vendors 2025",
      source_type: "web"
    }
  });

  const e2 = createEvent({
    ...webEnv,
    type: "tool.called",
    causation_id: e1.id,
    payload: {
      // $schema demonstrates payload validation against a local schema file
      "$schema": "https://aep.dev/schemas/payloads/tool-called.schema.json",
      tool_name: "web.search",
      arguments: { query: "AI agent observability vendors 2025", limit: 10 }
    }
  });

  const e3 = createEvent({
    ...webEnv,
    type: "tool.result",
    causation_id: e2.id,
    payload: {
      tool_name: "web.search",
      output: {
        hits: 8,
        urls: [
          "https://example.com/vendor-a",
          "https://example.com/vendor-b",
          "https://example.com/vendor-c"
        ]
      }
    }
  });

  const e4 = createEvent({
    ...webEnv,
    type: "task.completed",
    causation_id: e3.id,
    payload: {
      result_count: 8,
      top_snippet: "Vendors differentiate on replay, policy controls, and multi-agent tracing"
    }
  });

  return [e1, e2, e3, e4];
}

function buildArxivRetrievalEvents(causationId) {
  const e1 = createEvent({
    ...arxivEnv,
    type: "task.created",
    causation_id: causationId,
    payload: {
      query: "LLM agent tracing observability",
      source_type: "arxiv"
    }
  });

  const e2 = createEvent({
    ...arxivEnv,
    type: "tool.called",
    causation_id: e1.id,
    payload: {
      tool_name: "arxiv.search",
      arguments: { query: "LLM agent tracing observability", max_results: 5 }
    }
  });

  const e3 = createEvent({
    ...arxivEnv,
    type: "tool.result",
    causation_id: e2.id,
    payload: {
      tool_name: "arxiv.search",
      output: {
        papers: [
          { title: "Trace-Aware LLM Agents", arxiv_id: "2401.00001" },
          { title: "Observability for Multi-Agent Systems", arxiv_id: "2402.00002" }
        ]
      }
    }
  });

  const e4 = createEvent({
    ...arxivEnv,
    type: "task.completed",
    causation_id: e3.id,
    payload: {
      result_count: 2,
      key_finding: "Distributed tracing with W3C TraceContext is the dominant academic proposal"
    }
  });

  return [e1, e2, e3, e4];
}

function buildPatentRetrievalEvents(causationId) {
  const e1 = createEvent({
    ...patentEnv,
    type: "task.created",
    causation_id: causationId,
    payload: {
      query: "AI agent execution tracing logging",
      source_type: "patents"
    }
  });

  const e2 = createEvent({
    ...patentEnv,
    type: "tool.called",
    causation_id: e1.id,
    payload: {
      tool_name: "patent.search",
      arguments: { query: "AI agent execution tracing", jurisdiction: "US", limit: 5 }
    }
  });

  const e3 = createEvent({
    ...patentEnv,
    type: "tool.result",
    causation_id: e2.id,
    payload: {
      tool_name: "patent.search",
      output: {
        results: [
          { title: "Method for distributed agent telemetry", patent_id: "US20250000001" }
        ]
      }
    }
  });

  const e4 = createEvent({
    ...patentEnv,
    type: "task.completed",
    causation_id: e3.id,
    payload: {
      result_count: 1,
      coverage: "thin — patent landscape still early"
    }
  });

  return [e1, e2, e3, e4];
}

async function buildOrchestratorSynthesis(handoffId, subResults) {
  const eMem = createEvent({
    ...orchEnv,
    type: "memory.write",
    causation_id: handoffId,
    payload: {
      note_id: "synthesis-memo-1",
      sources: subResults,
      summary: "Web: 8 vendors; arXiv: distributed-trace proposals dominant; Patents: thin landscape"
    }
  });

  await wait(20);

  const eHandoffDone = createEvent({
    ...orchEnv,
    type: "handoff.completed",
    causation_id: eMem.id,
    payload: {
      from_team: "retrieval-subagents",
      to_agent: "research-orchestrator",
      status: "all_sub_agents_complete"
    }
  });

  await wait(20);

  const eDone = createEvent({
    ...orchEnv,
    type: "task.completed",
    causation_id: eHandoffDone.id,
    payload: {
      deliverable: "5-page executive briefing",
      confidence: "high",
      sub_sessions_used: [webSessionId, arxivSessionId, patentSessionId]
    }
  });

  return [eMem, eHandoffDone, eDone];
}

// ─── tree API helpers ──────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} returned HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Pretty-print a session tree node, indenting each level.
 */
function printTree(node, indent = 0) {
  const pad  = "  ".repeat(indent);
  const role = node.session.agent_role ? ` [${node.session.agent_role}]` : "";
  console.log(`${pad}├─ ${node.session.session_id}${role}  (${node.session.event_count} events)`);
  for (const child of node.children) {
    printTree(child, indent + 1);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";

  // 1. Orchestrator kicks off
  const { orchStart, orchHandoff } = await buildOrchestratorEvents();

  // 2. Sub-agents work in "parallel" (interleaved for single-process demo)
  await wait(20);
  const webEvents    = buildWebRetrievalEvents(orchHandoff.id);
  const arxivEvents  = buildArxivRetrievalEvents(orchHandoff.id);
  const patentEvents = buildPatentRetrievalEvents(orchHandoff.id);

  // 3. Orchestrator synthesizes results
  const synthEvents = await buildOrchestratorSynthesis(orchHandoff.id, [
    { session: webSessionId,    result: webEvents[webEvents.length - 1].payload },
    { session: arxivSessionId,  result: arxivEvents[arxivEvents.length - 1].payload },
    { session: patentSessionId, result: patentEvents[patentEvents.length - 1].payload }
  ]);

  // Emit all events: orchestrator open → sub-agents interleaved → orchestrator close
  const allEvents = [
    orchStart, orchHandoff,
    ...webEvents, ...arxivEvents, ...patentEvents,
    ...synthEvents
  ];

  const results = await emitScenario({
    scenarioName: "subagent-research",
    baseUrl,
    events: allEvents
  });

  console.log("\n=== Emit results ===");
  console.log(
    JSON.stringify(
      {
        scenario: "subagent-research",
        topology: {
          orchestrator: orchSessionId,
          subagents: { web: webSessionId, arxiv: arxivSessionId, patents: patentSessionId }
        },
        trace_id: traceId,
        results
      },
      null,
      2
    )
  );

  // ── 4. Exercise the Session Tree API ──────────────────────────────────────
  console.log("\n=== GET /sessions/:id/tree (orchestrator) ===");
  const sessionTree = await fetchJson(`${baseUrl}/sessions/${orchSessionId}/tree`);
  printTree(sessionTree);
  console.log(JSON.stringify(sessionTree, null, 2));

  // ── 5. Exercise the Workflow API ──────────────────────────────────────────
  console.log(`\n=== GET /workflows/${traceId} ===`);
  const workflow = await fetchJson(`${baseUrl}/workflows/${traceId}`);
  console.log(`trace_id:      ${workflow.trace_id}`);
  console.log(`session_count: ${workflow.session_count}`);
  console.log("Workflow tree:");
  for (const root of workflow.tree) {
    printTree(root);
  }

  // ── 6. Show updated metrics ───────────────────────────────────────────────
  console.log("\n=== GET /metrics ===");
  const metrics = await fetchJson(`${baseUrl}/metrics`);
  console.log(JSON.stringify(
    {
      session_count:         metrics.session_count,
      workflow_count:        metrics.workflow_count,
      subagent_session_count: metrics.subagent_session_count,
      max_tree_depth:        metrics.max_tree_depth,
      accepted:              metrics.accepted,
      received:              metrics.received
    },
    null,
    2
  ));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
