const CORE_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.completed",
  "task.failed",
  "tool.called",
  "tool.result",
  "memory.read",
  "memory.write",
  "handoff.started",
  "handoff.completed",
  "policy.blocked",
  "error.raised"
];

module.exports = { CORE_EVENT_TYPES };
