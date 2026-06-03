package aep

import (
	"testing"
)

func TestEventTypeValidation(t *testing.T) {
	tests := []struct {
		name      string
		eventType EventType
		valid     bool
	}{
		{"task.created", EventTypeTaskCreated, true},
		{"task.updated", EventTypeTaskUpdated, true},
		{"task.completed", EventTypeTaskCompleted, true},
		{"task.failed", EventTypeTaskFailed, true},
		{"tool.called", EventTypeToolCalled, true},
		{"tool.result", EventTypeToolResult, true},
		{"memory.read", EventTypeMemoryRead, true},
		{"memory.write", EventTypeMemoryWrite, true},
		{"handoff.started", EventTypeHandoffStarted, true},
		{"handoff.completed", EventTypeHandoffCompleted, true},
		{"policy.blocked", EventTypePolicyBlocked, true},
		{"error.raised", EventTypeErrorRaised, true},
		{"invalid.type", EventType("invalid.type"), false},
		{"", EventType(""), false},
	}

	for _, tt := range tests {
		t.Run(string(tt.eventType), func(t *testing.T) {
			result := IsValidEventType(tt.eventType)
			if result != tt.valid {
				t.Errorf("IsValidEventType(%s) = %v, want %v", tt.eventType, result, tt.valid)
			}
		})
	}
}

func TestAgentRoleValidation(t *testing.T) {
	tests := []struct {
		name  string
		role  AgentRole
		valid bool
	}{
		{"orchestrator", AgentRoleOrchestrator, true},
		{"subagent", AgentRoleSubagent, true},
		{"standalone", AgentRoleStandalone, true},
		{"invalid", AgentRole("invalid"), false},
		{"", AgentRole(""), false},
	}

	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			result := IsValidAgentRole(tt.role)
			if result != tt.valid {
				t.Errorf("IsValidAgentRole(%s) = %v, want %v", tt.role, result, tt.valid)
			}
		})
	}
}

func TestCoreEventTypes(t *testing.T) {
	if len(CoreEventTypes) != 12 {
		t.Errorf("Expected 12 core event types, got %d", len(CoreEventTypes))
	}

	// Verify all expected types are present
	expected := []EventType{
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

	for _, exp := range expected {
		found := false
		for _, actual := range CoreEventTypes {
			if actual == exp {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Core event type %s not found in CoreEventTypes", exp)
		}
	}
}
