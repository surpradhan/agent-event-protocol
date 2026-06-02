"""Shared HTTP response helpers for AEPClient and AsyncAEPClient."""
from __future__ import annotations

from typing import Any

import httpx

from .exceptions import (
    AEPAuthError,
    AEPNotFoundError,
    AEPRateLimitError,
    AEPServerError,
    AEPValidationError,
)


def handle_response(resp: httpx.Response) -> dict[str, Any]:
    """Map an httpx response to a parsed dict or raise the appropriate AEP exception."""
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
        retry_after = parse_retry_after(resp.headers.get("Retry-After", "0"))
        raise AEPRateLimitError(body.get("error", "Rate limit exceeded"), retry_after=retry_after)
    if resp.status_code >= 500:
        body = _safe_json(resp)
        raise AEPServerError(
            body.get("error", f"Server error {resp.status_code}"),
            status_code=resp.status_code,
        )
    resp.raise_for_status()
    return resp.json()


def parse_retry_after(value: str) -> int:
    """Parse a Retry-After header value — RFC 7231 allows integer seconds and HTTP-date.

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
