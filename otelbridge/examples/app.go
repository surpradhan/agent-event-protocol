// Package main is an example instrumented application that emits OTEL traces to
// the Collector, which converts them into AEP events via the AEP exporter.
//
// The OTLP endpoint is read from OTEL_EXPORTER_OTLP_ENDPOINT (a leading
// http:// or https:// scheme is stripped), defaulting to localhost:4317.
package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.20.0"
	"go.opentelemetry.io/otel/trace"
)

func otlpEndpoint() string {
	ep := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	ep = strings.TrimPrefix(ep, "http://")
	ep = strings.TrimPrefix(ep, "https://")
	if ep == "" {
		return "localhost:4317"
	}
	return ep
}

func main() {
	ctx := context.Background()

	exporter, err := otlptracegrpc.New(
		ctx,
		otlptracegrpc.WithEndpoint(otlpEndpoint()),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		fmt.Printf("Failed to create exporter: %v\n", err)
		return
	}
	defer func() {
		if err := exporter.Shutdown(ctx); err != nil {
			fmt.Printf("Failed to shutdown exporter: %v\n", err)
		}
	}()

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String("demo-agent"),
			semconv.ServiceVersionKey.String("1.0.0"),
		),
	)
	if err != nil {
		fmt.Printf("Failed to create resource: %v\n", err)
		return
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	defer func() {
		if err := tp.Shutdown(ctx); err != nil {
			fmt.Printf("Failed to shutdown tracer provider: %v\n", err)
		}
	}()

	otel.SetTracerProvider(tp)
	tracer := otel.Tracer("demo-app")

	// Task execution flow with a nested tool call and summarization.
	fmt.Println("Starting demo task execution...")
	taskCtx, taskSpan := tracer.Start(ctx, "process_task")
	taskSpan.SetAttributes(
		attribute.String("gen_ai.model", "gpt-4"),
		attribute.String("task.type", "research"),
	)
	time.Sleep(100 * time.Millisecond)

	toolCtx, toolSpan := tracer.Start(taskCtx, "tool_call_search",
		trace.WithAttributes(attribute.String("tool.name", "web_search")))
	toolSpan.SetAttributes(attribute.String("tool.input", "AI safety research papers"))
	time.Sleep(50 * time.Millisecond)
	toolSpan.End()

	_, resultSpan := tracer.Start(toolCtx, "tool_result_search")
	resultSpan.SetAttributes(attribute.Int("tool.results_count", 5))
	resultSpan.End()

	_, sumSpan := tracer.Start(taskCtx, "summarize_results")
	time.Sleep(75 * time.Millisecond)
	sumSpan.End()

	taskSpan.End()

	// Error span.
	fmt.Println("Demonstrating error handling...")
	_, errSpan := tracer.Start(ctx, "error_handling_demo")
	errSpan.SetAttributes(attribute.String("error.kind", "validation_error"))
	errSpan.AddEvent("exception",
		trace.WithAttributes(attribute.String("exception.message", "Invalid input format")))
	errSpan.End()

	// Handoff to a sub-agent.
	fmt.Println("Demonstrating agent handoff...")
	_, hSpan := tracer.Start(ctx, "handoff_to_researcher_agent")
	hSpan.SetAttributes(
		attribute.String("agent.target", "researcher-agent"),
		attribute.String("task.description", "Deep research on AI safety"),
	)
	time.Sleep(25 * time.Millisecond)
	hSpan.End()

	fmt.Println("Demo complete. Check the AEP dashboard at http://localhost:8787/dashboard")

	// Give the batch span processor time to flush.
	time.Sleep(2 * time.Second)
}
