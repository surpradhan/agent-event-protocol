// +build integration

package aep

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"
)

// TestIntegrationServerURL returns the server URL for integration tests.
// Can be overridden with SERVER_URL env var.
func TestIntegrationServerURL() string {
	if url := os.Getenv("SERVER_URL"); url != "" {
		return url
	}
	return DefaultServerURL
}

// skipIfServerUnavailable skips the test if the AEP server is not reachable.
func skipIfServerUnavailable(t *testing.T, serverURL string) {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(serverURL + "/health")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Skipf("AEP server at %s is not reachable, skipping integration test", serverURL)
	}
}

func TestIntegrationEmitEvent(t *testing.T) {
	serverURL := TestIntegrationServerURL()
	skipIfServerUnavailable(t, serverURL)

	client := NewClientWithURL(serverURL)
	event, err := CreateEvent(
		"agent://test",
		EventTypeTaskCreated,
		"ses_integration_001",
		"trc_integration_001",
		map[string]interface{}{"test": "integration"},
		nil,
	)

	if err != nil {
		t.Fatalf("Failed to create event: %v", err)
	}

	ctx := context.Background()
	resp, err := client.Emit(ctx, event)

	if err != nil {
		t.Fatalf("Failed to emit event: %v", err)
	}

	if !resp.Accepted {
		t.Error("Expected event to be accepted")
	}

	if resp.ID != event.ID {
		t.Errorf("Expected response ID to match event ID, got %s vs %s", resp.ID, event.ID)
	}
}

func TestIntegrationGetHealth(t *testing.T) {
	serverURL := TestIntegrationServerURL()
	skipIfServerUnavailable(t, serverURL)

	client := NewClientWithURL(serverURL)
	ctx := context.Background()
	healthy, err := client.GetHealth(ctx)

	if err != nil {
		t.Fatalf("Health check failed: %v", err)
	}

	if !healthy {
		t.Error("Expected server to be healthy")
	}
}

func TestIntegrationGetReady(t *testing.T) {
	serverURL := TestIntegrationServerURL()
	skipIfServerUnavailable(t, serverURL)

	client := NewClientWithURL(serverURL)
	ctx := context.Background()
	ready, err := client.GetReady(ctx)

	if err != nil {
		t.Fatalf("Ready check failed: %v", err)
	}

	if !ready {
		t.Error("Expected server to be ready")
	}
}

func TestIntegrationGetMetrics(t *testing.T) {
	serverURL := TestIntegrationServerURL()
	skipIfServerUnavailable(t, serverURL)

	client := NewClientWithURL(serverURL)
	ctx := context.Background()
	metrics, err := client.GetMetrics(ctx)

	if err != nil {
		t.Fatalf("Failed to get metrics: %v", err)
	}

	if metrics == nil {
		t.Error("Expected metrics to be non-nil")
	}
}

func TestIntegrationEmitBatch(t *testing.T) {
	serverURL := TestIntegrationServerURL()
	skipIfServerUnavailable(t, serverURL)

	client := NewClientWithURL(serverURL)
	events := make([]*Event, 3)
	for i := 0; i < 3; i++ {
		event, _ := CreateEvent(
			"agent://test-batch",
			EventTypeTaskCreated,
			"ses_batch_001",
			"trc_batch_001",
			map[string]interface{}{"index": i},
			nil,
		)
		events[i] = event
	}

	ctx := context.Background()
	responses, err := client.EmitBatch(ctx, events)

	if err != nil {
		t.Fatalf("Failed to emit batch: %v", err)
	}

	if len(responses) != 3 {
		t.Errorf("Expected 3 responses, got %d", len(responses))
	}

	for i, resp := range responses {
		if !resp.Accepted {
			t.Errorf("Expected event %d to be accepted", i)
		}
	}
}

func TestIntegrationAsyncEmitBatch(t *testing.T) {
	serverURL := TestIntegrationServerURL()
	skipIfServerUnavailable(t, serverURL)

	asyncClient := NewAsyncClientWithURL(serverURL)
	events := make([]*Event, 3)
	for i := 0; i < 3; i++ {
		event, _ := CreateEvent(
			"agent://test-async",
			EventTypeTaskCreated,
			"ses_async_001",
			"trc_async_001",
			map[string]interface{}{"index": i},
			nil,
		)
		events[i] = event
	}

	ctx := context.Background()
	responses, err := asyncClient.EmitBatch(ctx, events)

	if err != nil {
		t.Fatalf("Failed to emit async batch: %v", err)
	}

	if len(responses) != 3 {
		t.Errorf("Expected 3 responses, got %d", len(responses))
	}

	for i, resp := range responses {
		if !resp.Accepted {
			t.Errorf("Expected event %d to be accepted", i)
		}
	}
}

func TestIntegrationEmitWithSignature(t *testing.T) {
	serverURL := TestIntegrationServerURL()
	skipIfServerUnavailable(t, serverURL)

	client := NewClientWithURL(serverURL)
	event, _ := CreateEvent(
		"agent://test-signed",
		EventTypeTaskCreated,
		"ses_signed_001",
		"trc_signed_001",
		map[string]interface{}{"signed": true},
		nil,
	)

	// Sign the event
	secret := "test_integration_secret"
	signedEvent, err := SignEvent(event, secret)
	if err != nil {
		t.Fatalf("Failed to sign event: %v", err)
	}

	ctx := context.Background()
	resp, err := client.Emit(ctx, signedEvent)

	if err != nil {
		t.Fatalf("Failed to emit signed event: %v", err)
	}

	if !resp.Accepted {
		t.Error("Expected signed event to be accepted")
	}
}

func TestIntegrationMultiAgentWorkflow(t *testing.T) {
	serverURL := TestIntegrationServerURL()
	skipIfServerUnavailable(t, serverURL)

	client := NewClientWithURL(serverURL)
	ctx := context.Background()

	// Create orchestrator event
	orchestratorEvent, _ := CreateEvent(
		"agent://orchestrator",
		EventTypeTaskCreated,
		"ses_workflow_001",
		"trc_workflow_001",
		map[string]interface{}{"workflow": "integration_test"},
		nil,
	)

	resp, err := client.Emit(ctx, orchestratorEvent)
	if err != nil {
		t.Fatalf("Failed to emit orchestrator event: %v", err)
	}

	if !resp.Accepted {
		t.Error("Expected orchestrator event to be accepted")
	}

	// Create sub-agent event with parent reference
	subagentRole := AgentRoleSubagent
	parentSessionID := orchestratorEvent.SessionID
	subagentEvent, _ := CreateEvent(
		"agent://sub-agent",
		EventTypeTaskCreated,
		"ses_workflow_002",
		"trc_workflow_001",
		map[string]interface{}{"role": "analysis"},
		&CreateEventOptions{
			ParentSessionID: &parentSessionID,
			AgentRole:       &subagentRole,
		},
	)

	resp, err = client.Emit(ctx, subagentEvent)
	if err != nil {
		t.Fatalf("Failed to emit sub-agent event: %v", err)
	}

	if !resp.Accepted {
		t.Error("Expected sub-agent event to be accepted")
	}
}
