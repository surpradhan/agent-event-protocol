import { afterEach, describe, expect, it, vi } from "vitest";

import { AEPClient } from "../../src/client";
import { AEPConnectionError, AEPValidationError } from "../../src/exceptions";
import { createEvent } from "../../src/event";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    impl(String(url), init ?? {}),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("AEPClient", () => {
  it("POSTs an event to /events with auth + content-type headers", async () => {
    const spy = mockFetch(() => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const client = new AEPClient({ serverUrl: "http://srv:1/", apiKey: "k1" });
    const ev = createEvent("agent://x", "task.created", "s", "t", {});
    const res = await client.emit(ev);

    expect(res).toEqual({ accepted: true });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("http://srv:1/events"); // trailing slash trimmed
    expect(init!.method).toBe("POST");
    const headers = init!.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer k1");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init!.body as string).type).toBe("task.created");
  });

  it("omits the auth header when no api key is set", async () => {
    const spy = mockFetch(() => new Response("{}", { status: 200 }));
    // Ensure env doesn't inject a key.
    const prev = process.env.AEP_API_KEY;
    delete process.env.AEP_API_KEY;
    try {
      const client = new AEPClient({ serverUrl: "http://srv:1" });
      await client.health();
      const headers = spy.mock.calls[0]![1]!.headers as Record<string, string>;
      expect("authorization" in headers).toBe(false);
    } finally {
      if (prev !== undefined) process.env.AEP_API_KEY = prev;
    }
  });

  it("builds query strings for list endpoints", async () => {
    const spy = mockFetch(() => new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    const client = new AEPClient({ serverUrl: "http://srv:1" });
    await client.getSessions({ limit: 50, cursor: "abc" });
    expect(spy.mock.calls[0]![0]).toBe("http://srv:1/sessions?limit=50&cursor=abc");
  });

  it("applies Python-parity defaults (getSessions limit=50, getSessionEvents limit=100)", async () => {
    const spy = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AEPClient({ serverUrl: "http://srv:1" });
    await client.getSessions();
    await client.getSessionEvents("ses_1");
    expect(spy.mock.calls[0]![0]).toBe("http://srv:1/sessions?limit=50");
    expect(spy.mock.calls[1]![0]).toBe("http://srv:1/sessions/ses_1/events?limit=100");
  });

  it("forwards the type and q filters on getSessionEvents", async () => {
    const spy = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AEPClient({ serverUrl: "http://srv:1" });
    await client.getSessionEvents("ses_1", { type: "tool.called", q: "search", limit: 25 });
    expect(spy.mock.calls[0]![0]).toBe(
      "http://srv:1/sessions/ses_1/events?limit=25&type=tool.called&q=search",
    );
  });

  it("emitBatch sends all events", async () => {
    const spy = mockFetch(() => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const client = new AEPClient({ serverUrl: "http://srv:1" });
    const events = [
      createEvent("agent://x", "task.created", "s", "t", {}),
      createEvent("agent://x", "task.completed", "s", "t", {}),
    ];
    const res = await client.emitBatch(events);
    expect(res).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("wraps network failures in AEPConnectionError", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = new AEPClient({ serverUrl: "http://unreachable:9" });
    await expect(client.health()).rejects.toBeInstanceOf(AEPConnectionError);
  });

  it("times out a stalled body read (timeout covers the read, not just headers)", async () => {
    // fetch resolves with headers immediately, but the body read hangs until the
    // client's internal AbortController fires — verifying the timeout spans the read.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return {
          status: 200,
          headers: new Headers(),
          json: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        } as unknown as Response;
      }),
    );
    const client = new AEPClient({ serverUrl: "http://srv:1", timeoutMs: 20 });
    await expect(client.health()).rejects.toBeInstanceOf(AEPConnectionError);
  });

  it("wraps a body-read failure (200 with invalid JSON) as AEPConnectionError", async () => {
    mockFetch(() => new Response("<<not json>>", { status: 200 }));
    const client = new AEPClient({ serverUrl: "http://srv:1" });
    await expect(client.health()).rejects.toBeInstanceOf(AEPConnectionError);
  });

  it("propagates real AEP errors (400) without wrapping them as connection errors", async () => {
    mockFetch(() => new Response(JSON.stringify({ errors: ["bad time"] }), { status: 400 }));
    const client = new AEPClient({ serverUrl: "http://srv:1" });
    const ev = createEvent("agent://x", "task.created", "s", "t", {});
    await expect(client.emit(ev)).rejects.toBeInstanceOf(AEPValidationError);
  });
});
