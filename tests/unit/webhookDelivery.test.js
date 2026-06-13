"use strict";

/**
 * Unit tests for the webhook delivery engine (src/webhookDelivery.js).
 * Pure logic + the retry state machine, all driven through injected deps so no
 * real network or real time is involved: event↔webhook matching, retryable-status
 * classification, the bounded exponential-backoff schedule, deliverOnce outcome
 * classification (success / retryable / permanent / SSRF), deliverWithRetries
 * (success-first, retry-then-succeed, exhaust→failed, permanent→no-retry), and
 * the concurrency Semaphore.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  eventMatchesWebhook,
  isRetryableStatus,
  backoffDelayMs,
  backoffSchedule,
  buildDeliveryBody,
  deliverOnce,
  deliverWithRetries,
  Semaphore
} = require("../../src/webhookDelivery");

const CONFIG = { maxRetries: 3, timeoutMs: 1000, maxConcurrent: 5, backoffBaseMs: 10, backoffMaxMs: 100, backoffFactor: 2 };

function wh(o = {}) {
  return { id: "wh_1", target_url: "https://hooks.example.com/x", event_types: ["*"], enabled: true, ...o };
}
function ev(o = {}) {
  return { id: "evt_1", type: "error.raised", ...o };
}

describe("eventMatchesWebhook", () => {
  test("wildcard matches any type", () => {
    assert.equal(eventMatchesWebhook(ev({ type: "task.created" }), wh({ event_types: ["*"] })), true);
  });
  test("explicit subset matches only listed types", () => {
    const w = wh({ event_types: ["error.raised", "task.failed"] });
    assert.equal(eventMatchesWebhook(ev({ type: "error.raised" }), w), true);
    assert.equal(eventMatchesWebhook(ev({ type: "task.created" }), w), false);
  });
  test("disabled webhook never matches", () => {
    assert.equal(eventMatchesWebhook(ev(), wh({ enabled: false })), false);
  });
  test("guards null/garbage", () => {
    assert.equal(eventMatchesWebhook(null, wh()), false);
    assert.equal(eventMatchesWebhook(ev(), null), false);
    assert.equal(eventMatchesWebhook(ev(), wh({ event_types: null })), false);
  });
});

describe("isRetryableStatus", () => {
  test("5xx, 408, 429 are retryable", () => {
    for (const s of [500, 502, 503, 408, 429]) assert.equal(isRetryableStatus(s), true, String(s));
  });
  test("other 4xx and 3xx are not retryable", () => {
    for (const s of [400, 401, 403, 404, 410, 301]) assert.equal(isRetryableStatus(s), false, String(s));
  });
});

describe("backoff schedule", () => {
  test("exponential with cap", () => {
    assert.equal(backoffDelayMs(0, CONFIG), 10);
    assert.equal(backoffDelayMs(1, CONFIG), 20);
    assert.equal(backoffDelayMs(2, CONFIG), 40);
    // capped at backoffMaxMs=100
    assert.equal(backoffDelayMs(10, CONFIG), 100);
  });
  test("schedule has maxRetries entries, monotonic non-decreasing", () => {
    const s = backoffSchedule(CONFIG);
    assert.equal(s.length, CONFIG.maxRetries);
    for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1]);
  });
});

describe("buildDeliveryBody", () => {
  test("wraps the event with delivery metadata", () => {
    const body = buildDeliveryBody(ev(), wh(), "wd_9", "2026-06-13T00:00:00.000Z");
    assert.equal(body.delivery_id, "wd_9");
    assert.equal(body.webhook_id, "wh_1");
    assert.equal(body.event_type, "error.raised");
    assert.equal(body.delivered_at, "2026-06-13T00:00:00.000Z");
    assert.deepEqual(body.event, ev());
  });
});

// A deps factory whose httpPost replays a queue of outcomes (number = status code,
// Error instance = thrown/network error). sleep is a no-op that records waits.
function depsFromOutcomes(outcomes) {
  const waits = [];
  let i = 0;
  return {
    waits,
    posts: () => i,
    httpPost: async () => {
      const o = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (o instanceof Error) throw o;
      return { statusCode: o };
    },
    sleep: async (ms) => { waits.push(ms); },
    now: () => new Date("2026-06-13T00:00:00.000Z")
  };
}

describe("deliverOnce", () => {
  test("2xx → ok", async () => {
    const r = await deliverOnce("https://h.example.com/x", "{}", depsFromOutcomes([200]), CONFIG, "");
    assert.deepEqual({ ok: r.ok, code: r.statusCode, permanent: r.permanent }, { ok: true, code: 200, permanent: false });
  });
  test("retryable 503 → not ok, not permanent", async () => {
    const r = await deliverOnce("https://h.example.com/x", "{}", depsFromOutcomes([503]), CONFIG, "");
    assert.equal(r.ok, false);
    assert.equal(r.permanent, false);
  });
  test("non-retryable 404 → permanent", async () => {
    const r = await deliverOnce("https://h.example.com/x", "{}", depsFromOutcomes([404]), CONFIG, "");
    assert.equal(r.ok, false);
    assert.equal(r.permanent, true);
  });
  test("network error (thrown) → not ok, transient", async () => {
    const r = await deliverOnce("https://h.example.com/x", "{}", depsFromOutcomes([new Error("ECONNRESET")]), CONFIG, "");
    assert.equal(r.ok, false);
    assert.equal(r.permanent, false);
    assert.match(r.error, /ECONNRESET/);
  });
  test("SSRF-blocked target → permanent, no httpPost call", async () => {
    let called = false;
    const deps = { httpPost: async () => { called = true; return { statusCode: 200 }; }, sleep: async () => {}, now: () => new Date() };
    const r = await deliverOnce("http://127.0.0.1/x", "{}", deps, CONFIG, "");
    assert.equal(r.ok, false);
    assert.equal(r.permanent, true);
    assert.match(r.error, /ssrf/);
    assert.equal(called, false);
  });
});

describe("deliverWithRetries", () => {
  test("succeeds on first attempt", async () => {
    const deps = depsFromOutcomes([200]);
    const r = await deliverWithRetries("https://h.example.com/x", "{}", deps, CONFIG, "");
    assert.equal(r.status, "success");
    assert.equal(r.attempts, 1);
    assert.equal(r.last_status_code, 200);
    assert.equal(deps.waits.length, 0);
  });

  test("retries transient failures then succeeds", async () => {
    const deps = depsFromOutcomes([503, new Error("timeout"), 200]);
    const r = await deliverWithRetries("https://h.example.com/x", "{}", deps, CONFIG, "");
    assert.equal(r.status, "success");
    assert.equal(r.attempts, 3);
    assert.equal(deps.waits.length, 2); // two backoff sleeps between three attempts
    assert.deepEqual(deps.waits, [10, 20]);
  });

  test("gives up as failed after exhausting retries", async () => {
    const deps = depsFromOutcomes([503, 503, 503, 503, 503]);
    const r = await deliverWithRetries("https://h.example.com/x", "{}", deps, CONFIG, "");
    assert.equal(r.status, "failed");
    assert.equal(r.attempts, CONFIG.maxRetries + 1); // 1 + 3 retries = 4
    assert.equal(r.last_status_code, 503);
  });

  test("permanent failure does not retry", async () => {
    const deps = depsFromOutcomes([403, 200]);
    const r = await deliverWithRetries("https://h.example.com/x", "{}", deps, CONFIG, "");
    assert.equal(r.status, "failed");
    assert.equal(r.attempts, 1);
    assert.equal(r.last_status_code, 403);
    assert.equal(deps.waits.length, 0);
  });

  test("SSRF target fails permanently with one attempt", async () => {
    const deps = depsFromOutcomes([200]);
    const r = await deliverWithRetries("http://10.0.0.1/x", "{}", deps, CONFIG, "");
    assert.equal(r.status, "failed");
    assert.equal(r.attempts, 1);
    assert.match(r.last_error, /ssrf/);
  });

  test("allowlisted private target is attempted (not SSRF-blocked)", async () => {
    const deps = depsFromOutcomes([200]);
    const r = await deliverWithRetries("http://127.0.0.1:9099/x", "{}", deps, CONFIG, "127.0.0.1:9099");
    assert.equal(r.status, "success");
  });

  test("threads extra headers (e.g. X-AEP-Signature) through to httpPost", async () => {
    let seenHeaders = null;
    const deps = {
      httpPost: async (_url, _body, opts) => { seenHeaders = opts.headers; return { statusCode: 200 }; },
      sleep: async () => {},
      now: () => new Date()
    };
    const extra = { "X-AEP-Signature": "hmac-sha256=abc", "X-AEP-Delivery-Id": "wd_1" };
    const r = await deliverWithRetries("https://h.example.com/x", "{}", deps, CONFIG, "", extra);
    assert.equal(r.status, "success");
    assert.equal(seenHeaders["X-AEP-Signature"], "hmac-sha256=abc");
    assert.equal(seenHeaders["X-AEP-Delivery-Id"], "wd_1");
  });
});

describe("Semaphore", () => {
  test("bounds concurrency to max", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      await sem.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      sem.release();
    };
    await Promise.all(Array.from({ length: 8 }, task));
    assert.ok(peak <= 2, `peak concurrency ${peak} should be ≤ 2`);
  });
});
