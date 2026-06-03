package aep

import (
	"testing"
)

func TestValidateEventValid(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "test"},
		nil,
	)

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if !result.Valid {
		t.Errorf("Expected valid event, got errors: %v", result.Errors)
	}

	if len(result.Warnings) > 0 {
		t.Errorf("Expected no warnings, got: %v", result.Warnings)
	}
}

func TestValidateEventAllCoreTypes(t *testing.T) {
	coreTypes := []EventType{
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

	for _, eventType := range coreTypes {
		t.Run(string(eventType), func(t *testing.T) {
			event, _ := CreateEvent(
				"agent://test",
				eventType,
				"ses_001",
				"trc_001",
				map[string]interface{}{},
				nil,
			)

			result, err := ValidateEvent(event)

			if err != nil {
				t.Fatalf("ValidateEvent failed: %v", err)
			}

			if !result.Valid {
				t.Errorf("Expected valid event for type %s, got errors: %v", eventType, result.Errors)
			}
		})
	}
}

func TestValidateEventMissingRequired(t *testing.T) {
	tests := []struct {
		name  string
		event *Event
	}{
		{
			"missing specversion",
			&Event{
				ID:        "evt_001",
				Time:      "2025-01-01T00:00:00Z",
				Source:    "agent://test",
				Type:      EventTypeTaskCreated,
				SessionID: "ses_001",
				TraceID:   "trc_001",
				Payload:   map[string]interface{}{},
			},
		},
		{
			"missing id",
			&Event{
				SpecVersion: "0.2.0",
				Time:        "2025-01-01T00:00:00Z",
				Source:      "agent://test",
				Type:        EventTypeTaskCreated,
				SessionID:   "ses_001",
				TraceID:     "trc_001",
				Payload:     map[string]interface{}{},
			},
		},
		{
			"missing session_id",
			&Event{
				SpecVersion: "0.2.0",
				ID:          "evt_001",
				Time:        "2025-01-01T00:00:00Z",
				Source:      "agent://test",
				Type:        EventTypeTaskCreated,
				TraceID:     "trc_001",
				Payload:     map[string]interface{}{},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ValidateEvent(tt.event)

			if err == nil && result.Valid {
				t.Errorf("Expected validation to fail for missing field, but it passed")
			}
		})
	}
}

func TestValidateEventWithOptionalFields(t *testing.T) {
	role := AgentRoleSubagent
	parentSessionID := "ses_parent"
	subject := "test subject"
	causationID := "evt_parent"
	tenant := "tenant_001"

	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		&CreateEventOptions{
			ParentSessionID: &parentSessionID,
			AgentRole:       &role,
			Subject:         &subject,
			CausationID:     &causationID,
			Tenant:          &tenant,
		},
	)

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if !result.Valid {
		t.Errorf("Expected valid event with optional fields, got errors: %v", result.Errors)
	}
}

func TestValidateEventWithPayloadSchema(t *testing.T) {
	schemaURI := "https://example.com/schema.json"
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"task": "test"},
		&CreateEventOptions{
			Schema: &schemaURI,
		},
	)

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	// Payload schema validation is not yet implemented, so warnings may appear
	if !result.Valid {
		t.Errorf("Expected valid event, got errors: %v", result.Errors)
	}
}

func TestValidateEventWithSignature(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		nil,
	)

	// Sign the event
	secret := "test_secret"
	signedEvent, _ := SignEvent(event, secret)

	result, err := ValidateEvent(signedEvent)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if !result.Valid {
		t.Errorf("Expected valid signed event, got errors: %v", result.Errors)
	}
}

func TestValidateEventWithLabels(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		&CreateEventOptions{
			Labels: map[string]string{
				"environment": "production",
				"version":     "1.0.0",
			},
		},
	)

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if !result.Valid {
		t.Errorf("Expected valid event with labels, got errors: %v", result.Errors)
	}
}

func TestValidateEventWithExtensions(t *testing.T) {
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		&CreateEventOptions{
			Extensions: map[string]interface{}{
				"custom_field": "custom_value",
				"priority":     1,
			},
		},
	)

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if !result.Valid {
		t.Errorf("Expected valid event with extensions, got errors: %v", result.Errors)
	}
}

func TestValidateEventNilPayload(t *testing.T) {
	event := &Event{
		SpecVersion: "0.2.0",
		ID:          "evt_001",
		Time:        "2025-01-01T00:00:00Z",
		Source:      "agent://test",
		Type:        EventTypeTaskCreated,
		SessionID:   "ses_001",
		TraceID:     "trc_001",
		Payload:     nil,
	}

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	// Nil payload should be valid (payload is required but can be null)
	if !result.Valid {
		t.Errorf("Expected valid event with nil payload, got errors: %v", result.Errors)
	}
}

func TestValidateEventInvalidType(t *testing.T) {
	event := &Event{
		SpecVersion: "0.2.0",
		ID:          "evt_001",
		Time:        "2025-01-01T00:00:00Z",
		Source:      "agent://test",
		Type:        EventType("invalid.type"),
		SessionID:   "ses_001",
		TraceID:     "trc_001",
		Payload:     map[string]interface{}{},
	}

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if result.Valid {
		t.Error("Expected invalid event type to fail validation")
	}

	if len(result.Errors) == 0 {
		t.Error("Expected validation errors for invalid type")
	}
}

func TestValidateEventInvalidTime(t *testing.T) {
	event := &Event{
		SpecVersion: "0.2.0",
		ID:          "evt_001",
		Time:        "not-a-valid-time",
		Source:      "agent://test",
		Type:        EventTypeTaskCreated,
		SessionID:   "ses_001",
		TraceID:     "trc_001",
		Payload:     map[string]interface{}{},
	}

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if result.Valid {
		t.Error("Expected invalid time format to fail validation")
	}
}

func TestValidateEventComplexPayload(t *testing.T) {
	payload := map[string]interface{}{
		"task": "analyze data",
		"steps": []map[string]interface{}{
			{"name": "extract", "duration": 1.5},
			{"name": "transform", "duration": 2.3},
			{"name": "load", "duration": 0.8},
		},
		"metrics": map[string]interface{}{
			"success_rate": 0.99,
			"latency_ms":   125,
		},
	}

	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		payload,
		nil,
	)

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if !result.Valid {
		t.Errorf("Expected valid event with complex payload, got errors: %v", result.Errors)
	}
}

func TestSchemasLoaded(t *testing.T) {
	// Calling ValidateEvent should trigger schema loading
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{},
		nil,
	)

	_, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	// Second call should use cached schemas (no error)
	_, err = ValidateEvent(event)

	if err != nil {
		t.Fatalf("Second ValidateEvent call failed: %v", err)
	}
}

func TestPayloadSchemaValidationWithoutSchema(t *testing.T) {
	// Event without schema field should validate successfully
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"data": "test"},
		nil,
	)

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if !result.Valid {
		t.Errorf("Expected valid event without schema, got errors: %v", result.Errors)
	}
}

func TestPayloadSchemaValidationWithEmptySchema(t *testing.T) {
	// Event with empty schema string should validate successfully
	emptySchema := ""
	event, _ := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_001",
		"trc_001",
		map[string]interface{}{"data": "test"},
		&CreateEventOptions{
			Schema: &emptySchema,
		},
	)

	result, err := ValidateEvent(event)

	if err != nil {
		t.Fatalf("ValidateEvent failed: %v", err)
	}

	if !result.Valid {
		t.Errorf("Expected valid event with empty schema, got errors: %v", result.Errors)
	}
}
