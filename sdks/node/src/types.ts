/**
 * Core AEP type definitions — the 12 event types, agent roles, and the event
 * envelope shape (v0.2.0). Mirrors `sdks/python/aep/_types.py` and the Go SDK's
 * `types.go`.
 */

export const EventType = {
  TASK_CREATED: "task.created",
  TASK_UPDATED: "task.updated",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",
  TOOL_CALLED: "tool.called",
  TOOL_RESULT: "tool.result",
  MEMORY_READ: "memory.read",
  MEMORY_WRITE: "memory.write",
  HANDOFF_STARTED: "handoff.started",
  HANDOFF_COMPLETED: "handoff.completed",
  POLICY_BLOCKED: "policy.blocked",
  ERROR_RAISED: "error.raised",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

/** The 12 core v0.2.0 event types, in canonical order. */
export const CORE_EVENT_TYPES: readonly string[] = Object.values(EventType);

export const AgentRole = {
  ORCHESTRATOR: "orchestrator",
  SUBAGENT: "subagent",
  STANDALONE: "standalone",
} as const;

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

/** An AEP v0.2.0 event envelope. */
export interface AEPEvent {
  specversion: string;
  id: string;
  time: string;
  source: string;
  type: string;
  session_id: string;
  trace_id: string;
  payload: Record<string, unknown>;

  parent_session_id?: string;
  agent_role?: string;
  subject?: string;
  causation_id?: string;
  idempotency_key?: string;
  schema?: string;
  content_type?: string;
  signature?: { alg: string; value: string; canon?: string };
  tenant?: string;
  labels?: Record<string, string>;
  extensions?: Record<string, unknown>;

  // Forward-compatible: the envelope schema allows additional properties.
  [key: string]: unknown;
}

/** Result of {@link validateEvent}. `errors` entries prefixed `[warn]` are non-blocking. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Result of {@link verifySignature}. */
export interface SignatureResult {
  valid: boolean;
  error?: string;
}
