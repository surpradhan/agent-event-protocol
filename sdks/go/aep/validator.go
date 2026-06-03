package aep

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

//go:embed schemas/*.schema.json
var schemaFS embed.FS

// SchemaCacheEntry holds a cached schema with its expiration time
type schemaCacheEntry struct {
	schema    *jsonschema.Schema
	expiresAt time.Time
}

var (
	envelopeSchema   *jsonschema.Schema
	coreEventsSchema *jsonschema.Schema
	schemaMutex      sync.Mutex
	schemasLoaded    bool
	// Cache for fetched payload schemas to avoid repeated HTTP requests
	// Schemas are cached with a 1-hour TTL to prevent unbounded growth
	payloadSchemaCache = make(map[string]*schemaCacheEntry)
	payloadSchemaMu    sync.RWMutex
	// Schema cache TTL (1 hour)
	schemaCacheTTL = 1 * time.Hour
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
// Fetches the schema from the URI and caches it for future use (1-hour TTL).
func validatePayloadSchema(event *Event) error {
	if event.Schema == nil || *event.Schema == "" {
		return nil
	}

	schemaURI := *event.Schema

	// Check cache first
	payloadSchemaMu.RLock()
	if entry, exists := payloadSchemaCache[schemaURI]; exists {
		// Check if cache entry has expired
		if time.Now().Before(entry.expiresAt) {
			schema := entry.schema
			payloadSchemaMu.RUnlock()
			return validateAgainstSchema(event.Payload, schema)
		}
		// Cache entry expired, will refetch below
	}
	payloadSchemaMu.RUnlock()

	// Fetch schema from URI
	schema, err := fetchSchema(schemaURI)
	if err != nil {
		return fmt.Errorf("failed to fetch schema from %s: %w", schemaURI, err)
	}

	// Cache the schema with TTL
	payloadSchemaMu.Lock()
	payloadSchemaCache[schemaURI] = &schemaCacheEntry{
		schema:    schema,
		expiresAt: time.Now().Add(schemaCacheTTL),
	}
	payloadSchemaMu.Unlock()

	return validateAgainstSchema(event.Payload, schema)
}

// fetchSchema fetches a JSON schema from a URI with timeout.
func fetchSchema(schemaURI string) (*jsonschema.Schema, error) {
	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Get(schemaURI)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch schema: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("schema URI returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read schema body: %w", err)
	}

	schema, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to parse schema: %w", err)
	}

	return schema, nil
}

// validateAgainstSchema validates payload data against a schema.
func validateAgainstSchema(payload any, schema *jsonschema.Schema) error {
	if payload == nil {
		return nil
	}

	// Convert payload to map if needed
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	var payloadData any
	if err := json.Unmarshal(payloadJSON, &payloadData); err != nil {
		return fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	return schema.Validate(payloadData)
}
