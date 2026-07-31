"""Unit tests for AEPClient (sync) using respx to mock httpx."""

import json
from pathlib import Path

import httpx
import pytest
import respx

from aep import create_event, verify_audit_bundle
from aep.client import AEPClient
from aep.exceptions import (
    AEPAuthError,
    AEPConnectionError,
    AEPNotFoundError,
    AEPRateLimitError,
    AEPServerError,
    AEPValidationError,
)

_BASE = "http://test-server:8787"

# Shared KAT bundle (src/audit.js buildAuditBundle) — see tests/unit/test_audit.py.
_KAT_SECRET = "shared-secret-123"
_KAT_FIXTURE = (
    Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "audit" / "kat-bundle.json"
)


def _load_kat_bundle():
    with _KAT_FIXTURE.open(encoding="utf-8") as fh:
        return json.load(fh)


def _event(**overrides):
    base = dict(
        source="agent://test",
        type="task.created",
        session_id="ses_001",
        trace_id="trc_001",
        payload={},
    )
    base.update(overrides)
    return create_event(**base)


# ── emit ───────────────────────────────────────────────────────────────────────

@respx.mock
def test_emit_accepted():
    event = _event()
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(202, json={"accepted": True, "duplicate": False, "id": event["id"]})
    )
    with AEPClient(server_url=_BASE) as client:
        result = client.emit(event)
    assert result["accepted"] is True
    assert result["duplicate"] is False


@respx.mock
def test_emit_validation_error():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(400, json={"accepted": False, "errors": ["/ must have required property 'id'"]})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPValidationError) as exc_info:
            client.emit({})
    assert exc_info.value.errors == ["/ must have required property 'id'"]


@respx.mock
def test_emit_401():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(401, json={"error": "API key required"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPAuthError, match="API key required"):
            client.emit(_event())


@respx.mock
def test_emit_403():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(403, json={"error": "Insufficient scope"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPAuthError, match="Insufficient scope"):
            client.emit(_event())


@respx.mock
def test_emit_rate_limit_integer_retry_after():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Rate limit exceeded"},
            headers={"Retry-After": "60"},
        )
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPRateLimitError) as exc_info:
            client.emit(_event())
    assert exc_info.value.retry_after == 60


@respx.mock
def test_emit_rate_limit_http_date_retry_after():
    """RFC 7231 allows Retry-After as an HTTP-date — must not raise ValueError."""
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Rate limit exceeded"},
            headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"},
        )
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPRateLimitError) as exc_info:
            client.emit(_event())
    assert exc_info.value.retry_after == 0  # graceful fallback


@respx.mock
def test_emit_rate_limit_negative_retry_after():
    """Negative Retry-After is technically invalid — must be clamped to 0."""
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Rate limit exceeded"},
            headers={"Retry-After": "-5"},
        )
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPRateLimitError) as exc_info:
            client.emit(_event())
    assert exc_info.value.retry_after == 0  # clamped, not -5


# ── read endpoints ─────────────────────────────────────────────────────────────

@respx.mock
def test_get_sessions():
    respx.get(f"{_BASE}/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [], "next_cursor": None})
    )
    with AEPClient(server_url=_BASE) as client:
        result = client.get_sessions()
    assert "sessions" in result


