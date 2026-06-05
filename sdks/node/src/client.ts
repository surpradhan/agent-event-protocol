/**
 * `AEPClient` — an async, `fetch`-based client for the AEP ingest + query API.
 * Mirrors `sdks/python/aep/client.py` (JS has no separate sync client). Reads
 * `AEP_INGEST_URL` / `AEP_API_KEY` from the environment when not passed in.
 */

import { DEFAULT_SERVER_URL } from "./constants.js";
import { AEPConnectionError, AEPError } from "./exceptions.js";
import { handleResponse } from "./http.js";
import { AEPEvent } from "./types.js";

export interface AEPClientOptions {
  serverUrl?: string;
  apiKey?: string;
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
}

export type ListParams = {
  limit?: number;
  cursor?: string;
};

/** Params for {@link AEPClient.getSessionEvents} — adds server-side filters. */
export type SessionEventParams = ListParams & {
  /** Filter to a single event type, e.g. `"tool.called"`. */
  type?: string;
  /** Free-text query filter. */
  q?: string;
};

export class AEPClient {
  private readonly serverUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: AEPClientOptions = {}) {
    const url = options.serverUrl ?? process.env.AEP_INGEST_URL ?? DEFAULT_SERVER_URL;
    this.serverUrl = url.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.AEP_API_KEY ?? undefined;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** POST a single event to `/events`. */
  emit(event: AEPEvent): Promise<Record<string, unknown>> {
    return this.post("/events", event);
  }

  /** Emit a batch of events concurrently; resolves to per-event results in order. */
  emitBatch(events: AEPEvent[]): Promise<Record<string, unknown>[]> {
    return Promise.all(events.map((e) => this.emit(e)));
  }

  getSessions(params: ListParams = {}): Promise<Record<string, unknown>> {
    return this.get("/sessions", { limit: params.limit ?? 50, cursor: params.cursor });
  }

  getSessionEvents(
    sessionId: string,
    params: SessionEventParams = {},
  ): Promise<Record<string, unknown>> {
    return this.get(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      limit: params.limit ?? 100,
      cursor: params.cursor,
      type: params.type,
      q: params.q,
    });
  }

  getSessionTree(sessionId: string): Promise<Record<string, unknown>> {
    return this.get(`/sessions/${encodeURIComponent(sessionId)}/tree`);
  }

  getSessionExport(sessionId: string, format = "json"): Promise<Record<string, unknown>> {
    return this.get(`/sessions/${encodeURIComponent(sessionId)}/export`, { format });
  }

  getWorkflow(traceId: string): Promise<Record<string, unknown>> {
    return this.get(`/workflows/${encodeURIComponent(traceId)}`);
  }

  getMetrics(): Promise<Record<string, unknown>> {
    return this.get("/metrics");
  }

  health(): Promise<Record<string, unknown>> {
    return this.get("/health");
  }

  ready(): Promise<Record<string, unknown>> {
    return this.get("/ready");
  }

  // -- internals ------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async get(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<Record<string, unknown>> {
    let url = this.serverUrl + path;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    return this.request("GET", url);
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", this.serverUrl + path, JSON.stringify(body));
  }

  private async request(
    method: string,
    url: string,
    body?: string,
  ): Promise<Record<string, unknown>> {
    // One timeout spanning the whole exchange — connect, headers, AND the
    // response-body read. (Clearing it as soon as fetch() resolves would leave a
    // stalled body read untimed.)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: this.headers(),
          body,
          signal: controller.signal,
        });
      } catch (err) {
        throw new AEPConnectionError(
          `Cannot reach AEP server at ${this.serverUrl}: ${(err as Error).message}`,
        );
      }
      try {
        return await handleResponse(resp);
      } catch (err) {
        // Real AEP errors (validation/auth/rate-limit/…) propagate unchanged; a
        // transport/abort failure while reading the body becomes a connection error.
        if (err instanceof AEPError) throw err;
        throw new AEPConnectionError(
          `Failed reading response from ${this.serverUrl}: ${(err as Error).message}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
