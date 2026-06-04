"""OpenTelemetry SpanExporter for AEP.

Implements the OTEL SpanExporter interface to emit AEP events from OTEL spans.
"""

from __future__ import annotations

from typing import Any, Sequence

from opentelemetry.sdk.trace.export import ReadableSpan, SpanExporter, SpanExportResult

from aep.client import AEPClient
from aep.otel.mapper import map_span_to_event


class AEPSpanExporter(SpanExporter):
    """Exports OTEL spans to AEP ingest API.

    Maps each span to an AEP event and emits via AEPClient.
    """

    def __init__(
        self,
        server_url: str = "http://localhost:8787",
        api_key: str | None = None,
        batch_size: int = 100,
    ):
        """Initialize the AEP span exporter.

        Args:
            server_url: AEP server URL (default: http://localhost:8787)
            api_key: API key for authentication (optional)
            batch_size: Number of spans to batch before flushing (unused for now, for future)
        """
        self.server_url = server_url
        self.api_key = api_key
        self.batch_size = batch_size
        self._client = AEPClient(server_url=server_url, api_key=api_key)
        self._resource = None

    def set_resource(self, resource: Any) -> None:
        """Set the resource attributes from the tracer provider."""
        self._resource = resource

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        """Export spans as AEP events.

        Args:
            spans: Sequence of ReadableSpan objects from OTEL

        Returns:
            SpanExportResult.SUCCESS if all spans were exported successfully,
            SpanExportResult.FAILURE otherwise.
        """
        if not spans:
            return SpanExportResult.SUCCESS

        try:
            # Extract resource attributes
            resource_attrs = {}
            if self._resource and hasattr(self._resource, "attributes"):
                resource_attrs = dict(self._resource.attributes)

            for span in spans:
                try:
                    _, event = map_span_to_event(span, resource_attrs)
                    if event:
                        self._client.emit(event)
                except Exception as e:
                    # Log but continue processing other spans
                    print(f"Warning: failed to map span {span.name}: {e}")

            return SpanExportResult.SUCCESS

        except Exception as e:
            print(f"Error exporting spans: {e}")
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        """Shutdown the exporter and close the client."""
        if self._client:
            self._client.close()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Force flush any pending events.

        Args:
            timeout_millis: Timeout in milliseconds (not used currently)

        Returns:
            True if successful, False otherwise.
        """
        # No batching yet, so just return success
        return True
