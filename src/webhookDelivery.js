"use strict";

/**
 * Webhook event delivery engine (Phase 16-B).
 *
 * When an event is ingested and matches a registered + enabled webhook's
 * event-type filter, the event is POSTed to the webhook's target URL with
 * bounded exponential-backoff retries, and every attempt's outcome is recorded
 * in the webhook_deliveries table. This delivers PRD §Phase 16 "event delivery:
 * POST matching events to the webhook URL with retries".
 *
 * Safety posture (this is the project's only outbound-network path):
 *   • OFF by default — nothing is delivered unless WEBHOOKS_ENABLED is truthy, so
 *     a fresh deploy never starts POSTing anywhere. Registration (16-A) still
 *     works with delivery disabled.
 *   • NOT on the ingest hot path — the ingest route schedules delivery
 *     fire-and-forget (see scheduleDelivery) and returns immediately; a slow or
 *     failing webhook never adds latency to, or fails, an ingest.
 *   • SSRF re-checked at delivery time — the target is re-validated AND its
 *     resolved IPs are re-checked (assertResolvedIpAllowed) right before every
 *     attempt, because DNS can rebind between registration and delivery.
 *   • Everything is bounded — max retries, per-attempt timeout, backoff ceiling,
 *     global concurrency (a semaphore), and max payload size. No unbounded queue.
 *
 * The pure decision logic (matching, retryability, backoff schedule, the
 * single-attempt + retry state machine via injected deps) is unit-tested without
 * any network or real time.
 */

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const net = require("net");
const dnsPromises = require("dns").promises;
const { URL } = require("url");

const db = require("./db");
const logger = require("./logger");
const { validateWebhookUrl, assertResolvedIpAllowed } = require("./ssrf");
const { stableStringify } = require("./_canonical");
const { buildSignatureHeader, HEADER: SIGNATURE_HEADER } = require("./webhookSignature");

// ---------------------------------------------------------------------------
// Configuration (env, all bounded by hard ceilings)
// ---------------------------------------------------------------------------

const HARD_MAX_RETRIES = 10;
const HARD_MAX_TIMEOUT_MS = 30000;
const HARD_MAX_CONCURRENT = 100;
const MAX_PAYLOAD_BYTES = 256 * 1024; // generous ceiling for a single event envelope

/** True when WEBHOOKS_ENABLED is a truthy value (1/true/yes/on, any case). */
function isWebhooksEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.WEBHOOKS_ENABLED || "");
}

/** The configured allowlist of host[:port] targets that bypass the private-range block. */
function webhookAllowlist() {
  return process.env.WEBHOOK_TARGET_ALLOWLIST || "";
}

/** Parse an int env var, clamped to [min, max]; fall back to def when unset/NaN. */
function intEnv(name, def, min, max) {
  const v = parseInt(process.env[name], 10);
  if (Number.isNaN(v)) return def;
  return Math.max(min, Math.min(max, v));
}

/** Resolve the (bounded) delivery configuration from the environment. */
function getConfig() {
  return {
    maxRetries: intEnv("WEBHOOK_MAX_RETRIES", 4, 0, HARD_MAX_RETRIES),
    timeoutMs: intEnv("WEBHOOK_TIMEOUT_MS", 5000, 100, HARD_MAX_TIMEOUT_MS),
    maxConcurrent: intEnv("WEBHOOK_MAX_CONCURRENT", 10, 1, HARD_MAX_CONCURRENT),
    backoffBaseMs: intEnv("WEBHOOK_BACKOFF_BASE_MS", 1000, 1, 60000),
    backoffMaxMs: intEnv("WEBHOOK_BACKOFF_MAX_MS", 30000, 1, 300000),
    backoffFactor: 2
  };
}

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested, no I/O)
// ---------------------------------------------------------------------------

