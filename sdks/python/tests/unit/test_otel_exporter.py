"""Unit tests for OTEL SpanExporter."""

import logging
import unittest
from unittest.mock import MagicMock, patch

from opentelemetry.sdk.trace.export import SpanExportResult

from aep.otel.exporter import AEPSpanExporter, logger


class TestAEPSpanExporter(unittest.TestCase):
    """Test OTEL span exporter for AEP."""

    def setUp(self):
        """Set up test fixtures."""
        self.exporter = AEPSpanExporter(
            server_url="http://localhost:8787",
            api_key="test-key",
        )

    def test_init(self):
        """Test exporter initialization."""
        self.assertEqual(self.exporter.server_url, "http://localhost:8787")
        self.assertEqual(self.exporter.api_key, "test-key")
        self.assertEqual(self.exporter.batch_size, 100)

    def test_set_resource(self):
        """Test setting resource attributes."""
        resource = MagicMock()
        resource.attributes = {"service.name": "test-service"}

        self.exporter.set_resource(resource)
        self.assertEqual(self.exporter._resource, resource)

    def test_export_empty_spans(self):
        """Test exporting empty span list."""
        result = self.exporter.export([])
        self.assertEqual(result, SpanExportResult.SUCCESS)

    def test_force_flush(self):
        """Test force_flush method."""
        result = self.exporter.force_flush(timeout_millis=5000)
        self.assertTrue(result)

    def test_shutdown(self):
        """Test shutdown method."""
        with patch.object(self.exporter._client, "close") as mock_close:
            self.exporter.shutdown()
            mock_close.assert_called_once()

    @patch("aep.otel.exporter.map_span_to_event")
    def test_export_spans(self, mock_mapper):
        """Test exporting spans successfully."""
        # Create mock spans
        span1 = MagicMock()
        span1.name = "task1"
        span2 = MagicMock()
        span2.name = "task2"

        # Mock the mapper to return events
        event1 = {"type": "task.completed", "id": "evt_1"}
        event2 = {"type": "task.completed", "id": "evt_2"}
        mock_mapper.side_effect = [([], event1), ([], event2)]

        # Mock the client
        mock_client = MagicMock()
        self.exporter._client = mock_client

        # Export spans
        result = self.exporter.export([span1, span2])

        # Verify
        self.assertEqual(result, SpanExportResult.SUCCESS)
        self.assertEqual(mock_client.emit.call_count, 2)

    @patch("aep.otel.exporter.map_span_to_event")
    def test_export_span_error_handling(self, mock_mapper):
        """Test error handling during span export."""
        span = MagicMock()
        span.name = "error_span"

        # Mock the mapper to raise an exception
        mock_mapper.side_effect = ValueError("Mapping error")

        # Mock the client
        mock_client = MagicMock()
        self.exporter._client = mock_client

        # Export span - should return FAILURE when all spans fail
        result = self.exporter.export([span])

        # Verify it returns FAILURE when all spans fail
        self.assertEqual(result, SpanExportResult.FAILURE)

    @patch("aep.otel.exporter.AEPClient")
    def test_export_client_error(self, mock_client_class):
        """Test handling of client errors during export."""
        span = MagicMock()
        span.name = "task"

        # Mock the client to raise an exception
        mock_client = MagicMock()
        mock_client.emit.side_effect = Exception("Connection error")
        mock_client_class.return_value = mock_client
        self.exporter._client = mock_client

        with patch("aep.otel.exporter.map_span_to_event") as mock_mapper:
            event = {"type": "task.completed"}
            mock_mapper.return_value = ([], event)

            # Export should return FAILURE when client fails to emit
            result = self.exporter.export([span])
            self.assertEqual(result, SpanExportResult.FAILURE)

    @patch("aep.otel.exporter.map_span_to_event")
    def test_export_partial_failure(self, mock_mapper):
        """Test handling of partial failures (some spans succeed, some fail)."""
        span1 = MagicMock()
        span1.name = "task1"
        span2 = MagicMock()
        span2.name = "task2"

        # First span succeeds, second fails
        event1 = {"type": "task.completed", "id": "evt_1"}
        mock_mapper.side_effect = [([], event1), ValueError("Bad span")]

        mock_client = MagicMock()
        self.exporter._client = mock_client

        with patch("aep.otel.exporter.logger") as mock_logger:
            result = self.exporter.export([span1, span2])

            # Should return SUCCESS for partial success
            self.assertEqual(result, SpanExportResult.SUCCESS)
            # Should have logged a warning
            self.assertTrue(mock_logger.warning.called)

    @patch("aep.otel.exporter.map_span_to_event")
    def test_export_all_failures(self, mock_mapper):
        """Test handling when all spans fail to map."""
        span1 = MagicMock()
        span1.name = "task1"
        span2 = MagicMock()
        span2.name = "task2"

        # All spans fail
        mock_mapper.side_effect = [ValueError("Bad span 1"), ValueError("Bad span 2")]

        mock_client = MagicMock()
        self.exporter._client = mock_client

        with patch("aep.otel.exporter.logger") as mock_logger:
            result = self.exporter.export([span1, span2])

            # Should return FAILURE when all fail
            self.assertEqual(result, SpanExportResult.FAILURE)
            # Should have logged errors
            self.assertTrue(mock_logger.error.called)

    def test_export_uses_logging(self):
        """Verify that logger is used, not print()."""
        span = MagicMock()
        span.name = "task"

        with patch("aep.otel.exporter.map_span_to_event") as mock_mapper:
            mock_mapper.side_effect = ValueError("Mapping error")
            mock_client = MagicMock()
            self.exporter._client = mock_client

            with patch("aep.otel.exporter.logger") as mock_logger:
                self.exporter.export([span])
                # Should have called logger.warning
                self.assertTrue(mock_logger.warning.called)


if __name__ == "__main__":
    unittest.main()
