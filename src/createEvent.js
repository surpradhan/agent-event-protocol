const crypto = require("crypto");
const { CORE_EVENT_TYPES } = require("./coreEventTypes");

function createEvent(input) {
  if (!input || typeof input !== "object") {
    throw new Error("input is required");
  }

  const {
    source,
    type,
    session_id,
    trace_id,
    payload,
    parent_session_id,
    agent_role,
    subject,
    causation_id,
    idempotency_key,
    schema,
    content_type,
    signature,
    tenant,
    labels,
    extensions
  } = input;

  if (!CORE_EVENT_TYPES.includes(type)) {
    throw new Error(`Unsupported event type: ${type}`);
  }

  if (agent_role !== undefined) {
    const validRoles = ["orchestrator", "subagent", "standalone"];
    if (!validRoles.includes(agent_role)) {
      throw new Error(`Invalid agent_role '${agent_role}'. Must be one of: ${validRoles.join(", ")}`);
    }
  }

  const event = {
    specversion: "0.2.0",
    id: input.id || `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    time: input.time || new Date().toISOString(),
    source,
    type,
    session_id,
    trace_id,
    payload
  };

  const optionalFields = {
    parent_session_id,
    agent_role,
    subject,
    causation_id,
    idempotency_key,
    schema,
    content_type,
    signature,
    tenant,
    labels,
    extensions
  };

  for (const [key, value] of Object.entries(optionalFields)) {
    if (value !== undefined) {
      event[key] = value;
    }
  }

  return event;
}

module.exports = { createEvent };
