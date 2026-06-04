"""Unit tests for OTEL span-to-event mapper."""

import unittest
from unittest.mock import MagicMock

from aep._types import EventType
from aep.otel.mapper import (
    _build_error_payload,
    _build_payload,
    _derive_session_id,
    _format_span_id,
    _format_trace_id,
    _is_error_span,
    _is_handoff_span,
    _is_task_span,
    _is_tool_span,
    map_span_to_event,
)


class TestSpanTypeDetection(unittest.TestCase):
    """Test span type classification."""

    def test_is_task_span(self):
        self.assertTrue(_is_task_span("my_task"))
        self.assertTrue(_is_task_span("Task Processing"))
        self.assertFalse(_is_task_span("tool_call"))

    def test_is_tool_span(self):
        self.assertTrue(_is_tool_span("tool_call", "CLIENT"))
        self.assertTrue(_is_tool_span("tool_result", "SERVER"))
        self.assertFalse(_is_tool_span("tool_call", "INTERNAL"))
        self.assertFalse(_is_tool_span("task_run", "CLIENT"))

    def test_is_handoff_span(self):
        self.assertTrue(_is_handoff_span("handoff_start"))
        self.assertTrue(_is_handoff_span("Handoff to Subagent"))
        self.assertFalse(_is_handoff_span("task_complete"))

    def test_is_error_span(self):
        # OK status should not be error
        span_ok = MagicMock()
        span_ok.name = "error_handler"
        span_ok.status.is_ok = True
        self.assertFalse(_is_error_span(span_ok))

        # Error status + "error" in name should be error
        span_error = MagicMock()
        span_error.name = "error_handler"
        span_error.status.is_ok = False
        self.assertTrue(_is_error_span(span_error))

        # Error status but NO "error" in name should NOT be error
        # (it would be TASK_FAILED or similar)
        span_other_error = MagicMock()
        span_other_error.name = "database_query"
        span_other_error.status.is_ok = False
        self.assertFalse(_is_error_span(span_other_error))

        # No status attribute should not be error
        span_no_status = MagicMock(spec=[])
        span_no_status.name = "error_handler"
        self.assertFalse(_is_error_span(span_no_status))


class TestFormatting(unittest.TestCase):
    """Test ID formatting."""

    def test_format_trace_id_int(self):
        trace_id = 0x12345678ABCDEF00
        result = _format_trace_id(trace_id)
        self.assertEqual(result, "000000000000000012345678abcdef00")

    def test_format_trace_id_str(self):
        trace_id = "12345678abcdef00"
        result = _format_trace_id(trace_id)
        self.assertEqual(result, "12345678abcdef00")

    def test_format_span_id_int(self):
        span_id = 0x123456ABCDEF0000
        result = _format_span_id(span_id)
        self.assertEqual(result, "123456abcdef0000")

    def test_format_span_id_str(self):
        span_id = "abcdef0000000001"
        result = _format_span_id(span_id)
        self.assertEqual(result, "abcdef0000000001")

    def test_format_span_id_none(self):
        result = _format_span_id(None)
        self.assertIsNone(result)


class TestPayloadBuilding(unittest.TestCase):
    """Test payload construction."""

    def test_build_payload_basic(self):
        attrs = {}
        payload = _build_payload(attrs, "my_span", "INTERNAL")
        self.assertEqual(payload["span_name"], "my_span")
        self.assertEqual(payload["span_kind"], "INTERNAL")

    def test_build_payload_with_gen_ai_attrs(self):
        attrs = {
            "gen_ai.model": "gpt-4",
            "gen_ai.request.temperature": 0.7,
            "custom_attr": "value",
        }
        payload = _build_payload(attrs, "span", "CLIENT")
        self.assertIn("gen_ai", payload)
        self.assertEqual(payload["gen_ai"]["gen_ai.model"], "gpt-4")
        self.assertIn("attributes", payload)
        self.assertEqual(payload["attributes"]["custom_attr"], "value")

    def test_build_error_payload(self):
        span = MagicMock()
        span.name = "error_span"
        span.kind.name = "SERVER"
        span.status.description = "Connection timeout"
        span.events = []

        attrs = {"error_code": "500"}
        payload = _build_error_payload(span, attrs)
        self.assertEqual(payload["error_description"], "Connection timeout")
        self.assertIn("attributes", payload)


class TestSessionIdDerivation(unittest.TestCase):
    """Test session ID derivation."""

    def test_derive_session_id_consistency(self):
        trace_id = "0123456789abcdef0123456789abcdef"
        sid1 = _derive_session_id(trace_id)
        sid2 = _derive_session_id(trace_id)
        self.assertEqual(sid1, sid2)

    def test_derive_session_id_format(self):
        trace_id = "0123456789abcdef0123456789abcdef"
        sid = _derive_session_id(trace_id)
        self.assertTrue(sid.startswith("ses_"))
        self.assertEqual(len(sid), 20)  # "ses_" + 16 hex chars

    def test_derive_session_id_uses_trace_context(self):
        # Same trace_id should produce same session_id regardless of service
        trace_id = "fedcba9876543210fedcba9876543210"
        sid1 = _derive_session_id(trace_id)
        sid2 = _derive_session_id(trace_id)
        self.assertEqual(sid1, sid2)
        # Verify it uses trace_id prefix
        self.assertEqual(sid1, f"ses_{trace_id[:16]}")


