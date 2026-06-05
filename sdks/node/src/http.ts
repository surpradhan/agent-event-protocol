/**
 * Shared HTTP response handling. Mirrors `sdks/python/aep/_http.py` and the Go
 * SDK's `http.go`: map a `fetch` Response to a parsed body or the appropriate
 * typed AEP error.
 */

import {
  AEPAuthError,
  AEPNotFoundError,
  AEPRateLimitError,
  AEPServerError,
  AEPValidationError,
} from "./exceptions.js";

async function safeJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Parse a Retry-After header (RFC 7231 integer seconds; HTTP-date → 0; negatives clamped). */
export function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? 0 : Math.max(0, n);
}

/** Map a `fetch` Response to its parsed JSON body, or throw the matching AEP error. */
export async function handleResponse(resp: Response): Promise<Record<string, unknown>> {
  const status = resp.status;
  if (status === 200 || status === 201 || status === 202) {
    return (await resp.json()) as Record<string, unknown>;
  }
  const body = await safeJson(resp);
  if (status === 400) {
    const errs = body.errors;
    throw new AEPValidationError(
      `Validation error: ${JSON.stringify(errs ?? body)}`,
      Array.isArray(errs) ? (errs as string[]) : [],
    );
  }
  if (status === 401 || status === 403) {
    throw new AEPAuthError((body.error as string) ?? "Authentication failed");
  }
  if (status === 404) {
    throw new AEPNotFoundError((body.error as string) ?? "Not found");
  }
  if (status === 429) {
    throw new AEPRateLimitError(
      (body.error as string) ?? "Rate limit exceeded",
      parseRetryAfter(resp.headers.get("Retry-After")),
    );
  }
  if (status >= 500) {
    throw new AEPServerError((body.error as string) ?? `Server error ${status}`, status);
  }
  throw new AEPServerError(`Unexpected status ${status}`, status);
}
