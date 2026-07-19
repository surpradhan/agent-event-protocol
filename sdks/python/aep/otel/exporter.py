"""OpenTelemetry SpanExporter for AEP.

Implements the OTEL SpanExporter interface to emit AEP events from OTEL spans.
"""

from __future__ import annotations

import logging
from typing import Any, Sequence

from opentelemetry.sdk.trace.export import ReadableSpan, SpanExporter, SpanExportResult

from aep.client import AEPClient
from aep.otel.mapper import map_span_to_event

logger = logging.getLogger(__name__)


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
        # Export batches run on the OTel exporter thread: keep the retry
        # budget small so a down server doesn't stall span export.
        self._client = AEPClient(server_url=server_url, api_key=api_key, max_retries=1)
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

            failed_spans = 0
            for span in spans:
                try:
                    _, event = map_span_to_event(span, resource_attrs)
                    if event:
                        self._client.emit(event)
                except Exception as e:
                    # Log but continue processing other spans
                    failed_spans += 1
                    logger.warning(
                        "Failed to export span %s: %s",
                        span.name,
                        e,
                        exc_info=True,
                    )

            if failed_spans == len(spans):
                # All spans failed
                logger.error("All %d spans failed to export", len(spans))
                return SpanExportResult.FAILURE
            elif failed_spans > 0:
                # Partial failure (some succeeded, some failed)
                logger.warning(
                    "Exported %d/%d spans (failed: %d)",
                    len(spans) - failed_spans,
                    len(spans),
                    failed_spans,
                )
                return SpanExportResult.SUCCESS

            return SpanExportResult.SUCCESS

        except Exception as e:
            logger.error("Unexpected error exporting spans: %s", e, exc_info=True)
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
