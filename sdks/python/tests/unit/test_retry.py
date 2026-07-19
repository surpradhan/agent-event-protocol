"""Unit tests for transient-failure retry/backoff in AEPClient and AsyncAEPClient."""

import httpx
import respx

import aep.async_client as async_client_mod
import aep.client as client_mod
from aep import create_event
from aep._http import RetryConfig, compute_retry_delay, is_retryable_status
from aep.async_client import AsyncAEPClient
from aep.client import AEPClient
from aep.exceptions import (
    AEPConnectionError,
    AEPRateLimitError,
    AEPServerError,
    AEPValidationError,
)

_BASE = "http://test-server:8787"


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


def _accepted(event):
    return httpx.Response(
        202, json={"accepted": True, "duplicate": False, "id": event["id"]}
    )


def _patch_sync_sleep(monkeypatch):
    sleeps = []
    monkeypatch.setattr(client_mod.time, "sleep", sleeps.append)
    return sleeps


def _patch_async_sleep(monkeypatch):
    sleeps = []

    async def _sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(async_client_mod.asyncio, "sleep", _sleep)
    return sleeps


# ── pure helpers ───────────────────────────────────────────────────────────────


def test_is_retryable_status():
    assert is_retryable_status(429)
    for code in (500, 502, 503, 504, 599):
        assert is_retryable_status(code)
    for code in (200, 202, 400, 401, 403, 404, 422):
        assert not is_retryable_status(code)


def test_compute_retry_delay_exponential_ceiling():
    cfg = RetryConfig(backoff_base=0.5, backoff_max=30.0)
    # rand()=1.0 → delay equals the ceiling: base * 2**attempt
    assert compute_retry_delay(0, cfg, rand=lambda: 1.0) == 0.5
    assert compute_retry_delay(1, cfg, rand=lambda: 1.0) == 1.0
    assert compute_retry_delay(3, cfg, rand=lambda: 1.0) == 4.0


def test_compute_retry_delay_caps_at_backoff_max():
    cfg = RetryConfig(backoff_base=0.5, backoff_max=2.0)
    assert compute_retry_delay(10, cfg, rand=lambda: 1.0) == 2.0


def test_compute_retry_delay_honours_retry_after_floor():
    cfg = RetryConfig(backoff_base=0.5, backoff_max=30.0)
    # Jitter would give 0, but Retry-After raises the floor.
    assert compute_retry_delay(0, cfg, retry_after=7, rand=lambda: 0.0) == 7.0
    # Retry-After above the cap is clamped to backoff_max.
    assert compute_retry_delay(0, cfg, retry_after=120, rand=lambda: 0.0) == 30.0


# ── sync client ────────────────────────────────────────────────────────────────


@respx.mock
def test_emit_retries_5xx_then_succeeds(monkeypatch):
    sleeps = _patch_sync_sleep(monkeypatch)
    event = _event()
    route = respx.post(f"{_BASE}/events").mock(
        side_effect=[httpx.Response(503), httpx.Response(503), _accepted(event)]
    )
    with AEPClient(server_url=_BASE) as client:
        result = client.emit(event)
    assert result["accepted"] is True
    assert route.call_count == 3
    assert len(sleeps) == 2


@respx.mock
def test_retry_exhaustion_raises_server_error(monkeypatch):
    sleeps = _patch_sync_sleep(monkeypatch)
    route = respx.post(f"{_BASE}/events").mock(return_value=httpx.Response(503))
    try:
        with AEPClient(server_url=_BASE, max_retries=3) as client:
            client.emit(_event())
        raise AssertionError("expected AEPServerError")
    except AEPServerError:
        pass
    assert route.call_count == 4  # initial + 3 retries
    assert len(sleeps) == 3


@respx.mock
def test_no_retry_on_validation_error(monkeypatch):
    sleeps = _patch_sync_sleep(monkeypatch)
    route = respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(400, json={"errors": ["bad"]})
    )
    try:
        with AEPClient(server_url=_BASE) as client:
            client.emit(_event())
        raise AssertionError("expected AEPValidationError")
    except AEPValidationError:
        pass
    assert route.call_count == 1
    assert sleeps == []


@respx.mock
def test_429_honours_retry_after(monkeypatch):
    sleeps = _patch_sync_sleep(monkeypatch)
    event = _event()
    respx.post(f"{_BASE}/events").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "7"}, json={"error": "slow down"}),
            _accepted(event),
        ]
    )
    with AEPClient(server_url=_BASE) as client:
        result = client.emit(event)
    assert result["accepted"] is True
    assert len(sleeps) == 1
    assert sleeps[0] >= 7.0


