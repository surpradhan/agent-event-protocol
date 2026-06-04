//go:build integration

// Integration test: exporter -> live AEP server -> events queryable.
//
// Requires a running AEP server and a write-scoped API key:
//
//	AEP_SERVER_URL  (default http://localhost:8787)
//	AEP_API_KEY     (required; the test skips if unset)
//
// Run: go test -tags integration ./exporters/aepexporter/...
package aepexporter

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.uber.org/zap"
)

func serverURL() string {
	if u := os.Getenv("AEP_SERVER_URL"); u != "" {
		return u
	}
	return "http://localhost:8787"
}

func skipIfServerUnavailable(t *testing.T) {
	t.Helper()
	resp, err := http.Get(serverURL() + "/health")
	if err != nil {
		t.Skipf("AEP server not reachable at %s: %v", serverURL(), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Skipf("AEP server unhealthy at %s: status %d", serverURL(), resp.StatusCode)
	}
}

func TestIntegrationExportToLiveServer(t *testing.T) {
	skipIfServerUnavailable(t)

	apiKey := os.Getenv("AEP_API_KEY")
	if apiKey == "" {
		t.Skip("AEP_API_KEY not set (provision a write-scoped key via /admin/keys)")
	}

	// Unique trace id per run so the session's event count is deterministic.
	var tid [16]byte
	if _, err := rand.Read(tid[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	traceID := pcommon.TraceID(tid)
	sessionID := "ses_" + traceID.String()[:16]

	// Three spans in one trace: a task, a tool call, and a handoff.
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "integration-agent")
	ss := rs.ScopeSpans().AppendEmpty()
	for _, name := range []string{"process_task", "tool_call_search", "handoff_to_writer"} {
		sp := ss.Spans().AppendEmpty()
		sp.SetName(name)
		sp.SetTraceID(traceID)
		sp.SetKind(ptrace.SpanKindClient)
	}

	cfg := &Config{ServerURL: serverURL(), APIKey: apiKey, BatchSize: 10}
	exp := newAEPExporter(cfg, zap.NewNop())
	if err := exp.consumeTraces(context.Background(), td); err != nil {
		t.Fatalf("consumeTraces: %v", err)
	}

	// Verify via GET /sessions/{id}/events. (The server implements
	// /sessions/{id}/events but not a /sessions/{id} detail route.)
	got := fetchSessionEvents(t, sessionID, apiKey)
	if len(got) != 3 {
		t.Fatalf("got %d events for session %s, want 3", len(got), sessionID)
	}

	types := map[string]bool{}
	for _, e := range got {
		types[e.Type] = true
		if e.TraceID != traceID.String() {
			t.Errorf("trace_id = %q, want %q", e.TraceID, traceID.String())
		}
		if e.Source != "agent://integration-agent" {
			t.Errorf("source = %q, want agent://integration-agent", e.Source)
		}
	}
	for _, want := range []string{"task.completed", "tool.result", "handoff.completed"} {
		if !types[want] {
			t.Errorf("missing event type %q (got %v)", want, types)
		}
	}
}

type sessionEvent struct {
	Type    string `json:"type"`
	TraceID string `json:"trace_id"`
	Source  string `json:"source"`
}

// fetchSessionEvents polls GET /sessions/{id}/events until at least 3 events
// are visible (ingest is synchronous, but allow a brief settle window).
func fetchSessionEvents(t *testing.T, sessionID, apiKey string) []sessionEvent {
	t.Helper()
	var payload struct {
		Events []sessionEvent `json:"events"`
	}
	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest("GET", serverURL()+"/sessions/"+sessionID+"/events", nil)
		req.Header.Set("Authorization", "Bearer "+apiKey)
		resp, err := http.DefaultClient.Do(req)
		if err == nil && resp.StatusCode == http.StatusOK {
			payload.Events = nil
			_ = json.NewDecoder(resp.Body).Decode(&payload)
			resp.Body.Close()
			if len(payload.Events) >= 3 {
				return payload.Events
			}
		} else if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(200 * time.Millisecond)
	}
	return payload.Events
}
