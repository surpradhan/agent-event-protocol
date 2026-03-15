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

    const result = await postEvent(baseUrl, event);
    results.push({ id: event.id, type: event.type, status: result.status, accepted: result.body.accepted });
  }

  return results;
}

function scenarioEnvelope({ source, sessionId, traceId }) {
  return { source, session_id: sessionId, trace_id: traceId };
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
