"""Unit tests for AsyncAEPClient using respx to mock httpx."""

import json
from pathlib import Path

import httpx
import pytest
import respx

from aep import create_event, verify_audit_bundle
from aep.async_client import AsyncAEPClient
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
        payload={"task": "test"},
    )
    base.update(overrides)
    return create_event(**base)


# ── emit ───────────────────────────────────────────────────────────────────────

@respx.mock
@pytest.mark.asyncio
async def test_emit_accepted():
    event = _event()
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(202, json={"accepted": True, "duplicate": False, "id": event["id"]})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        result = await client.emit(event)
    assert result["accepted"] is True
    assert result["duplicate"] is False


@respx.mock
@pytest.mark.asyncio
async def test_emit_duplicate():
    event = _event()
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(200, json={"accepted": True, "duplicate": True, "id": event["id"]})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        result = await client.emit(event)
    assert result["duplicate"] is True


@respx.mock
@pytest.mark.asyncio
async def test_emit_validation_error():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(400, json={"accepted": False, "errors": ["/ must have required property 'session_id'"]})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPValidationError) as exc_info:
            await client.emit({"type": "task.created"})
    assert len(exc_info.value.errors) > 0


@respx.mock
@pytest.mark.asyncio
async def test_emit_auth_error():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(401, json={"error": "API key required"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPAuthError):
            await client.emit(_event())


@respx.mock
@pytest.mark.asyncio
async def test_emit_rate_limit():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Rate limit exceeded", "limit": 300, "retryAfter": 42},
            headers={"Retry-After": "42"},
        )
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPRateLimitError) as exc_info:
            await client.emit(_event())
    assert exc_info.value.retry_after == 42


@respx.mock
@pytest.mark.asyncio
async def test_emit_rate_limit_http_date_header():
    """Retry-After as HTTP-date must not crash (RFC 7231 compliance)."""
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Rate limit exceeded"},
            headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"},
        )
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPRateLimitError) as exc_info:
            await client.emit(_event())
    assert exc_info.value.retry_after == 0  # falls back to 0 for unparseable dates


@respx.mock
@pytest.mark.asyncio
async def test_emit_rate_limit_negative_retry_after():
    """Negative Retry-After is technically invalid — must be clamped to 0."""
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Rate limit exceeded"},
            headers={"Retry-After": "-5"},
        )
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPRateLimitError) as exc_info:
            await client.emit(_event())
    assert exc_info.value.retry_after == 0  # clamped, not -5


# ── server errors & connection errors ─────────────────────────────────────────

@respx.mock
@pytest.mark.asyncio
async def test_emit_server_error_500():
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(500, json={"error": "Internal server error"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPServerError) as exc_info:
            await client.emit(_event())
    assert exc_info.value.status_code == 500
    assert "Internal server error" in str(exc_info.value)


@respx.mock
@pytest.mark.asyncio
async def test_emit_connection_error():
    """ConnectError → AEPConnectionError."""
    respx.post(f"{_BASE}/events").mock(side_effect=httpx.ConnectError("Connection refused"))
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPConnectionError, match="Cannot reach AEP server"):
            await client.emit(_event())


# ── emit_batch concurrent ─────────────────────────────────────────────────────

