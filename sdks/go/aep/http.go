package aep

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// HTTPResponse represents the raw response from an AEP server HTTP request,
// including status code, body, and headers.
type HTTPResponse struct {
	StatusCode int
	Body       []byte
	Headers    http.Header
}

// EmitResponse represents the response from POST /events.
type EmitResponse struct {
	Accepted  bool   `json:"accepted"`
	Duplicate bool   `json:"duplicate"`
	ID        string `json:"id"`
}

// SessionResponse represents session data from the API.
type SessionResponse struct {
	ID              string `json:"id"`
	TraceID         string `json:"trace_id"`
	ParentSessionID *string `json:"parent_session_id,omitempty"`
	EventCount      int    `json:"event_count"`
	FirstTime       string `json:"first_time"`
	LastTime        string `json:"last_time"`
}

// HandleResponse processes an HTTP response and returns an error if appropriate.
func HandleResponse(resp *http.Response) (*HTTPResponse, error) {
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, NewConnectionError("failed to read response body", err)
	}

	httpResp := &HTTPResponse{
		StatusCode: resp.StatusCode,
		Body:       body,
		Headers:    resp.Header,
	}

	// Handle success and error responses
	switch resp.StatusCode {
	case http.StatusAccepted:
		// 202 Accepted is expected for POST /events
		return httpResp, nil
	case http.StatusUnauthorized:
		return httpResp, NewAuthError("unauthorized", nil)
	case http.StatusNotFound:
		return httpResp, NewNotFoundError("resource not found", nil)
	case http.StatusTooManyRequests:
		retryAfter := ParseRetryAfter(resp.Header.Get("Retry-After"))
		return httpResp, NewRateLimitError("rate limit exceeded", retryAfter, nil)
	case http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable:
		return httpResp, NewServerError("server error", resp.StatusCode, nil)
	}

	// 400-level errors (except those handled above)
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		var errMsg string
		var errData map[string]any
		if err := json.Unmarshal(body, &errData); err == nil {
			if msg, ok := errData["message"].(string); ok {
				errMsg = msg
			}
		}
		if errMsg == "" {
			errMsg = string(body)
		}
		return httpResp, NewValidationError(errMsg, nil)
	}

	// 500-level errors
	if resp.StatusCode >= 500 {
		return httpResp, NewServerError("server error", resp.StatusCode, nil)
	}

	return httpResp, nil
}

// ParseRetryAfter parses the Retry-After header and returns seconds.
// Supports both integer (seconds) and HTTP-date formats.
func ParseRetryAfter(retryAfter string) int {
	if retryAfter == "" {
		return 60 // Default to 60 seconds
	}

	trimmed := strings.TrimSpace(retryAfter)

	// Try to parse as integer (seconds)
	if secs, err := strconv.Atoi(trimmed); err == nil {
		return secs
	}

	// Try to parse as HTTP-date (RFC 1123)
	if t, err := http.ParseTime(trimmed); err == nil {
		duration := time.Until(t)
		if duration < 0 {
			return 0 // Date is in the past
		}
		return int(duration.Seconds())
	}

	// Default to 60 seconds if parsing fails
	return 60
}

// UnmarshalEmitResponse unmarshals an emit response.
func UnmarshalEmitResponse(data []byte) (*EmitResponse, error) {
	var resp EmitResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, NewValidationError("failed to parse emit response", err)
	}
	return &resp, nil
}

// UnmarshalSessionResponse unmarshals a session response.
func UnmarshalSessionResponse(data []byte) (*SessionResponse, error) {
	var resp SessionResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, NewValidationError("failed to parse session response", err)
	}
	return &resp, nil
}
