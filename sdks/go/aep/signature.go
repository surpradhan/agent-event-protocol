package aep

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// SignEvent signs an event with HMAC-SHA256 using the provided secret.
// Returns the event with the Signature field populated.
func SignEvent(event *Event, secret string) (*Event, error) {
	if event == nil {
		return nil, NewValidationError("event cannot be nil", nil)
	}

	if secret == "" {
		return nil, NewValidationError("secret cannot be empty", nil)
	}

	// Create canonical form of the event for signing
	canonical, err := canonicalForm(event)
	if err != nil {
		return nil, NewValidationError("failed to create canonical form", err)
	}

	// Sign with HMAC-SHA256
	sig := hmac.New(sha256.New, []byte(secret))
	sig.Write([]byte(canonical))
	sigHex := hex.EncodeToString(sig.Sum(nil))

	// Update event signature
	event.Signature = &Signature{
		Alg:   "hmac-sha256",
		Value: sigHex,
	}

	return event, nil
}

// VerifySignature verifies an event's HMAC-SHA256 signature using the provided secret.
// Returns true if the signature is valid, false otherwise.
// Returns an error if the event is nil, has no signature field, or if verification fails.
func VerifySignature(event *Event, secret string) (bool, error) {
	if event == nil {
		return false, NewValidationError("cannot verify signature: event is nil", nil)
	}

	if event.Signature == nil {
		return false, NewValidationError("cannot verify signature: event has no signature field (unsigned events cannot be verified)", nil)
	}

	if event.Signature.Alg != "hmac-sha256" {
		return false, NewValidationError("unsupported signature algorithm", nil)
	}

	if secret == "" {
		return false, NewValidationError("secret cannot be empty", nil)
	}

	// Create canonical form (preserves original signature in event)
	canonical, err := canonicalForm(event)
	if err != nil {
		return false, NewValidationError("failed to create canonical form", err)
	}

	// Compute expected signature
	sig := hmac.New(sha256.New, []byte(secret))
	sig.Write([]byte(canonical))
	expectedSig := hex.EncodeToString(sig.Sum(nil))

	// Use constant-time comparison to prevent timing attacks
	return hmac.Equal([]byte(event.Signature.Value), []byte(expectedSig)), nil
}

// canonicalForm creates a canonical JSON representation of an event for signing.
// Follows the same rules as the JS/Python implementations:
// - Excludes the signature field
// - Uses sorted keys
// - Minimal whitespace
func canonicalForm(event *Event) (string, error) {
	// Create a copy without the signature field for canonical form
	eventCopy := *event
	eventCopy.Signature = nil

	// Marshal to JSON
	data, err := json.Marshal(eventCopy)
	if err != nil {
		return "", err
	}

	// Parse to map for key sorting
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return "", err
	}

	// Convert back to canonical form with sorted keys
	canonical := canonicalJSON(m)
	return canonical, nil
}

// canonicalJSON recursively converts a value to its canonical JSON form with sorted keys.
func canonicalJSON(v any) string {
	switch val := v.(type) {
	case map[string]any:
		// Sort keys and build object
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		var parts []string
		for _, k := range keys {
			keyJSON, _ := json.Marshal(k)
			valJSON := canonicalJSON(val[k])
			parts = append(parts, string(keyJSON)+":"+valJSON)
		}
		return "{" + strings.Join(parts, ",") + "}"

	case []any:
		var parts []string
		for _, item := range val {
			parts = append(parts, canonicalJSON(item))
		}
		return "[" + strings.Join(parts, ",") + "]"

	case string:
		b, _ := json.Marshal(val)
		return string(b)

	case float64:
		// Handle integer vs float representation
		if val == float64(int64(val)) {
			return fmt.Sprintf("%.0f", val)
		}
		return strconv.FormatFloat(val, 'f', -1, 64)

	case bool:
		if val {
			return "true"
		}
		return "false"

	case nil:
		return "null"

	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}
