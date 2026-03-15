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

  const event = {
    specversion: "0.1.0",
    id: input.id || `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    time: input.time || new Date().toISOString(),
    source,
    type,
    session_id,
    trace_id,
    payload
  };

  const optionalFields = {
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