@respx.mock
def test_get_session_tree_not_found():
    respx.get(f"{_BASE}/sessions/ses_xyz/tree").mock(
        return_value=httpx.Response(404, json={"error": "Session not found"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPNotFoundError):
            client.get_session_tree("ses_xyz")


@respx.mock
def test_get_workflow():
    respx.get(f"{_BASE}/workflows/trc_001").mock(
        return_value=httpx.Response(200, json={"trace_id": "trc_001", "session_count": 1, "tree": []})
    )
    with AEPClient(server_url=_BASE) as client:
        result = client.get_workflow("trc_001")
    assert result["trace_id"] == "trc_001"


@respx.mock
def test_get_audit_bundle_round_trips_with_verify():
    """Fetch → verify_audit_bundle round-trip against the shared KAT fixture."""
    bundle = _load_kat_bundle()
    respx.get(f"{_BASE}/sessions/ses_kat/audit-bundle").mock(
        return_value=httpx.Response(200, json=bundle)
    )
    with AEPClient(server_url=_BASE) as client:
        fetched = client.get_audit_bundle("ses_kat")

    result = verify_audit_bundle(fetched, _KAT_SECRET)
    assert result["valid"] is True
    assert result["content_digest_match"] is True
    assert result["manifest_signature_valid"] is True


@respx.mock
def test_get_audit_bundle_not_found():
    respx.get(f"{_BASE}/sessions/ses_missing/audit-bundle").mock(
        return_value=httpx.Response(404, json={"error": "Session not found"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPNotFoundError):
            client.get_audit_bundle("ses_missing")


@respx.mock
def test_get_audit_bundle_signing_not_configured():
    respx.get(f"{_BASE}/sessions/ses_001/audit-bundle").mock(
        return_value=httpx.Response(503, json={"error": "Audit export not configured"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPServerError) as exc_info:
            client.get_audit_bundle("ses_001")
    assert exc_info.value.status_code == 503
    assert "Audit export not configured" in str(exc_info.value)


@respx.mock
def test_get_workflow_audit_bundle_round_trips_with_verify():
    bundle = _load_kat_bundle()
    respx.get(f"{_BASE}/workflows/trc_kat/audit-bundle").mock(
        return_value=httpx.Response(200, json=bundle)
    )
    with AEPClient(server_url=_BASE) as client:
        fetched = client.get_workflow_audit_bundle("trc_kat")

    result = verify_audit_bundle(fetched, _KAT_SECRET)
    assert result["valid"] is True


@respx.mock
def test_get_workflow_audit_bundle_not_found():
    respx.get(f"{_BASE}/workflows/trc_missing/audit-bundle").mock(
        return_value=httpx.Response(404, json={"error": "Workflow not found"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPNotFoundError):
            client.get_workflow_audit_bundle("trc_missing")


@respx.mock
def test_get_workflow_audit_bundle_signing_not_configured():
    respx.get(f"{_BASE}/workflows/trc_001/audit-bundle").mock(
        return_value=httpx.Response(503, json={"error": "Audit export not configured"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPServerError) as exc_info:
            client.get_workflow_audit_bundle("trc_001")
    assert exc_info.value.status_code == 503
    assert "Audit export not configured" in str(exc_info.value)


@respx.mock
def test_health():
    respx.get(f"{_BASE}/health").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    with AEPClient(server_url=_BASE) as client:
        result = client.health()
    assert result["ok"] is True


# ── server errors & connection errors ─────────────────────────────────────────

@respx.mock
def test_emit_server_error_500():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(500, json={"error": "Internal server error"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPServerError) as exc_info:
            client.emit(_event())
    assert exc_info.value.status_code == 500
    assert "Internal server error" in str(exc_info.value)


@respx.mock
def test_emit_server_error_503():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(503, json={"error": "Service unavailable"})
    )
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPServerError) as exc_info:
            client.emit(_event())
    assert exc_info.value.status_code == 503


@respx.mock
def test_emit_connection_error():
    """ConnectError → AEPConnectionError."""
    respx.post(f"{_BASE}/events").mock(side_effect=httpx.ConnectError("Connection refused"))
    with AEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPConnectionError, match="Cannot reach AEP server"):
            client.emit(_event())


# ── api key in header ──────────────────────────────────────────────────────────

@respx.mock
def test_api_key_sent_as_bearer():
    event = _event()
    captured = {}

    def capture(req: httpx.Request):
        captured["auth"] = req.headers.get("Authorization")
        return httpx.Response(202, json={"accepted": True, "duplicate": False, "id": "x"})

    respx.post(f"{_BASE}/events").mock(side_effect=capture)
    with AEPClient(server_url=_BASE, api_key="aep_testkey") as client:
        client.emit(event)

    assert captured["auth"] == "Bearer aep_testkey"


@respx.mock
def test_repr_masks_api_key():
    """__repr__ must never expose the full api_key, including for short keys."""
    with AEPClient(server_url="http://x.com", api_key="aep_supersecret") as c:
        r = repr(c)
        assert "aep_supersecret" not in r
        assert "***" in r
        # Reveals at most 4 chars (the safe aep_ prefix)
        assert r.count("aep_") <= 1  # prefix only, not the full key

    # Short key: old [:7] would expose "aep_x" entirely; new code must not
    with AEPClient(server_url="http://x.com", api_key="aep_x") as c:
        r = repr(c)
        assert "aep_x" not in r  # full value must not appear
        assert "***" in r

    # Single-char key: visible=0, so only *** is shown
    with AEPClient(server_url="http://x.com", api_key="s") as c:
        r = repr(c)
        assert "s" not in r.split("api_key=")[1].split(",")[0]  # not in the key_hint part


@respx.mock
def test_no_auth_header_without_key():
    event = _event()
    captured = {}

    def capture(req: httpx.Request):
        captured["auth"] = req.headers.get("Authorization")
        return httpx.Response(202, json={"accepted": True, "duplicate": False, "id": "x"})

    respx.post(f"{_BASE}/events").mock(side_effect=capture)
    with AEPClient(server_url=_BASE, api_key=None) as client:
        client.emit(event)

    assert captured["auth"] is None