@respx.mock
def test_503_honours_retry_after(monkeypatch):
    sleeps = _patch_sync_sleep(monkeypatch)
    event = _event()
    respx.post(f"{_BASE}/events").mock(
        side_effect=[
            httpx.Response(503, headers={"Retry-After": "5"}, json={"error": "maintenance"}),
            _accepted(event),
        ]
    )
    with AEPClient(server_url=_BASE) as client:
        result = client.emit(event)
    assert result["accepted"] is True
    assert len(sleeps) == 1
    assert sleeps[0] >= 5.0


@respx.mock
def test_deterministic_local_error_fails_fast(monkeypatch):
    sleeps = _patch_sync_sleep(monkeypatch)
    route = respx.post(f"{_BASE}/events").mock(
        side_effect=httpx.UnsupportedProtocol("bad scheme")
    )
    try:
        with AEPClient(server_url=_BASE, max_retries=3) as client:
            client.emit(_event())
        raise AssertionError("expected AEPConnectionError")
    except AEPConnectionError:
        pass
    assert route.call_count == 1  # no retries burned on a deterministic failure
    assert sleeps == []


@respx.mock
def test_429_exhaustion_still_raises_rate_limit(monkeypatch):
    _patch_sync_sleep(monkeypatch)
    route = respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "1"}, json={"error": "nope"})
    )
    try:
        with AEPClient(server_url=_BASE, max_retries=1) as client:
            client.emit(_event())
        raise AssertionError("expected AEPRateLimitError")
    except AEPRateLimitError as exc:
        assert exc.retry_after == 1
    assert route.call_count == 2


@respx.mock
def test_connect_error_retried_then_wrapped(monkeypatch):
    sleeps = _patch_sync_sleep(monkeypatch)
    route = respx.post(f"{_BASE}/events").mock(side_effect=httpx.ConnectError("boom"))
    try:
        with AEPClient(server_url=_BASE, max_retries=2) as client:
            client.emit(_event())
        raise AssertionError("expected AEPConnectionError")
    except AEPConnectionError:
        pass
    assert route.call_count == 3
    assert len(sleeps) == 2


@respx.mock
def test_timeout_now_wrapped_as_connection_error(monkeypatch):
    _patch_sync_sleep(monkeypatch)
    respx.post(f"{_BASE}/events").mock(side_effect=httpx.ReadTimeout("slow"))
    try:
        with AEPClient(server_url=_BASE, max_retries=0) as client:
            client.emit(_event())
        raise AssertionError("expected AEPConnectionError")
    except AEPConnectionError:
        pass


@respx.mock
def test_max_retries_zero_disables_retries(monkeypatch):
    sleeps = _patch_sync_sleep(monkeypatch)
    route = respx.post(f"{_BASE}/events").mock(return_value=httpx.Response(503))
    try:
        with AEPClient(server_url=_BASE, max_retries=0) as client:
            client.emit(_event())
        raise AssertionError("expected AEPServerError")
    except AEPServerError:
        pass
    assert route.call_count == 1
    assert sleeps == []


@respx.mock
def test_get_requests_also_retry(monkeypatch):
    _patch_sync_sleep(monkeypatch)
    route = respx.get(f"{_BASE}/sessions").mock(
        side_effect=[httpx.Response(502), httpx.Response(200, json={"sessions": []})]
    )
    with AEPClient(server_url=_BASE) as client:
        result = client.get_sessions()
    assert result == {"sessions": []}
    assert route.call_count == 2


# ── async client ───────────────────────────────────────────────────────────────


@respx.mock
async def test_async_emit_retries_5xx_then_succeeds(monkeypatch):
    sleeps = _patch_async_sleep(monkeypatch)
    event = _event()
    route = respx.post(f"{_BASE}/events").mock(
        side_effect=[httpx.Response(503), _accepted(event)]
    )
    async with AsyncAEPClient(server_url=_BASE) as client:
        result = await client.emit(event)
    assert result["accepted"] is True
    assert route.call_count == 2
    assert len(sleeps) == 1


@respx.mock
async def test_async_no_retry_on_validation_error(monkeypatch):
    sleeps = _patch_async_sleep(monkeypatch)
    route = respx.post(f"{_BASE}/events").mock(
        return_value=httpx.Response(400, json={"errors": ["bad"]})
    )
    try:
        async with AsyncAEPClient(server_url=_BASE) as client:
            await client.emit(_event())
        raise AssertionError("expected AEPValidationError")
    except AEPValidationError:
        pass
    assert route.call_count == 1
    assert sleeps == []


@respx.mock
async def test_async_connect_error_retried_then_wrapped(monkeypatch):
    sleeps = _patch_async_sleep(monkeypatch)
    route = respx.post(f"{_BASE}/events").mock(side_effect=httpx.ConnectError("boom"))
    try:
        async with AsyncAEPClient(server_url=_BASE, max_retries=2) as client:
            await client.emit(_event())
        raise AssertionError("expected AEPConnectionError")
    except AEPConnectionError:
        pass
    assert route.call_count == 3
    assert len(sleeps) == 2
