package aep

import (
	"time"

	"github.com/google/uuid"
)

// Event represents a complete AEP event envelope with all required and optional fields.
// It includes metadata for tracking agent execution, causation chains, and multi-agent workflows.
type Event struct {
	SpecVersion     string            `json:"specversion"`                 // AEP spec version (e.g., "0.2.0")
	ID              string            `json:"id"`                          // Unique event identifier (UUID)
	Time            string            `json:"time"`                        // RFC3339 timestamp of event
	Source          string            `json:"source"`                      // Agent identifier (e.g., "agent://my-agent")
	Type            EventType         `json:"type"`                        // Core event type
	SessionID       string            `json:"session_id"`                  // Session ID grouping related events
	ParentSessionID *string           `json:"parent_session_id,omitempty"` // Parent session for sub-agents
	AgentRole       *AgentRole        `json:"agent_role,omitempty"`        // Agent role in workflow
	TraceID         string            `json:"trace_id"`                    // Trace ID linking all events in workflow
	CausationID     *string           `json:"causation_id,omitempty"`      // Parent event ID for causation chain
	Subject         *string           `json:"subject,omitempty"`           // Short human-readable subject
	IdempotencyKey  *string           `json:"idempotency_key,omitempty"`   // Key for deduplication
	Schema          *string           `json:"schema,omitempty"`            // URI to custom payload schema
	Signature       *Signature        `json:"signature,omitempty"`         // HMAC-SHA256 signature
	Tenant          *string           `json:"tenant,omitempty"`            // Tenant identifier
	Labels          map[string]string `json:"labels,omitempty"`            // Key-value metadata labels
	Extensions      map[string]any    `json:"extensions,omitempty"`        // Custom extension fields
	Payload         any               `json:"payload"`                     // Event-specific payload data
}

// Signature represents the HMAC signature of an event for authentication and integrity verification.
// Uses HMAC-SHA256 with canonical JSON form for consistent verification across languages.
type Signature struct {
	Alg   string `json:"alg"`             // Algorithm used (e.g., "hmac-sha256")
	Value string `json:"value"`           // Base64-encoded signature value
	Canon string `json:"canon,omitempty"` // Canonicalization version marker ("v1" | "v2"); v2 only (issue #59)
}

// CreateEventOptions holds options for creating an event.
type CreateEventOptions struct {
	ParentSessionID *string
	AgentRole       *AgentRole
	CausationID     *string
	Subject         *string
	IdempotencyKey  *string
	Schema          *string
	Tenant          *string
	Labels          map[string]string
	Extensions      map[string]any
}

// CreateEvent creates a new AEP event with auto-generated ID and timestamp.
// Returns an error if the event type is invalid.
func CreateEvent(source string, eventType EventType, sessionID, traceID string, payload any, opts *CreateEventOptions) (*Event, error) {
	if !IsValidEventType(eventType) {
		return nil, NewValidationError("invalid event type", nil)
	}

	if opts != nil && opts.AgentRole != nil && !IsValidAgentRole(*opts.AgentRole) {
		return nil, NewValidationError("invalid agent role", nil)
	}

	event := &Event{
		SpecVersion: "0.2.0",
		ID:          uuid.New().String(),
		Time:        time.Now().UTC().Format(time.RFC3339),
		Source:      source,
		Type:        eventType,
		SessionID:   sessionID,
		TraceID:     traceID,
		Payload:     payload,
	}

	if opts != nil {
		event.ParentSessionID = opts.ParentSessionID
		event.AgentRole = opts.AgentRole
		event.CausationID = opts.CausationID
		event.Subject = opts.Subject
		event.IdempotencyKey = opts.IdempotencyKey
		event.Schema = opts.Schema
		event.Tenant = opts.Tenant
		event.Labels = opts.Labels
		event.Extensions = opts.Extensions
	}

	return event, nil
}
