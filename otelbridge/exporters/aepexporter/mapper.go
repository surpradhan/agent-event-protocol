package aepexporter

import (
	"fmt"
	"strings"

	"github.com/surpradhan/agent-event-protocol/sdks/go/aep"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// tracesToEvents converts a batch of OTEL traces (Collector pdata form) into AEP
// events. Spans that fail to map are skipped; the returned slice contains every
// successfully mapped event.
//
// Classification priority mirrors the AEP reference mapper
// (sdks/python/aep/otel/mapper.py and sdks/go/aep/otel/mapper.go):
// error > handoff > tool > task > default.
func tracesToEvents(td ptrace.Traces) []*aep.Event {
	var events []*aep.Event

	resourceSpans := td.ResourceSpans()
	for i := 0; i < resourceSpans.Len(); i++ {
		rs := resourceSpans.At(i)
		serviceName := serviceNameOf(rs.Resource())

		scopeSpans := rs.ScopeSpans()
		for j := 0; j < scopeSpans.Len(); j++ {
			spans := scopeSpans.At(j).Spans()
			for k := 0; k < spans.Len(); k++ {
				if ev, err := spanToEvent(spans.At(k), serviceName); err == nil && ev != nil {
					events = append(events, ev)
				}
			}
		}
	}

	return events
}

// spanToEvent maps a single span to an AEP event.
func spanToEvent(span ptrace.Span, serviceName string) (*aep.Event, error) {
	spanName := span.Name()
	spanKind := span.Kind().String()
	attrs := span.Attributes().AsRaw()
	traceID := span.TraceID().String()

	source := fmt.Sprintf("agent://%s", serviceName)
	sessionID := deriveSessionID(traceID)

	opts := &aep.CreateEventOptions{Subject: &spanName}
	if pid := span.ParentSpanID(); !pid.IsEmpty() {
		causation := pid.String()
		opts.CausationID = &causation
	}

	payload := buildPayload(attrs, spanName, spanKind)

	var eventType aep.EventType
	switch {
	case isErrorSpan(span):
		eventType = aep.EventTypeErrorRaised
		payload = buildErrorPayload(span, attrs)
	case isHandoffSpan(spanName):
		eventType = aep.EventTypeHandoffCompleted
	case isToolSpan(spanName, spanKind):
		eventType = aep.EventTypeToolResult
	case isTaskSpan(spanName):
		if span.Status().Code() == ptrace.StatusCodeError {
			eventType = aep.EventTypeTaskFailed
		} else {
			eventType = aep.EventTypeTaskCompleted
		}
	default:
		eventType = aep.EventTypeTaskCompleted
	}

	return aep.CreateEvent(source, eventType, sessionID, traceID, payload, opts)
}

func serviceNameOf(res pcommon.Resource) string {
	if v, ok := res.Attributes().Get("service.name"); ok {
		if s := v.AsString(); s != "" {
			return s
		}
	}
	return "unknown"
}

func isTaskSpan(name string) bool {
	return strings.Contains(strings.ToLower(name), "task")
}

func isToolSpan(name, kind string) bool {
	k := strings.ToUpper(kind)
	return strings.Contains(strings.ToLower(name), "tool") &&
		(k == "CLIENT" || k == "SERVER")
}

func isHandoffSpan(name string) bool {
	return strings.Contains(strings.ToLower(name), "handoff")
}

// isErrorSpan reports whether a span maps to error.raised: an error status AND
// a name containing "error". Task spans with error status map to task.failed.
func isErrorSpan(span ptrace.Span) bool {
	return span.Status().Code() == ptrace.StatusCodeError &&
		strings.Contains(strings.ToLower(span.Name()), "error")
}

func buildPayload(attrs map[string]any, spanName, spanKind string) map[string]any {
	payload := map[string]any{
		"span_name": spanName,
		"span_kind": spanKind,
	}

	genAI := map[string]any{}
	custom := map[string]any{}
	for k, v := range attrs {
		if strings.HasPrefix(k, "gen_ai.") {
			genAI[k] = v
		} else {
			custom[k] = v
		}
	}
	if len(genAI) > 0 {
		payload["gen_ai"] = genAI
	}
	if len(custom) > 0 {
		payload["attributes"] = custom
	}

	return payload
}

func buildErrorPayload(span ptrace.Span, attrs map[string]any) map[string]any {
	payload := buildPayload(attrs, span.Name(), span.Kind().String())

	if msg := span.Status().Message(); msg != "" {
		payload["error_description"] = msg
	}

	events := span.Events()
	for i := 0; i < events.Len(); i++ {
		ev := events.At(i)
		if ev.Name() == "exception" {
			payload["exception"] = ev.Attributes().AsRaw()
			break
		}
	}

	return payload
}

// deriveSessionID derives a session id from the trace id (first 16 hex chars),
// matching the AEP reference mappers for cross-language parity.
func deriveSessionID(traceID string) string {
	if len(traceID) < 16 {
		return fmt.Sprintf("ses_%s", traceID)
	}
	return fmt.Sprintf("ses_%s", traceID[:16])
}
