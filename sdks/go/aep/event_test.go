package aep

import (
	"testing"
	"time"
)

func TestCreateEvent(t *testing.T) {
	event, err := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "test"},
		nil,
	)

	if err != nil {
		t.Fatalf("CreateEvent failed: %v", err)
	}

	if event.SpecVersion != "0.2.0" {
		t.Errorf("Expected spec version 0.2.0, got %s", event.SpecVersion)
	}

	if event.ID == "" {
		t.Error("Event ID should be auto-generated")
	}

	if event.Time == "" {
		t.Error("Event time should be auto-generated")
	}

	// Verify time is valid RFC3339
	if _, err := time.Parse(time.RFC3339, event.Time); err != nil {
		t.Errorf("Event time is not valid RFC3339: %v", err)
	}

	if event.Source != "agent://test" {
		t.Errorf("Expected source 'agent://test', got %s", event.Source)
	}

	if event.Type != EventTypeTaskCreated {
		t.Errorf("Expected type task.created, got %s", event.Type)
	}

	if event.SessionID != "ses_001" {
		t.Errorf("Expected session ID 'ses_001', got %s", event.SessionID)
	}

	if event.TraceID != "trc_001" {
		t.Errorf("Expected trace ID 'trc_001', got %s", event.TraceID)
	}
}

func TestCreateEventWithOptions(t *testing.T) {
	role := AgentRoleSubagent
	parentSessionID := "ses_parent"
	subject := "test subject"
	causationID := "evt_parent"

	opts := &CreateEventOptions{
		ParentSessionID: &parentSessionID,
		AgentRole:       &role,
		Subject:         &subject,
		CausationID:     &causationID,
	}

	event, err := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		opts,
	)

	if err != nil {
		t.Fatalf("CreateEvent failed: %v", err)
	}

	if event.ParentSessionID == nil || *event.ParentSessionID != "ses_parent" {
		t.Errorf("Expected parent session ID 'ses_parent', got %v", event.ParentSessionID)
	}

	if event.AgentRole == nil || *event.AgentRole != AgentRoleSubagent {
		t.Errorf("Expected agent role 'subagent', got %v", event.AgentRole)
	}

	if event.Subject == nil || *event.Subject != "test subject" {
		t.Errorf("Expected subject 'test subject', got %v", event.Subject)
	}

	if event.CausationID == nil || *event.CausationID != "evt_parent" {
		t.Errorf("Expected causation ID 'evt_parent', got %v", event.CausationID)
	}
}

func TestCreateEventInvalidType(t *testing.T) {
	_, err := CreateEvent(
		"agent://test",
		EventType("invalid.type"),
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		nil,
	)

	if err == nil {
		t.Error("Expected error for invalid event type")
	}

	if _, ok := err.(*ErrValidation); !ok {
		t.Errorf("Expected ErrValidation, got %T", err)
	}
}

func TestCreateEventInvalidRole(t *testing.T) {
	invalidRole := AgentRole("invalid")
	opts := &CreateEventOptions{
		AgentRole: &invalidRole,
	}

	_, err := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		opts,
	)

	if err == nil {
		t.Error("Expected error for invalid agent role")
	}

	if _, ok := err.(*ErrValidation); !ok {
		t.Errorf("Expected ErrValidation, got %T", err)
	}
}

func TestEventIDUniqueness(t *testing.T) {
	event1, _ := CreateEvent("agent://test", EventTypeTaskCreated, "ses_001", "trc_001", map[string]interface{}{}, nil)
	event2, _ := CreateEvent("agent://test", EventTypeTaskCreated, "ses_001", "trc_001", map[string]interface{}{}, nil)

	if event1.ID == event2.ID {
		t.Error("Event IDs should be unique")
	}
}
