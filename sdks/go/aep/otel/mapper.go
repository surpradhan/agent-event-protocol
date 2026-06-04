// Package otel provides OpenTelemetry integration for AEP.
// It includes span-to-event mapping and exporters for sending spans to AEP.
package otel

import (
	"fmt"
	"strings"

	"github.com/surpradhan/aep-go/aep"
	"go.opentelemetry.io/otel/sdk/trace"
)

// MapSpanToEvent converts an OTEL ReadOnlySpan to an AEP event.
// Returns (intermediateEvents, finalEvent) where finalEvent is the main event
// emitted when the span ends.
func MapSpanToEvent(span trace.ReadOnlySpan, resource map[string]string) (*aep.Event, error) {
	spanName := span.Name()
	spanKind := span.SpanKind().String()
	attrs := span.Attributes()
	traceID := formatTraceID(span.SpanContext().TraceID())
	spanID := formatSpanID(span.SpanContext().SpanID())
	parentSpanID := formatSpanID(span.Parent().SpanID())
	serviceName := resource["service.name"]
	if serviceName == "" {
		serviceName = "unknown"
	}

	source := fmt.Sprintf("agent://%s", serviceName)
	sessionID := deriveSessionID(traceID)

	payload := buildPayload(attrs, spanName, spanKind)

	var eventType aep.EventType

	if isTaskSpan(spanName) {
		if span.Status().Code == 0 { // OK status
			eventType = aep.EventTypeTaskCompleted
		} else {
			eventType = aep.EventTypeTaskFailed
		}
	} else if isToolSpan(spanName, spanKind) {
		eventType = aep.EventTypeToolResult
	} else if isHandoffSpan(spanName) {
		eventType = aep.EventTypeHandoffCompleted
	} else if isErrorSpan(span) {
		eventType = aep.EventTypeErrorRaised
		payload = buildErrorPayload(span, attrs)
	} else {
		eventType = aep.EventTypeTaskCompleted
	}

	event := aep.CreateEvent(
		source,
		eventType,
		sessionID,
		traceID,
		payload,
	)

	event.CausationID = parentSpanID
	event.Subject = &spanName

	return event, nil
}

func isTaskSpan(name string) bool {
	return strings.Contains(strings.ToLower(name), "task")
}

func isToolSpan(name, kind string) bool {
	return strings.Contains(strings.ToLower(name), "tool") &&
		(kind == "CLIENT" || kind == "SERVER")
}

func isHandoffSpan(name string) bool {
	return strings.Contains(strings.ToLower(name), "handoff")
}

func isErrorSpan(span trace.ReadOnlySpan) bool {
	return span.Status().Code != 0 && strings.Contains(strings.ToLower(span.Name()), "error")
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

	if span.Status().Description != "" {
		payload["error_description"] = span.Status().Description
	}

	for _, event := range span.Events() {
		if event.Name == "exception" {
			payload["exception"] = event.Attributes
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
