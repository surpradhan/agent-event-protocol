package aep

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
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
	// count is read from the test goroutine after the client returns, while it is
	// written from httptest's per-request handler goroutines. Use an atomic so the
	// counter is race-free regardless of how requests are dispatched.
	var count atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := count.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"accepted":  true,
			"duplicate": false,
			"id":        "evt_" + string(rune(n)),
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

	if got := count.Load(); got != 3 {
		t.Errorf("Expected 3 requests, got %d", got)
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
	// EmitBatch fans out one goroutine per event, so httptest invokes this handler
	// from multiple goroutines concurrently. Use an atomic counter: a plain int++
	// is a data race here (concurrent writes, plus an unsynchronized read after
	// wg.Wait) and made the request-count assertion intermittently flaky.
	var count atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
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

	if got := count.Load(); got != 3 {
		t.Errorf("Expected 3 requests, got %d", got)
	}
}
