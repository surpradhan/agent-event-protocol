# OpenTelemetry Bridge for AEP

The OTEL bridge enables seamless integration between OpenTelemetry (OTEL) and the Agent Event Protocol (AEP).

## Overview

The bridge provides:
- **Span-to-event mapping** — Converts OTEL spans to AEP events with intelligent type detection
- **AEPSpanExporter** — A standard OTEL SpanExporter that emits mapped events to the AEP ingest API
- **Trace context preservation** — Maps trace IDs, span IDs, and parent-child relationships to AEP causation chains

## Span-to-Event Mapping

The mapper uses span names and attributes to determine the appropriate AEP event type:

| Span Pattern | AEP Event Type | Rules |
|--------------|--------|-------|
| Name contains "task" | `task.created` → `task.completed`/`task.failed` | Span status determines success/failure |
| Name contains "tool" + kind = CLIENT/SERVER | `tool.called` → `tool.result` | Captures tool invocations |
| Name contains "handoff" | `handoff.started` → `handoff.completed` | Multi-agent handoffs |
| Has error status | `error.raised` | Non-OK span status |
| Default | `task.completed` | Unmapped spans default to task completion |

### Attribute Mapping

OTEL span attributes are preserved in AEP event payloads:

```python
span.set_attribute("gen_ai.model", "gpt-4")  # → payload.gen_ai.gen_ai.model
span.set_attribute("custom_field", "value")   # → payload.attributes.custom_field
```

The bridge separates `gen_ai.*` attributes (OpenTelemetry GenAI SIG) from custom attributes for better organization.

### Trace Context Mapping

- OTEL `trace_id` → AEP `trace_id` (hex string, same value)
- OTEL `parent span_id` → AEP `causation_id` (enables parent-child linking)
- OTEL `Resource.service.name` → AEP `source` (as `agent://service.name`)

## Usage

### Basic Setup

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.resources import Resource

from aep.otel.exporter import AEPSpanExporter

# Create a resource with service name
resource = Resource.create({"service.name": "my-agent"})

# Create tracer provider
tracer_provider = TracerProvider(resource=resource)

# Add AEP exporter
aep_exporter = AEPSpanExporter(
    server_url="http://localhost:8787",
    api_key="your-api-key",  # Optional
)
aep_exporter.set_resource(resource)
tracer_provider.add_span_processor(SimpleSpanProcessor(aep_exporter))

trace.set_tracer_provider(tracer_provider)
```

### Instrumenting Code

```python
tracer = trace.get_tracer(__name__)

# Task span
with tracer.start_as_current_span("process_request") as span:
    span.set_attribute("gen_ai.model", "gpt-4")
    result = process_request()

# Tool call span
with tracer.start_as_current_span("tool_search") as span:
    span.set_attribute("gen_ai.model", "search-api")
    results = search(query)

# Error handling
try:
    with tracer.start_as_current_span("risky_operation") as span:
        risky_operation()
except Exception as e:
    span.record_exception(e)
```

### Batch Processing (Production)

For high-throughput scenarios, use `BatchSpanProcessor`:

```python
from opentelemetry.sdk.trace.export import BatchSpanProcessor

tracer_provider.add_span_processor(
    BatchSpanProcessor(
        aep_exporter,
        max_queue_size=2048,
        max_export_batch_size=512,
        schedule_delay_millis=5000,
    )
)
```

## API Reference

### AEPSpanExporter

```python
class AEPSpanExporter(SpanExporter):
    def __init__(
        self,
        server_url: str = "http://localhost:8787",
        api_key: str | None = None,
        batch_size: int = 100,
    ):
        """Initialize the AEP span exporter.
        
        Args:
            server_url: AEP ingest server URL
            api_key: API key for authentication (optional)
            batch_size: Batch size (reserved for future use)
        """

    def set_resource(self, resource: Resource) -> None:
        """Set the resource (tracer provider must call this)."""

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        """Export spans as AEP events."""

    def shutdown(self) -> None:
        """Shutdown and close the underlying client."""

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Force flush pending events."""
```

### map_span_to_event

```python
def map_span_to_event(
    span: ReadableSpan,
    resource: dict[str, str],
) -> tuple[list[dict], dict]:
    """Map an OTEL span to AEP event(s).
    
    Returns:
        (intermediate_events, final_event)
        - intermediate_events: Events emitted during span (currently empty)
        - final_event: Event emitted on span end
    """
```

## Examples

### Example 1: Multi-Agent Orchestrator

```python
from opentelemetry import trace

tracer = trace.get_tracer("multi_agent_demo")

def orchestrator():
    with tracer.start_as_current_span("orchestrator_task") as span:
        span.set_attribute("agent_role", "orchestrator")

        # Search sub-agent
        results = call_subagent("search_agent", "climate impacts")

        # Summarize sub-agent
        summary = call_subagent("summarize_agent", results)

        return summary

def call_subagent(agent_name, input_data):
    with tracer.start_as_current_span(f"handoff_{agent_name}"):
        # Call subagent
        return agent_call(agent_name, input_data)
```

Maps to:
- `orchestrator_task` (completed) with `agent_role=orchestrator`
- `handoff_search_agent` (completed) with parent → causation chain preserved
- `handoff_summarize_agent` (completed) with parent → causation chain preserved

### Example 2: Tool-Instrumented Agent

```python
def agent_with_tools():
    with tracer.start_as_current_span("research_task"):
        # Tool call 1
        with tracer.start_as_current_span("tool_search"):
            results = search("climate change")

        # Tool call 2
        with tracer.start_as_current_span("tool_summarize"):
            summary = summarize(results)

        return summary
```

Maps to:
- `research_task` → `task.completed`
- `tool_search` → `tool.result`
- `tool_summarize` → `tool.result`

### Example 3: Error Handling

```python
try:
    with tracer.start_as_current_span("risky_operation"):
        risky_operation()
except Exception as e:
    span.record_exception(e)
    span.set_status(trace.Status(trace.StatusCode.ERROR))
```

Maps to: `error.raised` event with exception details in payload.

## Limitations

- The bridge maps spans **on span end** (final events), not on span start
- Session IDs are derived from service name + span name (not from OTEL context)
- GenAI attributes follow the [OpenTelemetry GenAI SIG](https://opentelemetry.io/docs/specs/semconv/gen-ai/) conventions
- Error mapping only triggers if span status is non-OK AND span name contains "error"

## Contributing

To add new mapping rules, edit `aep/otel/mapper.py` and add tests to `tests/unit/test_otel_mapper.py`.

## See Also

- [OTEL Python SDK](https://opentelemetry.io/docs/instrumentation/python/)
- [AEP Event Protocol](../../README.md)
