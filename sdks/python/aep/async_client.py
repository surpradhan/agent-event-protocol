from __future__ import annotations

import asyncio
import os
import warnings
from typing import Any

import httpx

from ._constants import DEFAULT_SERVER_URL
from ._http import (
    RetryConfig,
    compute_retry_delay,
    handle_response,
    is_retryable_exception,
    is_retryable_status,
    parse_retry_after,
)
from ._signature import sign_event
from .exceptions import AEPConnectionError


class AsyncAEPClient:
    """Asynchronous AEP client backed by ``httpx``.

    Usage::

        async with AsyncAEPClient(api_key="aep_...") as client:
            result = await client.emit(event)

    Transient failures — connection/timeout errors, HTTP 429 (honouring
    ``Retry-After``) and HTTP 5xx — are retried up to ``max_retries`` times
    with full-jitter exponential backoff. Retrying ``POST /events`` is safe:
    events carry a client-generated ``id`` and the server deduplicates on it.
    Set ``max_retries=0`` to disable retries.
    """

    def __init__(
        self,
        server_url: str | None = None,
        api_key: str | None = None,
        hmac_secret: str | None = None,
        timeout: float = 10.0,
        max_retries: int = 3,
        retry_backoff_base: float = 0.5,
        retry_backoff_max: float = 30.0,
    ) -> None:
        self._server_url = (
            server_url or os.environ.get("AEP_INGEST_URL") or DEFAULT_SERVER_URL
        ).rstrip("/")
        self._api_key = api_key or os.environ.get("AEP_API_KEY")
        self._hmac_secret = hmac_secret
        self._retry = RetryConfig(
            max_retries=max(0, max_retries),
            backoff_base=retry_backoff_base,
            backoff_max=retry_backoff_max,
        )
        self._http = httpx.AsyncClient(timeout=timeout)

    # ── context manager ───────────────────────────────────────────────────────

    async def __aenter__(self) -> AsyncAEPClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    def __repr__(self) -> str:
        if self._api_key:
            # Reveal at most 4 chars and never more than half the key length so
            # short keys aren't accidentally exposed in debug output.
            visible = min(4, len(self._api_key) // 2)
            key_hint = f"{self._api_key[:visible]}***"
        else:
            key_hint = None
        return (
            f"AsyncAEPClient(server_url={self._server_url!r}, "
            f"api_key={key_hint!r}, "
            f"hmac_secret={'<set>' if self._hmac_secret else None})"
        )

    def __del__(self) -> None:
        if not self._http.is_closed:
            warnings.warn(
                "AsyncAEPClient was garbage-collected without being closed. "
                "Use 'async with AsyncAEPClient() as client:' or call await client.aclose().",
                ResourceWarning,
                stacklevel=2,
            )

    # ── emit ──────────────────────────────────────────────────────────────────

    async def emit(self, event: dict[str, Any]) -> dict[str, Any]:
        """POST a single event to ``/events``. Auto-signs when ``hmac_secret`` is set."""
        if self._hmac_secret:
            event = sign_event(dict(event), self._hmac_secret)
        return await self._post("/events", event)

    async def emit_batch(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Emit multiple events concurrently via asyncio.gather.

        All events are dispatched concurrently and all results are awaited
        before returning. If any emit raises, the first exception is re-raised
        after all requests have completed — no in-flight requests are silently
        dropped. Raises the same exceptions as :meth:`emit`.
        """
        raw = await asyncio.gather(*[self.emit(e) for e in events], return_exceptions=True)
        first_exc: BaseException | None = None
        results: list[dict[str, Any]] = []
        for r in raw:
            if isinstance(r, BaseException):
                if first_exc is None:
                    first_exc = r
            else:
                results.append(r)
        if first_exc is not None:
            raise first_exc
        return results

    # ── sessions ──────────────────────────────────────────────────────────────

    async def get_sessions(
        self,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        return await self._get("/sessions", params=params)

    async def get_session_events(
        self,
        session_id: str,
        *,
        type: str | None = None,
        q: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if type:
            params["type"] = type
        if q:
            params["q"] = q
        if cursor:
            params["cursor"] = cursor
        return await self._get(f"/sessions/{session_id}/events", params=params)

    async def get_session_tree(self, session_id: str) -> dict[str, Any]:
        return await self._get(f"/sessions/{session_id}/tree")

    async def get_session_export(
        self,
        session_id: str,
        *,
        format: str = "json",
    ) -> dict[str, Any]:
        return await self._get(f"/sessions/{session_id}/export", params={"format": format})

    # ── workflows ─────────────────────────────────────────────────────────────

    async def get_workflow(self, trace_id: str) -> dict[str, Any]:
        return await self._get(f"/workflows/{trace_id}")

    # ── metrics & health ──────────────────────────────────────────────────────

    async def get_metrics(self) -> dict[str, Any]:
        return await self._get("/metrics")

    async def health(self) -> dict[str, Any]:
        return await self._get("/health")

    async def ready(self) -> dict[str, Any]:
        return await self._get("/ready")

    # ── internals ─────────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json"}
        if self._api_key:
            h["Authorization"] = f"Bearer {self._api_key}"
        return h

    async def _get(self, path: str, *, params: dict | None = None) -> dict[str, Any]:
        return await self._request("GET", path, params=params)

    async def _post(self, path: str, body: dict) -> dict[str, Any]:
        return await self._request("POST", path, json_body=body)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json_body: dict | None = None,
    ) -> dict[str, Any]:
        url = self._server_url + path
        for attempt in range(self._retry.max_retries + 1):
            try:
                resp = await self._http.request(
                    method, url, headers=self._headers(), params=params, json=json_body
                )
            except httpx.TransportError as exc:
                # Transient transport failures (timeouts, network errors,
                # server hang-ups) are retried; deterministic local errors
                # raise immediately.
                if is_retryable_exception(exc) and attempt < self._retry.max_retries:
                    await asyncio.sleep(compute_retry_delay(attempt, self._retry))
                    continue
                raise AEPConnectionError(
                    f"Cannot reach AEP server at {self._server_url}: {exc}"
                ) from exc
            if is_retryable_status(resp.status_code) and attempt < self._retry.max_retries:
                # RFC 7231 allows Retry-After on any response (typically 429/503).
                retry_after = parse_retry_after(resp.headers.get("Retry-After", "0"))
                await asyncio.sleep(
                    compute_retry_delay(attempt, self._retry, retry_after=retry_after)
                )
                continue
            return handle_response(resp)
        raise AssertionError("unreachable")  # loop always returns or raises
