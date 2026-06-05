import { describe, expect, it } from "vitest";

import {
  AEPAuthError,
  AEPNotFoundError,
  AEPRateLimitError,
  AEPServerError,
  AEPValidationError,
} from "../../src/exceptions";
import { handleResponse, parseRetryAfter } from "../../src/http";

function resp(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("12")).toBe(12);
  });
  it("clamps negatives to 0", () => {
    expect(parseRetryAfter("-5")).toBe(0);
  });
  it("falls back to 0 for HTTP-date / null", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(0);
    expect(parseRetryAfter(null)).toBe(0);
  });
});

describe("handleResponse", () => {
  it("returns the body on 202", async () => {
    await expect(handleResponse(resp(202, { accepted: true, id: "evt_1" }))).resolves.toEqual({
      accepted: true,
      id: "evt_1",
    });
  });

  it("throws AEPValidationError on 400 with errors", async () => {
    await expect(handleResponse(resp(400, { errors: ["bad time"] }))).rejects.toMatchObject({
      name: "AEPValidationError",
      errors: ["bad time"],
    });
    await expect(handleResponse(resp(400, { errors: [] }))).rejects.toBeInstanceOf(
      AEPValidationError,
    );
  });

  it("throws AEPAuthError on 401 and 403", async () => {
    await expect(handleResponse(resp(401, { error: "no key" }))).rejects.toBeInstanceOf(
      AEPAuthError,
    );
    await expect(handleResponse(resp(403, { error: "forbidden" }))).rejects.toBeInstanceOf(
      AEPAuthError,
    );
  });

  it("throws AEPNotFoundError on 404", async () => {
    await expect(handleResponse(resp(404, { error: "nope" }))).rejects.toBeInstanceOf(
      AEPNotFoundError,
    );
  });

  it("throws AEPRateLimitError on 429 with Retry-After", async () => {
    await expect(
      handleResponse(resp(429, { error: "slow down" }, { "Retry-After": "30" })),
    ).rejects.toMatchObject({ name: "AEPRateLimitError", retryAfter: 30 });
  });

  it("throws AEPServerError on 5xx with status code", async () => {
    await expect(handleResponse(resp(503, { error: "down" }))).rejects.toMatchObject({
      name: "AEPServerError",
      statusCode: 503,
    });
  });
});
