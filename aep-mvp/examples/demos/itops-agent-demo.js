const { createEvent, emitScenario, scenarioEnvelope, wait } = require("./demo-utils");

async function main() {
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";
  const sessionId = `ses_itops_${Date.now()}`;
  const traceId = `trc_itops_${Date.now()}`;
  const env = scenarioEnvelope({
    source: "agent://itops-agent",
    sessionId,
    traceId
  });

  const e1 = createEvent({
    ...env,
    type: "task.created",
    payload: {
      alert_id: "ALRT-9911",
      service: "checkout-api",
      severity: "critical",
      symptom: "p95 latency > 4s"
    }
  });

  await wait(25);

  const e2 = createEvent({
    ...env,
    type: "tool.called",
    causation_id: e1.id,
    payload: {
      tool_name: "monitoring.query",
      arguments: { window: "15m", metric: "latency_p95", service: "checkout-api" }
    }
  });

  await wait(25);

  const e3 = createEvent({
    ...env,
    type: "tool.result",
    causation_id: e2.id,
    payload: {
      tool_name: "monitoring.query",
      output: { latency_p95_ms: 4300, error_rate: 0.12 }
    }
  });

  await wait(25);

  const e4 = createEvent({
    ...env,
    type: "policy.blocked",
    causation_id: e3.id,
    payload: {
      policy: "auto-restart-in-business-hours",
      reason: "requires human approval",
      retryable: true
    }
  });

  await wait(25);

  const e5 = createEvent({
    ...env,
    type: "handoff.started",
    causation_id: e4.id,
    payload: {
      from_agent: "itops-agent",
      to_team: "oncall-sre",
      handoff_reason: "prod restart requires approval"
    }
  });

  const results = await emitScenario({
    scenarioName: "itops",
    baseUrl,
    events: [e1, e2, e3, e4, e5]
  });

  console.log(JSON.stringify({ scenario: "itops", session_id: sessionId, trace_id: traceId, results }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