/** Does this event match an enabled webhook's event-type filter? */
function eventMatchesWebhook(event, webhook) {
  if (!event || !webhook || !webhook.enabled) return false;
  const types = Array.isArray(webhook.event_types) ? webhook.event_types : [];
  if (types.includes("*")) return true;
  return types.includes(event.type);
}

/**
 * Is an HTTP response status worth retrying? Retry transient failures only —
 * 408 (timeout), 429 (rate limited), and 5xx. Other 4xx are permanent (the
 * request itself is wrong; retrying won't help).
 */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Exponential backoff (ms) before the retry following attempt index `i` (0-based), capped. */
function backoffDelayMs(i, { backoffBaseMs, backoffMaxMs, backoffFactor }) {
  const raw = backoffBaseMs * Math.pow(backoffFactor, i);
  return Math.min(raw, backoffMaxMs);
}

/** The full ordered backoff schedule for a config's retries (for inspection/tests). */
function backoffSchedule(config) {
  const out = [];
  for (let i = 0; i < config.maxRetries; i++) out.push(backoffDelayMs(i, config));
  return out;
}

/** Build the JSON body delivered to the webhook target. */
function buildDeliveryBody(event, webhook, deliveryId, nowIso) {
  return {
    delivery_id: deliveryId,
    webhook_id: webhook.id,
    event_type: event.type,
    delivered_at: nowIso,
    event
  };
}

// ---------------------------------------------------------------------------
// Default I/O dependencies (overridable in tests)
// ---------------------------------------------------------------------------

/**
 * A guarded DNS lookup: resolves the host, rejects if ANY resolved IP is blocked
 * (unless the host is allowlisted), and otherwise hands Node the validated IP to
 * connect to. Used as the http(s) `lookup` option so the socket can only ever
 * connect to an address we just checked — closing the DNS-rebind TOCTOU window.
 */
function makeGuardedLookup(allowlist) {
  return (hostname, options, callback) => {
    dnsPromises
      .lookup(hostname, { all: true })
      .then((records) => {
        const ips = records.map((r) => r.address);
        const guard = assertResolvedIpAllowed(hostname, ips, { allowlist });
        if (!guard.ok) {
          callback(new Error(`ssrf: ${guard.reason}`));
          return;
        }
        const ip = ips[0];
        callback(null, ip, net.isIP(ip));
      })
      .catch(callback);
  };
}

/**
 * Default HTTP POST: sends `body` (a string) to `urlStr` with a hard timeout and
 * a guarded lookup. Resolves { statusCode } on any HTTP response; rejects on
 * network error / timeout / SSRF-blocked resolution. Response body is discarded
 * (and capped) — we only care about the status.
 */
function defaultHttpPost(urlStr, body, { timeoutMs, headers, allowlist }) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      urlStr,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "aep-webhooks/1",
          ...headers
        },
        timeout: timeoutMs,
        lookup: makeGuardedLookup(allowlist)
      },
      (res) => {
        // Drain (capped) and discard; we only need the status code.
        let drained = 0;
        res.on("data", (chunk) => {
          drained += chunk.length;
          if (drained > MAX_PAYLOAD_BYTES) res.destroy();
        });
        res.on("end", () => resolve({ statusCode: res.statusCode }));
        res.on("close", () => resolve({ statusCode: res.statusCode }));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function defaultDeps() {
  return {
    httpPost: defaultHttpPost,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date()
  };
}

// ---------------------------------------------------------------------------
// Delivery state machine (uses injected deps — no direct I/O here)
// ---------------------------------------------------------------------------

/**
 * Perform ONE delivery attempt. Returns a classified outcome:
 *   { ok, statusCode, error, permanent }
 * `permanent: true` means do-not-retry (SSRF/validation reject, or a non-retryable
 * HTTP status). A thrown httpPost (network error / timeout) is transient.
 */
async function deliverOnce(targetUrl, body, deps, config, allowlist, extraHeaders = {}) {
  // Re-validate scheme / credentials / literal host (defense-in-depth; the
  // resolved-IP rebind check happens inside the guarded lookup in httpPost).
  const v = validateWebhookUrl(targetUrl, { allowlist });
  if (!v.ok) return { ok: false, statusCode: null, error: `ssrf: ${v.reason}`, permanent: true };

  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    return { ok: false, statusCode: null, error: "payload too large", permanent: true };
  }

  try {
    const { statusCode } = await deps.httpPost(targetUrl, body, {
      timeoutMs: config.timeoutMs,
      allowlist,
      headers: extraHeaders
    });
    if (statusCode >= 200 && statusCode < 300) {
      return { ok: true, statusCode, error: null, permanent: false };
    }
    return {
      ok: false,
      statusCode,
      error: `HTTP ${statusCode}`,
      permanent: !isRetryableStatus(statusCode)
    };
  } catch (err) {
    // Network error / timeout / SSRF-from-guarded-lookup. The SSRF case is
    // effectively permanent, but treating it as transient only costs a few
    // bounded retries that will fail identically — kept simple on purpose.
    return { ok: false, statusCode: null, error: String(err.message || err), permanent: false };
  }
}

