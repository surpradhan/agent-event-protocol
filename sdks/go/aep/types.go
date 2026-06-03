// Package aep provides a Go SDK for the Agent Event Protocol (AEP).
// It includes event creation, validation, signing, and HTTP clients for
// emitting events to an AEP server.
package aep

// EventType represents the type of event in the AEP envelope.
// Core event types include task, tool, memory, handoff, policy, and error events.
type EventType string

const (
	// Task events
	EventTypeTaskCreated   EventType = "task.created"
	EventTypeTaskUpdated   EventType = "task.updated"
	EventTypeTaskCompleted EventType = "task.completed"
	EventTypeTaskFailed    EventType = "task.failed"

	// Tool events
	EventTypeToolCalled EventType = "tool.called"
	EventTypeToolResult EventType = "tool.result"

	// Memory events
	EventTypeMemoryRead  EventType = "memory.read"
	EventTypeMemoryWrite EventType = "memory.write"

	// Handoff events
	EventTypeHandoffStarted   EventType = "handoff.started"
	EventTypeHandoffCompleted EventType = "handoff.completed"

	// Policy and error events
	EventTypePolicyBlocked EventType = "policy.blocked"
	EventTypeErrorRaised   EventType = "error.raised"
)

// AgentRole distinguishes the role of an agent in a workflow.
// Used to identify whether an agent is an orchestrator, a sub-agent, or standalone.
type AgentRole string

const (
	AgentRoleOrchestrator AgentRole = "orchestrator" // Orchestrator managing other agents
	AgentRoleSubagent     AgentRole = "subagent"     // Sub-agent spawned by orchestrator
	AgentRoleStandalone   AgentRole = "standalone"   // Standalone agent with no hierarchy
)

var CoreEventTypes = []EventType{
	EventTypeTaskCreated,
	EventTypeTaskUpdated,
	EventTypeTaskCompleted,
	EventTypeTaskFailed,
	EventTypeToolCalled,
	EventTypeToolResult,
	EventTypeMemoryRead,
	EventTypeMemoryWrite,
	EventTypeHandoffStarted,
	EventTypeHandoffCompleted,
	EventTypePolicyBlocked,
	EventTypeErrorRaised,
}

func (et EventType) String() string {
	return string(et)
}

func (ar AgentRole) String() string {
	return string(ar)
}

// IsValidEventType checks if the given type is a core event type.
func IsValidEventType(t EventType) bool {
	for _, et := range CoreEventTypes {
		if et == t {
			return true
		}
	}
	return false
}

// IsValidAgentRole checks if the given role is valid.
func IsValidAgentRole(r AgentRole) bool {
	return r == AgentRoleOrchestrator || r == AgentRoleSubagent || r == AgentRoleStandalone
}
