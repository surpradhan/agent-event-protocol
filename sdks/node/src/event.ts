/**
 * Event factory — `createEvent()`. Mirrors `sdks/python/aep/_event.py` and the
 * server's `src/createEvent.js`. Returns a plain object ready for JSON
 * serialisation; auto-generates `id` (`evt_<hex>`) and `time` (UTC ISO-8601 with
 * millisecond precision) when omitted.
 */

import { randomUUID } from "node:crypto";

import { SPEC_VERSION } from "./constants.js";
import { AEPEvent, AgentRole, CORE_EVENT_TYPES } from "./types.js";

const VALID_ROLES: ReadonlySet<string> = new Set(Object.values(AgentRole));

export interface CreateEventOptions {
  id?: string;
  time?: string;
  parentSessionId?: string;
  agentRole?: string;
  subject?: string;
  causationId?: string;
  idempotencyKey?: string;
  schema?: string;
  contentType?: string;
  signature?: { alg: string; value: string };
  tenant?: string;
  labels?: Record<string, string>;
  extensions?: Record<string, unknown>;
}

/**
 * Create a spec-compliant AEP v0.2.0 event envelope.
 *
 * @throws {Error} if `type` is not one of the 12 core event types, or
 *   `agentRole` is set to an invalid value.
 */
export function createEvent(
  source: string,
  type: string,
  sessionId: string,
  traceId: string,
  payload: Record<string, unknown>,
  options: CreateEventOptions = {},
): AEPEvent {
  if (!CORE_EVENT_TYPES.includes(type)) {
    throw new Error(
      `Unsupported event type: '${type}'. Must be one of: ${CORE_EVENT_TYPES.join(", ")}`,
    );
  }
  if (options.agentRole !== undefined && !VALID_ROLES.has(options.agentRole)) {
    throw new Error(
      `Invalid agent_role '${options.agentRole}'. ` +
        `Must be one of: ${[...VALID_ROLES].sort().join(", ")}`,
    );
  }

  const event: AEPEvent = {
    specversion: SPEC_VERSION,
    id: options.id ?? `evt_${randomUUID().replace(/-/g, "")}`,
    time: options.time ?? nowIso(),
    source,
    type,
    session_id: sessionId,
    trace_id: traceId,
    payload,
  };

  // Append optional fields only when provided (mirrors the Python/Go factories).
  const optional: Record<string, unknown> = {
    parent_session_id: options.parentSessionId,
    agent_role: options.agentRole,
    subject: options.subject,
    causation_id: options.causationId,
    idempotency_key: options.idempotencyKey,
    schema: options.schema,
    content_type: options.contentType,
    signature: options.signature,
    tenant: options.tenant,
    labels: options.labels,
    extensions: options.extensions,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && value !== null) {
      event[key] = value;
    }
  }

  return event;
}

/** UTC ISO-8601 timestamp with millisecond precision, e.g. `2026-06-05T10:11:12.345Z`. */
function nowIso(): string {
  // toISOString() already yields millisecond precision in UTC ("…Z").
  return new Date().toISOString();
}
