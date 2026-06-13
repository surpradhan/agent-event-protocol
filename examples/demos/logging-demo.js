/**
 * Logging Demo — Agent Event Protocol
 *
 * This demo emits a structured log investigation scenario:
 *   task.created → tool.called → tool.result → error.raised → task.completed
 *
 * HOW TO RUN:
 *   node examples/demos/logging-demo.js
 *
 * VIEWING RESULTS IN THE DASHBOARD:
 * After running this demo, open the dashboard to explore the emitted events:
 *
 *   1. Open the dashboard:
 *      http://localhost:8788
 *
 *   2. Find your session in the session/event timeline using the session ID
 *      printed in the console output (ses_logging_...).
 *
 *   3. Filter events by type using the #type-filter dropdown
 *      (e.g. filter by "tool.called" or "error.raised").
 *
 *   4. Export events as JSON or CSV:
 *      GET /sessions/:id/export?format=json
 *      GET /sessions/:id/export?format=csv
 */

const { createEvent, emitScenario, scenarioEnvelope, wait } = require("./demo-utils");

async function main() {
  const baseUrl = process.env.AEP_INGEST_URL || "http://localhost:8787";
  const sessionId = `ses_logging_${Date.now()}`;
  const traceId = `trc_logging_${Date.now()}`;
  const env = scenarioEnvelope({
    source: "agent://logging-agent",
    sessionId,
    traceId,
    agentRole: "standalone"
  });

  const e1 = createEvent({
    ...env,
    type: "task.created",
    payload: {
      alert_id: "LOG-8842",
      service: "checkout-api",
      issue: "Spike in 5xx errors after deploy"
    }
  });

  await wait(25);

  const e2 = createEvent({
    ...env,
    type: "tool.called",
    causation_id: e1.id,
    payload: {
      tool_name: "logs.search",
      arguments: {
        service: "checkout-api",
        level: "error",
        window: "15m"
      }
    }
  });

  await wait(25);

  const e3 = createEvent({
    ...env,
    type: "tool.result",
    causation_id: e2.id,
    payload: {
      tool_name: "logs.search",
      output: {
        match_count: 847,
        top_error: "ConnectionPoolTimeoutError",
        sample_trace_id: "trc_checkout_9f2a"
      }
    }
  });

  await wait(25);

  const e4 = createEvent({
    ...env,
    type: "error.raised",
    causation_id: e3.id,
    payload: {
      error_type: "ConnectionPoolTimeoutError",
      message: "Pool exhausted under post-deploy traffic",
      retryable: false
    }
  });

  await wait(25);

  const e5 = createEvent({
    ...env,
    type: "task.completed",
    causation_id: e4.id,
    payload: {
      resolution: "Increased pool size and rolled back canary",
      escalation_required: false
    }
  });

  const results = await emitScenario({
    scenarioName: "logging",
    baseUrl,
    events: [e1, e2, e3, e4, e5]
  });

  console.log(JSON.stringify({ scenario: "logging", session_id: sessionId, trace_id: traceId, results }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