@respx.mock
@pytest.mark.asyncio
async def test_emit_batch_returns_all_results():
    events = [_event() for _ in range(3)]
    respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(202, json={"accepted": True, "duplicate": False, "id": "x"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        results = await client.emit_batch(events)
    assert len(results) == 3
    assert all(r["accepted"] for r in results)


@respx.mock
@pytest.mark.asyncio
async def test_emit_batch_uses_gather():
    """emit_batch should fire all requests; respx counts calls."""
    events = [_event() for _ in range(5)]
    route = respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(202, json={"accepted": True, "duplicate": False, "id": "x"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        await client.emit_batch(events)
    assert route.call_count == 5


@respx.mock
@pytest.mark.asyncio
async def test_emit_batch_raises_after_all_complete():
    """emit_batch waits for all requests before raising the first exception."""
    events = [_event() for _ in range(3)]
    call_count = 0

    async def side_effect(req: httpx.Request):
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            return httpx.Response(401, json={"error": "Unauthorized"})
        return httpx.Response(202, json={"accepted": True, "duplicate": False, "id": "x"})

    respx.post(f"{_BASE}/events").mock(side_effect=side_effect)
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPAuthError):
            await client.emit_batch(events)
    # All 3 requests were dispatched even though one failed
    assert call_count == 3


# ── sessions ──────────────────────────────────────────────────────────────────

@respx.mock
@pytest.mark.asyncio
async def test_get_sessions():
    respx.get(f"{_BASE}/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [], "next_cursor": None})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        result = await client.get_sessions()
    assert "sessions" in result


@respx.mock
@pytest.mark.asyncio
async def test_get_session_tree_not_found():
    respx.get(f"{_BASE}/sessions/ses_missing/tree").mock(
        return_value=httpx.Response(404, json={"error": "Session not found"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPNotFoundError):
            await client.get_session_tree("ses_missing")


# ── workflow ───────────────────────────────────────────────────────────────────

@respx.mock
@pytest.mark.asyncio
async def test_get_workflow():
    respx.get(f"{_BASE}/workflows/trc_001").mock(
        return_value=httpx.Response(200, json={"trace_id": "trc_001", "session_count": 2, "tree": []})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        result = await client.get_workflow("trc_001")
    assert result["trace_id"] == "trc_001"


# ── audit bundles ─────────────────────────────────────────────────────────────

@respx.mock
@pytest.mark.asyncio
async def test_get_audit_bundle_round_trips_with_verify():
    """Fetch → verify_audit_bundle round-trip against the shared KAT fixture."""
    bundle = _load_kat_bundle()
    respx.get(f"{_BASE}/sessions/ses_kat/audit-bundle").mock(
        return_value=httpx.Response(200, json=bundle)
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        fetched = await client.get_audit_bundle("ses_kat")

    result = verify_audit_bundle(fetched, _KAT_SECRET)
    assert result["valid"] is True
    assert result["content_digest_match"] is True
    assert result["manifest_signature_valid"] is True


@respx.mock
@pytest.mark.asyncio
async def test_get_audit_bundle_not_found():
    respx.get(f"{_BASE}/sessions/ses_missing/audit-bundle").mock(
        return_value=httpx.Response(404, json={"error": "Session not found"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPNotFoundError):
            await client.get_audit_bundle("ses_missing")


@respx.mock
@pytest.mark.asyncio
async def test_get_audit_bundle_signing_not_configured():
    respx.get(f"{_BASE}/sessions/ses_001/audit-bundle").mock(
        return_value=httpx.Response(503, json={"error": "Audit export not configured"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPServerError) as exc_info:
            await client.get_audit_bundle("ses_001")
    assert exc_info.value.status_code == 503


@respx.mock
@pytest.mark.asyncio
async def test_get_workflow_audit_bundle_round_trips_with_verify():
    bundle = _load_kat_bundle()
    respx.get(f"{_BASE}/workflows/trc_kat/audit-bundle").mock(
        return_value=httpx.Response(200, json=bundle)
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        fetched = await client.get_workflow_audit_bundle("trc_kat")

    result = verify_audit_bundle(fetched, _KAT_SECRET)
    assert result["valid"] is True


@respx.mock
@pytest.mark.asyncio
async def test_get_workflow_audit_bundle_not_found():
    respx.get(f"{_BASE}/workflows/trc_missing/audit-bundle").mock(
        return_value=httpx.Response(404, json={"error": "Workflow not found"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPNotFoundError):
            await client.get_workflow_audit_bundle("trc_missing")


@respx.mock
@pytest.mark.asyncio
async def test_get_workflow_audit_bundle_signing_not_configured():
    respx.get(f"{_BASE}/workflows/trc_001/audit-bundle").mock(
        return_value=httpx.Response(503, json={"error": "Audit export not configured"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        with pytest.raises(AEPServerError) as exc_info:
            await client.get_workflow_audit_bundle("trc_001")
    assert exc_info.value.status_code == 503


# ── health & metrics ──────────────────────────────────────────────────────────

@respx.mock
@pytest.mark.asyncio
async def test_health():
    respx.get(f"{_BASE}/health").mock(
        return_value=httpx.Response(200, json={"ok": True, "service": "aep-ingest"})
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        result = await client.health()
    assert result["ok"] is True


@respx.mock
@pytest.mark.asyncio
async def test_hmac_signing_applied():
    """When hmac_secret is set, emit() must attach a signature before sending."""
    event = _event()
    captured = {}

    async def capture(req: httpx.Request):
        captured["body"] = json.loads(req.content)
        return httpx.Response(202, json={"accepted": True, "duplicate": False, "id": "x"})

    respx.post(f"{_BASE}/events").mock(side_effect=capture)
    async with AsyncAEPClient(server_url=_BASE, hmac_secret="s3cr3t") as client:
        await client.emit(event)

    assert "signature" in captured["body"]
    assert captured["body"]["signature"]["alg"] == "hmac-sha256"
    # Issue #59 default flip: the auto-signing client now emits v2 (deep,
    # payload-covering) signatures by default.
    assert captured["body"]["signature"]["canon"] == "v2"
