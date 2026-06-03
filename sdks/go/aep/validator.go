package aep

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

//go:embed schemas/*.schema.json
var schemaFS embed.FS

var (
	envelopeSchema *jsonschema.Schema
	coreEventsSchema *jsonschema.Schema
	schemaMutex    sync.Mutex
	schemasLoaded  bool
)

// initSchemas loads the embedded schemas once, thread-safe.
func initSchemas() error {
	schemaMutex.Lock()
	defer schemaMutex.Unlock()

	if schemasLoaded {
		return nil
	}

	// Load envelope schema
	envelopeData, err := schemaFS.ReadFile("schemas/aep-envelope.schema.json")
	if err != nil {
		return fmt.Errorf("failed to read envelope schema: %w", err)
	}

	envelopeSchema, err = jsonschema.UnmarshalJSON(bytes.NewReader(envelopeData))
	if err != nil {
		return fmt.Errorf("failed to parse envelope schema: %w", err)
	}

	// Load core events schema
	coreEventsData, err := schemaFS.ReadFile("schemas/aep-core-events.schema.json")
	if err != nil {
		return fmt.Errorf("failed to read core events schema: %w", err)
	}

	coreEventsSchema, err = jsonschema.UnmarshalJSON(bytes.NewReader(coreEventsData))
	if err != nil {
		return fmt.Errorf("failed to parse core events schema: %w", err)
	}

	schemasLoaded = true
	return nil
}

// ValidationResult holds the results of validation.
type ValidationResult struct {
	Valid    bool
	Errors   []string
	Warnings []string
}

// ValidateEvent validates an event against the AEP schema.
// Returns a ValidationResult with any validation errors or warnings.
func ValidateEvent(event *Event) (*ValidationResult, error) {
	if err := initSchemas(); err != nil {
		return nil, err
	}

	result := &ValidationResult{
		Valid:    true,
		Errors:   []string{},
		Warnings: []string{},
	}

	// Marshal event to JSON for schema validation
	eventJSON, err := json.Marshal(event)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal event: %w", err)
	}

	var eventData any
	if err := json.Unmarshal(eventJSON, &eventData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal event: %w", err)
	}

	// Validate against envelope schema
	if err := envelopeSchema.Validate(eventData); err != nil {
		result.Valid = false
		result.Errors = append(result.Errors, err.Error())
	}

	// Validate event type against core events schema
	typeValidator := jsonschema.NewValidator()
	typeData := map[string]any{"type": string(event.Type)}
	if err := coreEventsSchema.Validate(typeData); err != nil {
		result.Valid = false
		result.Errors = append(result.Errors, fmt.Sprintf("invalid event type: %v", event.Type))
	}

	// If event has a custom payload schema, validate payload against it
	if event.Schema != nil && *event.Schema != "" {
		if err := validatePayloadSchema(event); err != nil {
			// Payload schema validation errors are warnings, not fatal errors
			result.Warnings = append(result.Warnings, fmt.Sprintf("[warn] payload schema validation failed: %v", err))
		}
	}

	return result, nil
}

// validatePayloadSchema validates the event payload against a custom schema if provided.
func validatePayloadSchema(event *Event) error {
	if event.Schema == nil || *event.Schema == "" {
		return nil
	}

	// For now, we skip custom schema validation as it requires fetching schemas by URI.
	// This can be enhanced in the future with a schema registry.
	return nil
}
