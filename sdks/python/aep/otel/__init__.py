"""OpenTelemetry bridge for Agent Event Protocol.

Provides span-to-event mapping and a SpanExporter for seamless integration.
"""

from aep.otel.exporter import AEPSpanExporter
from aep.otel.mapper import map_span_to_event

__all__ = [
    "AEPSpanExporter",
    "map_span_to_event",
]
