package aepexporter

import (
	"testing"

	"github.com/surpradhan/agent-event-protocol/sdks/go/aep"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

var testTraceID = pcommon.TraceID([16]byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef})

func TestClassification(t *testing.T) {
	cases := []struct {
		name string
		kind ptrace.SpanKind
		code ptrace.StatusCode
		want aep.EventType
	}{
		{"process_task", ptrace.SpanKindInternal, ptrace.StatusCodeUnset, aep.EventTypeTaskCompleted},
		{"process_task", ptrace.SpanKindInternal, ptrace.StatusCodeError, aep.EventTypeTaskFailed},
		{"tool_call", ptrace.SpanKindClient, ptrace.StatusCodeUnset, aep.EventTypeToolResult},
		{"tool_call", ptrace.SpanKindInternal, ptrace.StatusCodeUnset, aep.EventTypeTaskCompleted}, // not client/server -> default
		{"handoff_to_agent", ptrace.SpanKindInternal, ptrace.StatusCodeUnset, aep.EventTypeHandoffCompleted},
		{"error_boom", ptrace.SpanKindInternal, ptrace.StatusCodeError, aep.EventTypeErrorRaised},
		{"random_span", ptrace.SpanKindInternal, ptrace.StatusCodeUnset, aep.EventTypeTaskCompleted},
	}
	for _, tc := range cases {
		t.Run(tc.name+"/"+tc.kind.String()+"/"+tc.code.String(), func(t *testing.T) {
			td := ptrace.NewTraces()
			rs := td.ResourceSpans().AppendEmpty()
			rs.Resource().Attributes().PutStr("service.name", "svc")
			span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
			span.SetName(tc.name)
			span.SetKind(tc.kind)
			span.SetTraceID(testTraceID)
			span.Status().SetCode(tc.code)

			events := tracesToEvents(td)
			if len(events) != 1 {
				t.Fatalf("expected 1 event, got %d", len(events))
			}
			if events[0].Type != tc.want {
				t.Errorf("type = %q, want %q", events[0].Type, tc.want)
			}
		})
	}
}

func TestContextPreserved(t *testing.T) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "test-agent")
	span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	span.SetName("process_task")
	span.SetTraceID(testTraceID)
	span.SetParentSpanID(pcommon.SpanID([8]byte{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11}))
	span.Attributes().PutStr("gen_ai.model", "gpt-4")
	span.Attributes().PutStr("custom", "v")

	events := tracesToEvents(td)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev := events[0]

	if ev.Source != "agent://test-agent" {
		t.Errorf("source = %q, want agent://test-agent", ev.Source)
	}
	if ev.TraceID != testTraceID.String() {
		t.Errorf("trace_id = %q, want %q", ev.TraceID, testTraceID.String())
	}
	if want := "ses_" + testTraceID.String()[:16]; ev.SessionID != want {
		t.Errorf("session_id = %q, want %q", ev.SessionID, want)
	}
	if ev.CausationID == nil || *ev.CausationID != "aabbccddeeff0011" {
		t.Errorf("causation_id = %v, want aabbccddeeff0011", ev.CausationID)
	}

	payload, ok := ev.Payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T, want map", ev.Payload)
	}
	if genAI, ok := payload["gen_ai"].(map[string]any); !ok || genAI["gen_ai.model"] != "gpt-4" {
		t.Errorf("gen_ai not separated correctly: %v", payload["gen_ai"])
	}
	if attrs, ok := payload["attributes"].(map[string]any); !ok || attrs["custom"] != "v" {
		t.Errorf("custom attrs missing: %v", payload["attributes"])
	}
}

func TestRootSpanHasNoCausation(t *testing.T) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "svc")
	span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	span.SetName("root_task")
	span.SetTraceID(testTraceID)
	// no parent span id set -> root

	events := tracesToEvents(td)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].CausationID != nil {
		t.Errorf("root span should have nil causation_id, got %v", *events[0].CausationID)
	}
}

func TestServiceNameDefaultsToUnknown(t *testing.T) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	span.SetName("task")
	span.SetTraceID(testTraceID)

	events := tracesToEvents(td)
	if len(events) != 1 || events[0].Source != "agent://unknown" {
		t.Fatalf("expected source agent://unknown, got %+v", events)
	}
}

func TestEmptyTraces(t *testing.T) {
	if got := tracesToEvents(ptrace.NewTraces()); len(got) != 0 {
		t.Errorf("expected 0 events for empty traces, got %d", len(got))
	}
}