/**
 * Deliver `body` to a webhook with bounded exponential-backoff retries.
 * Returns the terminal record fields: { status, attempts, last_status_code, last_error }.
 */
async function deliverWithRetries(targetUrl, body, deps, config, allowlist, extraHeaders = {}) {
  let attempts = 0;
  let last = { statusCode: null, error: "not attempted" };

  // 1 initial try + up to maxRetries retries.
  for (let i = 0; i <= config.maxRetries; i++) {
    attempts += 1;
    const r = await deliverOnce(targetUrl, body, deps, config, allowlist, extraHeaders);
    last = { statusCode: r.statusCode, error: r.error };

    if (r.ok) {
      return { status: "success", attempts, last_status_code: r.statusCode, last_error: null };
    }
    if (r.permanent || i === config.maxRetries) {
      return { status: "failed", attempts, last_status_code: r.statusCode, last_error: r.error };
    }
    await deps.sleep(backoffDelayMs(i, config));
  }

  // Unreachable, but keep a definite return.
  return { status: "failed", attempts, last_status_code: last.statusCode, last_error: last.error };
}

// ---------------------------------------------------------------------------
// Global concurrency bound (a tiny async semaphore)
// ---------------------------------------------------------------------------

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

let _semaphore = null;
let _semaphoreMax = null;
function getSemaphore(maxConcurrent) {
  if (!_semaphore || _semaphoreMax !== maxConcurrent) {
    _semaphore = new Semaphore(maxConcurrent);
    _semaphoreMax = maxConcurrent;
  }
  return _semaphore;
}

// ---------------------------------------------------------------------------
// Dispatch (impure orchestration — fetches webhooks, records deliveries)
// ---------------------------------------------------------------------------

/**
 * Deliver one event to all of a tenant's matching, enabled webhooks. Records a
 * webhook_deliveries row per matched webhook. Never throws — all errors are
 * swallowed (logged at debug) so this can be fire-and-forgotten off the hot path.
 *
 * @param {object} event     the ingested event envelope
 * @param {string} tenantId
 * @param {{ db?, deps?, config?, allowlist? }} [overrides] test seams
 * @returns {Promise<Array>} the terminal delivery results (await is optional)
 */