class TestMapSpanToEvent(unittest.TestCase):
    """Test complete span-to-event mapping."""

    def setUp(self):
        """Set up mock span and resource."""
        self.resource = MagicMock()
        self.resource.attributes = {"service.name": "my-agent"}

    def _create_span(
        self,
        name="task",
        trace_id=0x12345678,
        span_id=0x87654321,
        parent_span_id=None,
        attributes=None,
        is_ok=True,
    ):
        """Helper to create a mock span."""
        span = MagicMock()
        span.name = name
        span.kind.name = "INTERNAL"
        span.context.trace_id = trace_id
        span.context.span_id = span_id
        span.attributes = attributes or {}
        span.status.is_ok = is_ok

        if parent_span_id:
            span.parent = MagicMock()
            span.parent.span_id = parent_span_id
        else:
            span.parent = None

        return span

    def test_map_task_span_success(self):
        span = self._create_span("my_task", is_ok=True)
        intermediate, final = map_span_to_event(span, self.resource)

        self.assertEqual(final["type"], EventType.TASK_COMPLETED)
        self.assertEqual(final["source"], "agent://my-agent")
        self.assertIn("span_name", final["payload"])

    def test_map_task_span_failure(self):
        span = self._create_span("my_task", is_ok=False)
        intermediate, final = map_span_to_event(span, self.resource)

        self.assertEqual(final["type"], EventType.TASK_FAILED)

    def test_map_tool_span(self):
        span = self._create_span("tool_search", is_ok=True)
        span.kind.name = "CLIENT"
        intermediate, final = map_span_to_event(span, self.resource)

        self.assertEqual(final["type"], EventType.TOOL_RESULT)
        self.assertEqual(final["source"], "agent://my-agent")

    def test_map_error_span(self):
        span = self._create_span("error_handler", is_ok=False)
        span.status.description = "Timeout"
        intermediate, final = map_span_to_event(span, self.resource)

        self.assertEqual(final["type"], EventType.ERROR_RAISED)
        self.assertEqual(final["payload"]["error_description"], "Timeout")

    def test_map_span_with_causation(self):
        parent_id = 0xDEADBEEF
        span = self._create_span("child_task", parent_span_id=parent_id)
        intermediate, final = map_span_to_event(span, self.resource)

        self.assertIsNotNone(final["causation_id"])
        self.assertEqual(final["causation_id"], "00000000deadbeef")

    def test_map_span_with_gen_ai_attrs(self):
        attrs = {
            "gen_ai.model": "gpt-4",
            "gen_ai.request.temperature": 0.7,
        }
        span = self._create_span("llm_call", attributes=attrs, is_ok=True)
        intermediate, final = map_span_to_event(span, self.resource)

        self.assertIn("gen_ai", final["payload"])
        self.assertEqual(final["payload"]["gen_ai"]["gen_ai.model"], "gpt-4")

    def test_error_priority_over_task(self):
        """Error status should take priority over task name."""
        span = self._create_span("task_with_error", is_ok=False)
        span.status.description = "Execution failed"
        intermediate, final = map_span_to_event(span, self.resource)

        # Should be ERROR_RAISED, not TASK_FAILED
        self.assertEqual(final["type"], EventType.ERROR_RAISED)
        self.assertEqual(final["payload"]["error_description"], "Execution failed")

    def test_malformed_parent_span_handled(self):
        """Span with parent but no span_id should not crash."""
        span = self._create_span("task")
        span.parent = MagicMock(spec=[])  # No span_id attribute
        intermediate, final = map_span_to_event(span, self.resource)

        # Should not crash and causation_id should be None
        self.assertIsNone(final.get("causation_id"))

    def test_span_without_kind_name(self):
        """Span with kind but no .name attribute should use INTERNAL."""
        span = self._create_span("tool_call")
        span.kind = MagicMock(spec=[])  # No name attribute
        intermediate, final = map_span_to_event(span, self.resource)

        # Should not crash
        self.assertIn("span_kind", final["payload"])
        self.assertEqual(final["payload"]["span_kind"], "INTERNAL")

    def test_span_with_null_name(self):
        """Span with None name should default to 'unknown'."""
        span = self._create_span()
        span.name = None
        intermediate, final = map_span_to_event(span, self.resource)

        self.assertEqual(final["payload"]["span_name"], "unknown")

    def test_source_prefix_customizable(self):
        """Source prefix should be configurable."""
        span = self._create_span("task")
        intermediate, final = map_span_to_event(
            span, self.resource, source_prefix="service://"
        )

        self.assertEqual(final["source"], "service://my-agent")

    def test_session_id_from_trace_context(self):
        """Session ID should be derived from trace_id, not span name."""
        span = self._create_span("task1", trace_id=0x11111111)
        span2 = self._create_span("task2", trace_id=0x11111111)

        _, final1 = map_span_to_event(span, self.resource)
        _, final2 = map_span_to_event(span2, self.resource)

        # Same trace_id should produce same session_id
        self.assertEqual(final1["session_id"], final2["session_id"])


if __name__ == "__main__":
    unittest.main()
