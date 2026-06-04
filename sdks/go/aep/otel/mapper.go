// Package otel provides OpenTelemetry integration for AEP.
// It includes span-to-event mapping and exporters for sending spans to AEP.
package otel

import (
	"fmt"
	"strings"

	"github.com/surpradhan/aep-go/aep"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/sdk/trace"
)

// MapSpanToEvent converts an OTEL ReadOnlySpan to an AEP event.
//
// Classification priority mirrors the Python reference implementation
// (sdks/python/aep/otel/mapper.py): error > handoff > tool > task > default.
// This ensures error conditions are not masked by another classification.
func MapSpanToEvent(span trace.ReadOnlySpan, resource map[string]string) (*aep.Event, error) {
	spanName := span.Name()
	spanKind := span.SpanKind().String()
	attrs := attrsToMap(span.Attributes())
	traceID := formatTraceID(span.SpanContext().TraceID())

	serviceName := resource["service.name"]
	if serviceName == "" {
		serviceName = "unknown"
	}

	source := fmt.Sprintf("agent://%s", serviceName)
	sessionID := deriveSessionID(traceID)

	opts := &aep.CreateEventOptions{
		Subject: &spanName,
	}
	// Preserve trace context: a parent span id becomes the causation id.
	// Root spans have no parent, so causation id is left unset.
	if parent := span.Parent(); parent.HasSpanID() {
		pid := formatSpanID(parent.SpanID())
		opts.CausationID = &pid
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
		if span.Status().Code == codes.Error {
			eventType = aep.EventTypeTaskFailed
		} else {
			eventType = aep.EventTypeTaskCompleted
		}
	default:
		eventType = aep.EventTypeTaskCompleted
	}

	return aep.CreateEvent(source, eventType, sessionID, traceID, payload, opts)
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

// isErrorSpan reports whether the span represents an error event (not merely a
// failure). It maps to error.raised only when the span has an error status AND
// its name contains "error"; task spans with error status map to task.failed.
func isErrorSpan(span trace.ReadOnlySpan) bool {
	return span.Status().Code == codes.Error &&
		strings.Contains(strings.ToLower(span.Name()), "error")
}

// attrsToMap converts an OTEL attribute slice to a plain map for payload use.
func attrsToMap(kvs []attribute.KeyValue) map[string]interface{} {
	m := make(map[string]interface{}, len(kvs))
	for _, kv := range kvs {
		m[string(kv.Key)] = kv.Value.AsInterface()
	}
	return m
}

func buildPayload(attrs map[string]interface{}, spanName, spanKind string) map[string]interface{} {
	payload := map[string]interface{}{
		"span_name": spanName,
		"span_kind": spanKind,
	}

	genAIAttrs := make(map[string]interface{})
	customAttrs := make(map[string]interface{})

	for k, v := range attrs {
		if strings.HasPrefix(k, "gen_ai.") {
			genAIAttrs[k] = v
		} else {
			customAttrs[k] = v
		}
	}

	if len(genAIAttrs) > 0 {
		payload["gen_ai"] = genAIAttrs
	}

	if len(customAttrs) > 0 {
		payload["attributes"] = customAttrs
	}

	return payload
}

func buildErrorPayload(span trace.ReadOnlySpan, attrs map[string]interface{}) map[string]interface{} {
	payload := buildPayload(attrs, span.Name(), span.SpanKind().String())

	if desc := span.Status().Description; desc != "" {
		payload["error_description"] = desc
	}

	for _, ev := range span.Events() {
		if ev.Name == "exception" {
			payload["exception"] = attrsToMap(ev.Attributes)
			break
		}
	}

	return payload
}

func formatTraceID(traceID [16]byte) string {
	return fmt.Sprintf("%032x", traceID)
}

func formatSpanID(spanID [8]byte) string {
	return fmt.Sprintf("%016x", spanID)
}

func deriveSessionID(traceID string) string {
	// Derive session ID from trace_id to ensure sessions group by distributed execution.
	// Use first 16 hex chars of trace_id (64 bits entropy) to prevent collisions
	// while maintaining consistency across all spans in a trace.
	if len(traceID) < 16 {
		return fmt.Sprintf("ses_%s", traceID)
	}
	return fmt.Sprintf("ses_%s", traceID[:16])
}
