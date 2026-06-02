from __future__ import annotations

import os
import warnings
from typing import Any

import httpx

from ._signature import sign_event
from .exceptions import (
    AEPAuthError,
    AEPConnectionError,
    AEPNotFoundError,
    AEPRateLimitError,
    AEPValidationError,
)

_DEFAULT_SERVER_URL = "http://localhost:8787"


class AEPClient:
    """Synchronous AEP client backed by ``httpx``.

    Usage::

        with AEPClient(api_key="aep_...") as client:
            result = client.emit(event)
    """

    def __init__(
        self,
        server_url: str | None = None,
        api_key: str | None = None,
        hmac_secret: str | None = None,
        timeout: float = 10.0,
    ) -> None:
        self._server_url = (
            server_url or os.environ.get("AEP_INGEST_URL") or _DEFAULT_SERVER_URL
        ).rstrip("/")
        self._api_key = api_key or os.environ.get("AEP_API_KEY")
        self._hmac_secret = hmac_secret
        self._http = httpx.Client(timeout=timeout)

    # ── context manager ───────────────────────────────────────────────────────

    def __enter__(self) -> AEPClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def __del__(self) -> None:
        if not self._http.is_closed:
            warnings.warn(
                "AEPClient was garbage-collected without being closed. "
                "Use 'with AEPClient() as client:' or call client.close() explicitly.",
                ResourceWarning,
                stacklevel=2,
            )
            try:
                self._http.close()
            except Exception:
                pass

    # ── emit ──────────────────────────────────────────────────────────────────

    def emit(self, event: dict[str, Any]) -> dict[str, Any]:
        """POST a single event to ``/events``.

        Auto-signs the event when ``hmac_secret`` is configured.
        Returns the parsed response body (``{"accepted": True, "duplicate": False, ...}``).
        Raises :exc:`AEPValidationError` on HTTP 400.
        """
        if self._hmac_secret:
            event = sign_event(dict(event), self._hmac_secret)
        return self._post("/events", event)

    def emit_batch(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Emit multiple events sequentially. Returns a list of response bodies."""
        return [self.emit(e) for e in events]

    # ── sessions ──────────────────────────────────────────────────────────────

    def get_sessions(
        self,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        return self._get("/sessions", params=params)

    def get_session_events(
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
        return self._get(f"/sessions/{session_id}/events", params=params)

    def get_session_tree(self, session_id: str) -> dict[str, Any]:
        return self._get(f"/sessions/{session_id}/tree")

    def get_session_export(
        self,
        session_id: str,
        *,
        format: str = "json",
    ) -> dict[str, Any]:
        return self._get(f"/sessions/{session_id}/export", params={"format": format})

    # ── workflows ─────────────────────────────────────────────────────────────

    def get_workflow(self, trace_id: str) -> dict[str, Any]:
        return self._get(f"/workflows/{trace_id}")

    # ── metrics & health ──────────────────────────────────────────────────────

    def get_metrics(self) -> dict[str, Any]:
        return self._get("/metrics")

    def health(self) -> dict[str, Any]:
        return self._get("/health")

    def ready(self) -> dict[str, Any]:
        return self._get("/ready")

    # ── internals ─────────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json"}
        if self._api_key:
            h["Authorization"] = f"Bearer {self._api_key}"
        return h

    def _get(self, path: str, *, params: dict | None = None) -> dict[str, Any]:
        url = self._server_url + path
        try:
            resp = self._http.get(url, headers=self._headers(), params=params)
        except httpx.ConnectError as exc:
            raise AEPConnectionError(f"Cannot reach AEP server at {self._server_url}: {exc}") from exc
        return _handle_response(resp)

    def _post(self, path: str, body: dict) -> dict[str, Any]:
        url = self._server_url + path
        try:
            resp = self._http.post(url, headers=self._headers(), json=body)
        except httpx.ConnectError as exc:
            raise AEPConnectionError(f"Cannot reach AEP server at {self._server_url}: {exc}") from exc
        return _handle_response(resp)


def _handle_response(resp: httpx.Response) -> dict[str, Any]:
    if resp.status_code in (200, 201, 202):
        return resp.json()
    if resp.status_code == 400:
        body = _safe_json(resp)
        raise AEPValidationError(
            f"Validation error: {body.get('errors', body)}",
            errors=body.get("errors", []),
        )
    if resp.status_code in (401, 403):
        body = _safe_json(resp)
        raise AEPAuthError(body.get("error", "Authentication failed"))
    if resp.status_code == 404:
        body = _safe_json(resp)
        raise AEPNotFoundError(body.get("error", "Not found"))
    if resp.status_code == 429:
        body = _safe_json(resp)
        retry_after = _parse_retry_after(resp.headers.get("Retry-After", "0"))
        raise AEPRateLimitError(body.get("error", "Rate limit exceeded"), retry_after=retry_after)
    resp.raise_for_status()
    return resp.json()


def _parse_retry_after(value: str) -> int:
    """Parse Retry-After header value — RFC 7231 allows both integer seconds and HTTP-date.

    Negative values are clamped to 0; HTTP-date strings fall back to 0.
    """
    try:
        return max(0, int(value))
    except ValueError:
        return 0


def _safe_json(resp: httpx.Response) -> dict:
    try:
        return resp.json()
    except Exception:
        return {}
