package otel

import (
	"context"
	"testing"

	"github.com/surpradhan/aep-go/aep"
	"go.opentelemetry.io/sdk/trace"
	"go.opentelemetry.io/sdk/trace/tracetest"
)

func TestIsTaskSpan(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"my_task", true},
		{"Task Processing", true},
		{"tool_call", false},
		{"TASK", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isTaskSpan(tt.name)
			if got != tt.want {
				t.Errorf("isTaskSpan(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestIsToolSpan(t *testing.T) {
	tests := []struct {
		name string
		kind string
		want bool
	}{
		{"tool_call", "CLIENT", true},
		{"tool_result", "SERVER", true},
		{"tool_call", "INTERNAL", false},
		{"task_run", "CLIENT", false},
	}

	for _, tt := range tests {
		t.Run(tt.name+"/"+tt.kind, func(t *testing.T) {
			got := isToolSpan(tt.name, tt.kind)
			if got != tt.want {
				t.Errorf("isToolSpan(%q, %q) = %v, want %v", tt.name, tt.kind, got, tt.want)
			}
		})
	}
}

func TestIsHandoffSpan(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"handoff_start", true},
		{"Handoff to Subagent", true},
		{"task_complete", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isHandoffSpan(tt.name)
			if got != tt.want {
				t.Errorf("isHandoffSpan(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestFormatTraceID(t *testing.T) {
	var traceID [16]byte
	traceID[15] = 0xFF
	got := formatTraceID(traceID)
	if got != "000000000000000000000000000000ff" {
		t.Errorf("formatTraceID() = %q, want %q", got, "000000000000000000000000000000ff")
	}
}

func TestFormatSpanID(t *testing.T) {
	var spanID [8]byte
	spanID[7] = 0xFF
	got := formatSpanID(spanID)
	if got != "00000000000000ff" {
		t.Errorf("formatSpanID() = %q, want %q", got, "00000000000000ff")
	}
}

func TestDeriveSessionID(t *testing.T) {
	sid1 := deriveSessionID("my-service", "process_task")
	sid2 := deriveSessionID("my-service", "process_task")

	if sid1 != sid2 {
		t.Errorf("deriveSessionID should be deterministic, got %q and %q", sid1, sid2)
	}

	if !len(sid1) > 4 || sid1[:4] != "ses_" {
		t.Errorf("deriveSessionID(%q, %q) = %q, want to start with 'ses_'", "my-service", "process_task", sid1)
	}
}

func TestMapSpanToEvent(t *testing.T) {
	// Create a test span
	spanRecorder := tracetest.NewSpanRecorder()
	tp := trace.NewTracerProvider(trace.WithSpanProcessor(spanRecorder))
	tracer := tp.Tracer("test")
	ctx, span := tracer.Start(context.Background(), "my_task")
	span.End()
	defer tp.Shutdown(context.Background())

	// Get the recorded span
	recordedSpans := spanRecorder.Ended()
	if len(recordedSpans) == 0 {
		t.Fatal("no spans recorded")
	}
	recordedSpan := recordedSpans[0]

	resource := map[string]string{"service.name": "test-agent"}
	event, err := MapSpanToEvent(recordedSpan, resource)

	if err != nil {
		t.Fatalf("MapSpanToEvent() error = %v", err)
	}

	if event.Type != aep.EventTypeTaskCompleted {
		t.Errorf("MapSpanToEvent() event type = %q, want %q", event.Type, aep.EventTypeTaskCompleted)
	}

	if event.Source != "agent://test-agent" {
		t.Errorf("MapSpanToEvent() source = %q, want %q", event.Source, "agent://test-agent")
	}
}

func TestBuildPayload(t *testing.T) {
	attrs := map[string]interface{}{
		"gen_ai.model":     "gpt-4",
		"custom_attr":      "value",
	}

	payload := buildPayload(attrs, "test_span", "CLIENT")

	if payload["span_name"] != "test_span" {
		t.Errorf("buildPayload() span_name = %q, want %q", payload["span_name"], "test_span")
	}

	if genAI, ok := payload["gen_ai"].(map[string]interface{}); !ok {
		t.Error("buildPayload() gen_ai not found")
	} else if genAI["gen_ai.model"] != "gpt-4" {
		t.Errorf("buildPayload() gen_ai.model = %v, want %v", genAI["gen_ai.model"], "gpt-4")
	}

	if attrs, ok := payload["attributes"].(map[string]interface{}); !ok {
		t.Error("buildPayload() attributes not found")
	} else if attrs["custom_attr"] != "value" {
		t.Errorf("buildPayload() custom_attr = %v, want %v", attrs["custom_attr"], "value")
	}
}
