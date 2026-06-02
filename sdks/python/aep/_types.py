from enum import Enum


class EventType(str, Enum):
    TASK_CREATED = "task.created"
    TASK_UPDATED = "task.updated"
    TASK_COMPLETED = "task.completed"
    TASK_FAILED = "task.failed"
    TOOL_CALLED = "tool.called"
    TOOL_RESULT = "tool.result"
    MEMORY_READ = "memory.read"
    MEMORY_WRITE = "memory.write"
    HANDOFF_STARTED = "handoff.started"
    HANDOFF_COMPLETED = "handoff.completed"
    POLICY_BLOCKED = "policy.blocked"
    ERROR_RAISED = "error.raised"


class AgentRole(str, Enum):
    ORCHESTRATOR = "orchestrator"
    SUBAGENT = "subagent"
    STANDALONE = "standalone"


CORE_EVENT_TYPES: list[str] = [e.value for e in EventType]