async function dispatchEvent(event, tenantId, overrides = {}) {
  if (!isWebhooksEnabled()) return [];

  const store = overrides.db || db;
  const deps = overrides.deps || defaultDeps();
  const config = overrides.config || getConfig();
  const allowlist = overrides.allowlist !== undefined ? overrides.allowlist : webhookAllowlist();
  const sem = getSemaphore(config.maxConcurrent);

  let webhooks;
  try {
    webhooks = await store.listWebhooks(tenantId);
  } catch (err) {
    logger.debug({ err, tenant_id: tenantId }, "webhook dispatch: listWebhooks failed");
    return [];
  }

  const matched = (webhooks || []).filter((w) => eventMatchesWebhook(event, w));
  if (matched.length === 0) return [];

  const results = await Promise.all(
    matched.map(async (webhook) => {
      await sem.acquire();
      try {
        return await deliverToWebhook(event, webhook, tenantId, store, deps, config, allowlist);
      } finally {
        sem.release();
      }
    })
  );
  return results;
}

/** Record + run a single webhook delivery. Never throws. */
async function deliverToWebhook(event, webhook, tenantId, store, deps, config, allowlist) {
  const deliveryId = `wd_${crypto.randomUUID().replace(/-/g, "")}`;
  const startedAt = deps.now().toISOString();
  try {
    await store.createWebhookDelivery({
      id: deliveryId,
      webhookId: webhook.id,
      tenantId,
      eventId: event.id,
      eventType: event.type,
      status: "pending",
      attempts: 0,
      lastStatusCode: null,
      lastError: null,
      createdAt: startedAt,
      updatedAt: startedAt
    });

    // Serialize the body in the canonical (key-sorted) form so the exact bytes
    // sent are deterministic and a receiver can verify by HMAC-ing the raw body.
    const body = stableStringify(buildDeliveryBody(event, webhook, deliveryId, startedAt));

    // Identifying headers + the HMAC signature (Phase 16-C). The signing secret is
    // fetched via the dedicated internal accessor (never the public webhook shape);
    // a webhook with no secret (created before 16-C) is delivered unsigned.
    const headers = {
      "X-AEP-Webhook-Id": webhook.id,
      "X-AEP-Delivery-Id": deliveryId,
      "X-AEP-Event-Type": event.type
    };
    let signingSecret = null;
    try {
      signingSecret = await store.getWebhookSigningSecret(webhook.id, tenantId);
    } catch (err) {
      logger.debug({ err, webhook_id: webhook.id }, "webhook delivery: secret fetch failed");
    }
    if (signingSecret) {
      headers[SIGNATURE_HEADER] = buildSignatureHeader(body, signingSecret);
    }

    const result = await deliverWithRetries(webhook.target_url, body, deps, config, allowlist, headers);

    await store.updateWebhookDelivery(deliveryId, tenantId, {
      status: result.status,
      attempts: result.attempts,
      last_status_code: result.last_status_code,
      last_error: result.last_error,
      updated_at: deps.now().toISOString()
    });
    return { delivery_id: deliveryId, webhook_id: webhook.id, ...result };
  } catch (err) {
    logger.debug({ err, webhook_id: webhook.id }, "webhook delivery failed unexpectedly");
    return { delivery_id: deliveryId, webhook_id: webhook.id, status: "failed", error: String(err.message || err) };
  }
}

/**
 * Fire-and-forget entry point for the ingest route. Schedules delivery on the
 * next tick and returns immediately; errors never propagate to the caller.
 */
function scheduleDelivery(event, tenantId, overrides = {}) {
  if (!isWebhooksEnabled()) return;
  // Schedule on a microtask so dispatch runs after the ingest response is sent;
  // errors are swallowed so a failing webhook never affects the ingest.
  Promise.resolve().then(() =>
    dispatchEvent(event, tenantId, overrides).catch((err) =>
      logger.debug({ err }, "webhook scheduleDelivery: dispatch rejected")
    )
  );
}

module.exports = {
  scheduleDelivery,
  dispatchEvent,
  isWebhooksEnabled,
  getConfig,
  // pure helpers (exported for unit tests)
  eventMatchesWebhook,
  isRetryableStatus,
  backoffDelayMs,
  backoffSchedule,
  buildDeliveryBody,
  deliverOnce,
  deliverWithRetries,
  Semaphore,
  MAX_PAYLOAD_BYTES
};
