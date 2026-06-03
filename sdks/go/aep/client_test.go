package aep

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientEmit(t *testing.T) {
	// Create a test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/events" {
			t.Errorf("Expected /events, got %s", r.URL.Path)
		}

		if r.Method != "POST" {
			t.Errorf("Expected POST, got %s", r.Method)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"accepted":  true,
			"duplicate": false,
			"id":        "evt_123",
		})
	}))
	defer server.Close()

	client := NewClientWithURL(server.URL)
	event, _ := CreateEvent("agent://test", EventTypeTaskCreated, "ses_001", "trc_001", map[string]interface{}{}, nil)

	ctx := context.Background()
	resp, err := client.Emit(ctx, event)

	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}

	if !resp.Accepted {
		t.Error("Expected response.Accepted to be true")
	}

	if resp.Duplicate {
		t.Error("Expected response.Duplicate to be false")
	}

	if resp.ID != "evt_123" {
		t.Errorf("Expected ID 'evt_123', got %s", resp.ID)
	}
}

func TestClientEmitBatch(t *testing.T) {
	count := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"accepted":  true,
			"duplicate": false,
			"id":        "evt_" + string(rune(count)),
		})
	}))
	defer server.Close()

	client := NewClientWithURL(server.URL)
	events := make([]*Event, 3)
	for i := 0; i < 3; i++ {
		events[i], _ = CreateEvent("agent://test", EventTypeTaskCreated, "ses_001", "trc_001", map[string]interface{}{}, nil)
	}

	ctx := context.Background()
	responses, err := client.EmitBatch(ctx, events)

	if err != nil {
		t.Fatalf("EmitBatch failed: %v", err)
	}

	if len(responses) != 3 {
		t.Errorf("Expected 3 responses, got %d", len(responses))
	}

	if count != 3 {
		t.Errorf("Expected 3 requests, got %d", count)
	}
}

func TestClientEmitValidationError(t *testing.T) {
	client := NewClient()

	ctx := context.Background()
	_, err := client.Emit(ctx, nil)

	if err == nil {
		t.Error("Expected error for nil event")
	}

	if _, ok := err.(*ErrValidation); !ok {
		t.Errorf("Expected ErrValidation, got %T", err)
	}
}

func TestClientEmitInvalidEventType(t *testing.T) {
	client := NewClient()
	event := &Event{
		Type:      EventType("invalid.type"),
		Source:    "agent://test",
		SessionID: "ses_001",
		TraceID:   "trc_001",
		Payload:   map[string]interface{}{},
	}

	ctx := context.Background()
	_, err := client.Emit(ctx, event)

	if err == nil {
		t.Error("Expected error for invalid event type")
	}
}

func TestClientGetHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Errorf("Expected /health, got %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClientWithURL(server.URL)
	ctx := context.Background()
	healthy, err := client.GetHealth(ctx)

	if err != nil {
		t.Fatalf("GetHealth failed: %v", err)
	}

	if !healthy {
		t.Error("Expected health check to pass")
	}
}

func TestClientGetReady(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ready" {
			t.Errorf("Expected /ready, got %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClientWithURL(server.URL)
	ctx := context.Background()
	ready, err := client.GetReady(ctx)

	if err != nil {
		t.Fatalf("GetReady failed: %v", err)
	}

	if !ready {
		t.Error("Expected ready check to pass")
	}
}

func TestClientGetMetrics(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/metrics" {
			t.Errorf("Expected /metrics, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"events_received": 100,
			"sessions_total":  10,
		})
	}))
	defer server.Close()

	client := NewClientWithURL(server.URL)
	ctx := context.Background()
	metrics, err := client.GetMetrics(ctx)

	if err != nil {
		t.Fatalf("GetMetrics failed: %v", err)
	}

	if metrics["events_received"].(float64) != 100 {
		t.Errorf("Expected events_received 100, got %v", metrics["events_received"])
	}
}

func TestClientString(t *testing.T) {
	client := NewClient()
	str := client.String()

	if str == "" {
		t.Error("Expected non-empty string representation")
	}

	// Should not contain the full API key
	client.SetAPIKey("aep_1234567890abcdefgh")
	str = client.String()
	if len(str) > 0 && str[len(str)-1:] != "}" {
		t.Errorf("Expected string to end with }, got %s", str)
	}
}

func TestClientTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClientWithURL(server.URL)
	client.SetTimeout(50 * time.Millisecond)

	ctx := context.Background()
	_, err := client.GetHealth(ctx)

	if err == nil {
		t.Error("Expected timeout error")
	}
}

func TestAsyncClientEmitBatch(t *testing.T) {
	count := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"accepted":  true,
			"duplicate": false,
			"id":        "evt_123",
		})
	}))
	defer server.Close()

	asyncClient := NewAsyncClientWithURL(server.URL)
	events := make([]*Event, 3)
	for i := 0; i < 3; i++ {
		events[i], _ = CreateEvent("agent://test", EventTypeTaskCreated, "ses_001", "trc_001", map[string]interface{}{}, nil)
	}

	ctx := context.Background()
	responses, err := asyncClient.EmitBatch(ctx, events)

	if err != nil {
		t.Fatalf("EmitBatch failed: %v", err)
	}

	if len(responses) != 3 {
		t.Errorf("Expected 3 responses, got %d", len(responses))
	}

	if count != 3 {
		t.Errorf("Expected 3 requests, got %d", count)
	}
}
