package aep

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// DefaultServerURL is the default AEP server URL.
const DefaultServerURL = "http://localhost:8787"

// Client is the synchronous AEP HTTP client.
type Client struct {
	serverURL  string
	apiKey     string
	httpClient *http.Client
	timeout    time.Duration
}

// NewClient creates a new AEP client with default settings.
func NewClient() *Client {
	return &Client{
		serverURL: DefaultServerURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		timeout: 30 * time.Second,
	}
}

// NewClientWithURL creates a new AEP client with a custom server URL.
func NewClientWithURL(serverURL string) *Client {
	return &Client{
		serverURL: serverURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		timeout: 30 * time.Second,
	}
}

// SetAPIKey sets the API key for authentication.
func (c *Client) SetAPIKey(apiKey string) {
	c.apiKey = apiKey
}

// SetTimeout sets the HTTP client timeout.
func (c *Client) SetTimeout(timeout time.Duration) {
	c.timeout = timeout
	c.httpClient.Timeout = timeout
}

// Close closes the HTTP client connection pool. For sync client, this is a no-op
// but is provided for API compatibility.
func (c *Client) Close() error {
	c.httpClient.CloseIdleConnections()
	return nil
}

// String returns a string representation of the client (with API key masked for security).
func (c *Client) String() string {
	apiKeyDisplay := "none"
	if c.apiKey != "" {
		// Mask the API key, showing only last 4 chars for minimal information disclosure
		if len(c.apiKey) > 4 {
			apiKeyDisplay = "*..." + c.apiKey[len(c.apiKey)-4:]
		} else {
			apiKeyDisplay = "***"
		}
	}
	return fmt.Sprintf("Client{serverURL=%s, apiKey=%s}", c.serverURL, apiKeyDisplay)
}

// Emit sends a single event to the AEP server.
func (c *Client) Emit(ctx context.Context, event *Event) (*EmitResponse, error) {
	if event == nil {
		return nil, NewValidationError("event cannot be nil", nil)
	}

	// Validate before sending
	result, err := ValidateEvent(event)
	if err != nil {
		return nil, err
	}
	if !result.Valid {
		return nil, NewValidationError(fmt.Sprintf("event validation failed: %s", strings.Join(result.Errors, "; ")), nil)
	}

	return c.emit(ctx, event)
}

// EmitBatch sends multiple events to the AEP server and returns all results.
// Uses synchronous calls; for concurrent emission, use the async client.
func (c *Client) EmitBatch(ctx context.Context, events []*Event) ([]*EmitResponse, error) {
	if len(events) == 0 {
		return []*EmitResponse{}, nil
	}

	results := make([]*EmitResponse, len(events))
	for i, event := range events {
		resp, err := c.Emit(ctx, event)
		if err != nil {
			return nil, err
		}
		results[i] = resp
	}
	return results, nil
}

// emit is the internal method that performs the actual HTTP request.
func (c *Client) emit(ctx context.Context, event *Event) (*EmitResponse, error) {
	eventJSON, err := json.Marshal(event)
	if err != nil {
		return nil, NewValidationError("failed to marshal event", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", c.serverURL+"/events", bytes.NewBuffer(eventJSON))
	if err != nil {
		return nil, NewConnectionError("failed to create request", err)
	}

	// Set headers
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	// Send request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, NewConnectionError("failed to send request", err)
	}

	// Handle response
	httpResp, err := HandleResponse(resp)
	if err != nil {
		return nil, err
	}

	// Parse emit response
	return UnmarshalEmitResponse(httpResp.Body)
}

// GetSession retrieves a session by ID.
func (c *Client) GetSession(ctx context.Context, sessionID string) (*SessionResponse, error) {
	if sessionID == "" {
		return nil, NewValidationError("sessionID cannot be empty", nil)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", c.serverURL+"/sessions/"+sessionID, nil)
	if err != nil {
		return nil, NewConnectionError("failed to create request", err)
	}

	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, NewConnectionError("failed to send request", err)
	}

	httpResp, err := HandleResponse(resp)
	if err != nil {
		return nil, err
	}

	return UnmarshalSessionResponse(httpResp.Body)
}

// GetHealth checks the server health.
func (c *Client) GetHealth(ctx context.Context) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.serverURL+"/health", nil)
	if err != nil {
		return false, NewConnectionError("failed to create request", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, NewConnectionError("failed to send request", err)
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK, nil
}

// GetReady checks if the server is ready.
func (c *Client) GetReady(ctx context.Context) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.serverURL+"/ready", nil)
	if err != nil {
		return false, NewConnectionError("failed to create request", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, NewConnectionError("failed to send request", err)
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK, nil
}

// GetMetrics retrieves server metrics.
func (c *Client) GetMetrics(ctx context.Context) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.serverURL+"/metrics", nil)
	if err != nil {
		return nil, NewConnectionError("failed to create request", err)
	}

	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, NewConnectionError("failed to send request", err)
	}

	httpResp, err := HandleResponse(resp)
	if err != nil {
		return nil, err
	}

	var metrics map[string]any
	if err := json.Unmarshal(httpResp.Body, &metrics); err != nil {
		return nil, NewValidationError("failed to parse metrics response", err)
	}
	return metrics, nil
}
