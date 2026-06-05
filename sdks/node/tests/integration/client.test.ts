/**
 * Live integration test for AEPClient against a running AEP ingest server.
 *
 * Auto-skips when the server is unreachable (mirrors the Python SDK's conftest
 * skip), so it is hermetic in CI (no server → skipped) and exercises the real
 * emit→query roundtrip locally when `AEP_INGEST_URL` / `AEP_API_KEY` are set.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { AEPClient } from "../../src/client";
import { createEvent } from "../../src/event";

const SERVER_URL = process.env.AEP_INGEST_URL ?? "http://localhost:8787";
const API_KEY = process.env.AEP_API_KEY;

let reachable = false;

beforeAll(async () => {
  try {
    const resp = await fetch(`${SERVER_URL.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    reachable = resp.ok;
  } catch {
    reachable = false;
  }
});

describe("AEPClient (live)", () => {
  it("emits an event and reads it back from the server", async (ctx) => {
    if (!reachable) ctx.skip();
    const client = new AEPClient({ serverUrl: SERVER_URL, apiKey: API_KEY });

    const marker = `node-it-${Math.floor(performance.now())}-${process.pid}`;
    const traceId = `trc_${marker}`;
    const sessionId = `ses_${marker}`;
    const event = createEvent(
      `agent://${marker}`,
      "task.created",
      sessionId,
      traceId,
      {
        framework: "node-sdk",
      },
      { agentRole: "orchestrator", subject: "integration-test" },
    );

    const res = await client.emit(event);
    expect(res.accepted).toBe(true);

    // Allow ingest to settle, then read the session's events back.
    await new Promise((r) => setTimeout(r, 400));
    const events = (await client.getSessionEvents(sessionId)).events as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(events)).toBe(true);
    expect(events.some((e) => e.id === event.id && e.type === "task.created")).toBe(true);
  });

  it("reports health", async (ctx) => {
    if (!reachable) ctx.skip();
    const client = new AEPClient({ serverUrl: SERVER_URL, apiKey: API_KEY });
    const h = await client.health();
    expect(h.ok).toBe(true);
  });
});
