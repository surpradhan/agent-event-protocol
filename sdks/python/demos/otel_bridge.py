"""Demo: OTEL instrumentation with AEP bridge.

Shows how to instrument a simple agent application with OTEL and export
events to AEP via the AEPSpanExporter.

Run the AEP server first:
  npm run ingest

Then run this demo:
  python demos/otel_bridge.py
"""

import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.resources import Resource

from aep.otel.exporter import AEPSpanExporter


def setup_tracer_with_aep():
    """Set up OTEL tracer with AEP exporter."""
    # Create a resource with service name
    resource = Resource.create({"service.name": "agent-demo"})

    # Create a tracer provider
    tracer_provider = TracerProvider(resource=resource)

    # Create AEP exporter
    aep_exporter = AEPSpanExporter(
        server_url=os.getenv("AEP_SERVER", "http://localhost:8787"),
        api_key=os.getenv("AEP_API_KEY"),
    )

    # Set resource on exporter
    aep_exporter.set_resource(resource)

    # Add span processor (SimpleSpanProcessor for testing, use BatchSpanProcessor in production)
    tracer_provider.add_span_processor(SimpleSpanProcessor(aep_exporter))

    # Set as global tracer provider
    trace.set_tracer_provider(tracer_provider)

    return trace.get_tracer(__name__)


def orchestrator_agent(tracer):
    """Orchestrator agent that delegates to tools."""
    with tracer.start_as_current_span("orchestrator_task") as span:
        span.set_attribute("agent_role", "orchestrator")

        # Call a tool
        search_results = search_tool(tracer, "climate change impacts")
        summarize_results(tracer, search_results)

        print("[Orchestrator] Task complete")


def search_tool(tracer, query):
    """Simulate a search tool call."""
    with tracer.start_as_current_span("tool_search") as span:
        span.set_attribute("gen_ai.model", "search-api")
        span.set_attribute("tool.query", query)

        results = [
            "Climate change is accelerating",
            "Impacts on biodiversity are severe",
            "Global cooperation needed",
        ]

        print(f"[Tool] Searched for: {query}")
        return results


def summarize_results(tracer, results):
    """Simulate a summarization task."""
    with tracer.start_as_current_span("task_summarize") as span:
        span.set_attribute("gen_ai.model", "gpt-4")
        span.set_attribute("result_count", len(results))

        summary = "; ".join(results[:2])
        print(f"[Task] Summary: {summary}")

        return summary


def main():
    """Run the demo."""
    print("=== OTEL Bridge Demo ===\n")

    # Set up tracer with AEP exporter
    tracer = setup_tracer_with_aep()

    # Run orchestrator agent
    orchestrator_agent(tracer)

    print("\n✓ Events emitted to AEP")
    print("  Check the dashboard at http://localhost:8787/dashboard")


if __name__ == "__main__":
    main()
