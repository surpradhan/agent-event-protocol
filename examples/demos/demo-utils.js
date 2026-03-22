const { createEvent } = require("../../src/createEvent");
const { validateEvent } = require("../../src/validator");

async function postEvent(baseUrl, event) {
  let response;
  try {
    response = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
  } catch (err) {
    throw new Error(
      `Cannot reach AEP ingest at ${baseUrl}. Start it with 'npm run ingest' from the repo root.`
    );
  }

  const body = await response.json();
  return { status: response.status, body };
}

async function emitScenario({ scenarioName, baseUrl, events }) {
  const results = [];

  for (const event of events) {
    const validation = validateEvent(event);

    if (!validation.valid) {
      throw new Error(
        `[${scenarioName}] event ${event.type} failed local validation: ${validation.errors.join("; ")}`
      );
    }

    // Surface warnings without blocking
    const warnings = validation.errors.filter((e) => e.startsWith("[warn]"));
    if (warnings.length > 0) {
      warnings.forEach((w) => console.warn(`  ${w}`));
    }

    const result = await postEvent(baseUrl, event);
    results.push({ id: event.id, type: event.type, status: result.status, accepted: result.body.accepted });
  }

  return results;
}

/**
 * Build the shared envelope fields for a scenario session.
 *
 * @param {object} opts
 * @param {string} opts.source        - Agent URI, e.g. "agent://research-agent"
 * @param {string} opts.sessionId     - Unique session ID for this run
 * @param {string} opts.traceId       - Shared trace ID across all sessions in a run
 * @param {string} [opts.agentRole]   - "orchestrator" | "subagent" | "standalone"
 * @param {string} [opts.parentSessionId] - Parent session ID when role is "subagent"
 */
function scenarioEnvelope({ source, sessionId, traceId, agentRole, parentSessionId }) {
  const env = { source, session_id: sessionId, trace_id: traceId };
  if (agentRole !== undefined) env.agent_role = agentRole;
  if (parentSessionId !== undefined) env.parent_session_id = parentSessionId;
  return env;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createEvent,
  emitScenario,
  scenarioEnvelope,
  wait
};
