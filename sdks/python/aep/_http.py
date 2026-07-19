"""Shared HTTP response helpers for AEPClient and AsyncAEPClient."""
from __future__ import annotations

import random
from dataclasses import dataclass
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


# ── retry support ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RetryConfig:
    """Retry policy for transient failures.

    ``max_retries`` counts retry attempts *after* the initial request
    (``max_retries=3`` → up to 4 requests total). ``0`` disables retries.
    """

    max_retries: int = 3
    backoff_base: float = 0.5
    backoff_max: float = 30.0


def is_retryable_status(status_code: int) -> bool:
    """429 and every 5xx are transient; all other statuses are final."""
    return status_code == 429 or status_code >= 500


def is_retryable_exception(exc: httpx.TransportError) -> bool:
    """Only genuinely transient transport failures are worth retrying.

    Timeouts, network errors, and a server hanging up mid-response
    (``RemoteProtocolError``) can succeed on a second attempt. Deterministic
    local failures (``UnsupportedProtocol``, ``LocalProtocolError``, proxy
    misconfiguration) will fail identically every time — raise immediately.
    """
    return isinstance(
        exc,
        (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError),
    )


def compute_retry_delay(
    attempt: int,
    config: RetryConfig,
    *,
    retry_after: float = 0.0,
    rand: Any = random.random,
) -> float:
    """Full-jitter exponential backoff, floored by a server-provided Retry-After.

    ``attempt`` is 0-based (0 = delay before the first retry). The jittered
    delay is ``rand() * min(backoff_max, backoff_base * 2**attempt)``; a
    ``Retry-After`` value raises the floor, and ``backoff_max`` caps the result.
    """
    ceiling = min(config.backoff_max, config.backoff_base * (2**attempt))
    delay = rand() * ceiling
    return min(config.backoff_max, max(delay, float(retry_after)))
