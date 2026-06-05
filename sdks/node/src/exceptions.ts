/**
 * Error hierarchy for the AEP Node SDK. Mirrors `sdks/python/aep/exceptions.py`
 * and the Go SDK's `errors.go`.
 */

/** Base class for all AEP SDK errors. */
export class AEPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain for instanceof across the ES5 transpile target.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Event failed client-side or server-side schema validation (HTTP 400). */
export class AEPValidationError extends AEPError {
  readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.errors = errors;
  }
}

/** Authentication or authorization failure (HTTP 401/403). */
export class AEPAuthError extends AEPError {}

/** Rate limit exceeded (HTTP 429). */
export class AEPRateLimitError extends AEPError {
  readonly retryAfter: number;
  constructor(message: string, retryAfter = 0) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/** Requested resource not found (HTTP 404). */
export class AEPNotFoundError extends AEPError {}

/** Cannot connect to the AEP ingest server. */
export class AEPConnectionError extends AEPError {}

/** Server-side error (HTTP 5xx) from the AEP ingest server. */
export class AEPServerError extends AEPError {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}
