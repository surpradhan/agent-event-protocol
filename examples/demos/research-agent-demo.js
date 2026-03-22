const { createEvent, emitScenario, scenarioEnvelope, wait } = require("./demo-utils");

async function main() {
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";
  const sessionId = `ses_research_${Date.now()}`;
  const traceId = `trc_research_${Date.now()}`;
  const env = scenarioEnvelope({
    source: "agent://research-agent",
    sessionId,
    traceId,
    agentRole: "standalone"
  });

  const e1 = createEvent({
    ...env,
    type: "task.created",
    payload: {
      objective: "Summarize competitive landscape for AI observability",
      depth: "medium"
    }
  });

  await wait(25);

  const e2 = createEvent({
    ...env,
    type: "tool.called",
    causation_id: e1.id,
    payload: {
      tool_name: "web.search",
      arguments: { query: "AI agent observability vendors", limit: 5 }
    }
  });

  await wait(25);

  const e3 = createEvent({
    ...env,
    type: "tool.result",
    causation_id: e2.id,
    payload: {
      tool_name: "web.search",
      output: {
        hits: 5,
        urls: [
          "https://example.com/vendor-a",
          "https://example.com/vendor-b"
        ]
      }
    }
  });

  await wait(25);

  const e4 = createEvent({
    ...env,
    type: "memory.write",
    causation_id: e3.id,
    payload: {
      note_id: "memo-1",
      summary: "Top vendors differentiate on replay and policy controls"
    }
  });

  await wait(25);

  const e5 = createEvent({
    ...env,
    type: "task.completed",
    causation_id: e4.id,
    payload: {
      deliverable: "3-page briefing",
      confidence: "medium"
    }
  });

  const results = await emitScenario({
    scenarioName: "research",
    baseUrl,
    events: [e1, e2, e3, e4, e5]
  });

  console.log(JSON.stringify({ scenario: "research", session_id: sessionId, trace_id: traceId, results }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
