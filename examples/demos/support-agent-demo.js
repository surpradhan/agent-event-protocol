const { createEvent, emitScenario, scenarioEnvelope, wait } = require("./demo-utils");

async function main() {
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";
  const sessionId = `ses_support_${Date.now()}`;
  const traceId = `trc_support_${Date.now()}`;
  const env = scenarioEnvelope({
    source: "agent://support-agent",
    sessionId,
    traceId,
    agentRole: "standalone"
  });

  const e1 = createEvent({
    ...env,
    type: "task.created",
    payload: {
      ticket_id: "SUP-4217",
      customer_tier: "enterprise",
      issue: "Cannot login after SSO migration"
    }
  });

  await wait(25);

  const e2 = createEvent({
    ...env,
    type: "memory.read",
    causation_id: e1.id,
    payload: {
      knowledge_base: "auth-runbook",
      query: "sso migration login failure"
    }
  });

  await wait(25);

  const e3 = createEvent({
    ...env,
    type: "tool.called",
    causation_id: e2.id,
    schema: "aep.tool.called/1",
    payload: {
      tool_name: "ticketing.lookup",
      arguments: { ticket_id: "SUP-4217" }
    }
  });

  await wait(25);

  const e4 = createEvent({
    ...env,
    type: "tool.result",
    causation_id: e3.id,
    schema: "aep.tool.result/1",
    payload: {
      tool_name: "ticketing.lookup",
      output: { last_error: "MFA assertion mismatch", region: "us-east-1" }
    }
  });

  await wait(25);

  const e5 = createEvent({
    ...env,
    type: "task.completed",
    causation_id: e4.id,
    payload: {
      resolution: "Reset MFA binding and force new SSO assertion",
      escalation_required: false
    }
  });

  const results = await emitScenario({
    scenarioName: "support",
    baseUrl,
    events: [e1, e2, e3, e4, e5]
  });

  console.log(JSON.stringify({ scenario: "support", session_id: sessionId, trace_id: traceId, results }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
