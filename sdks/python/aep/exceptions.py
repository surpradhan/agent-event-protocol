class AEPError(Exception):
    """Base exception for all AEP SDK errors."""


class AEPValidationError(AEPError):
    """Event failed client-side or server-side schema validation."""

    def __init__(self, message: str, errors: list[str] | None = None) -> None:
        super().__init__(message)
        self.errors: list[str] = errors or []


class AEPAuthError(AEPError):
    """Authentication or authorization failure (HTTP 401/403)."""


class AEPRateLimitError(AEPError):
    """Rate limit exceeded (HTTP 429)."""

    def __init__(self, message: str, retry_after: int = 0) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class AEPNotFoundError(AEPError):
    """Requested resource not found (HTTP 404)."""


class AEPConnectionError(AEPError):
    """Transport-level failure reaching the AEP ingest server.

    Raised for connection errors, timeouts, and mid-flight network failures —
    after the client's transient-failure retries (if any) are exhausted.
    """


class AEPServerError(AEPError):
    """Server-side error (HTTP 5xx) from the AEP ingest server."""

    def __init__(self, message: str, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code
