import { afterEach, describe, expect, it, vi } from "vitest";

import { AEPClient } from "../../src/client";
import { AEPConnectionError } from "../../src/exceptions";
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
});
