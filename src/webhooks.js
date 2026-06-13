"use strict";

/**
 * Webhook registration validation + normalization (Phase 16-A).
 *
 * Pure, dependency-light helpers that the POST/PATCH /webhooks routes use to turn
 * an untrusted request body into a normalized, storable webhook record (or a list
 * of human-readable errors). The SSRF decision for `target_url` is delegated to
 * src/ssrf.js so there is a single place that decides what may be contacted.
 *
 * A webhook subscribes to a SUBSET of event types via `event_types`:
 *   • ["*"]              → all event types (the default when omitted)
 *   • ["error.raised", …] → only those core event types
 * Unknown types are rejected so a typo can't silently match nothing.
 */

const { CORE_EVENT_TYPES } = require("./coreEventTypes");
const { validateWebhookUrl } = require("./ssrf");

const WILDCARD = "*";
const MAX_EVENT_TYPES = 64;

/**
 * Normalize/validate the `event_types` filter.
 * @returns {{ ok: true, value: string[] } | { ok: false, error: string }}
 */
function normalizeEventTypes(raw) {
  // Omitted → subscribe to everything.
  if (raw === undefined || raw === null) return { ok: true, value: [WILDCARD] };

  if (!Array.isArray(raw)) {
    return { ok: false, error: "event_types must be an array of event type strings" };
  }
  if (raw.length === 0) {
    return { ok: false, error: "event_types must not be empty (use [\"*\"] for all events)" };
  }
  if (raw.length > MAX_EVENT_TYPES) {
    return { ok: false, error: `event_types must list at most ${MAX_EVENT_TYPES} types` };
  }
  if (!raw.every((t) => typeof t === "string")) {
    return { ok: false, error: "event_types must contain only strings" };
  }

  // Wildcard is exclusive: ["*"] means all; mixing it with explicit types is a
  // contradiction we reject rather than silently collapse.
  const deduped = [...new Set(raw)];
  if (deduped.includes(WILDCARD)) {
    if (deduped.length > 1) {
      return { ok: false, error: 'event_types cannot mix "*" with explicit event types' };
    }
    return { ok: true, value: [WILDCARD] };
  }

  const unknown = deduped.filter((t) => !CORE_EVENT_TYPES.includes(t));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown event type(s): ${unknown.join(", ")}` };
  }
  return { ok: true, value: deduped };
}

/**
 * Validate + normalize a create-webhook request body.
 *
 * @param {object} body                       request body
 * @param {{ allowlist?: string[]|string }} [opts]
 * @returns {{ ok: true, value: { target_url, event_types, enabled } }
 *          | { ok: false, errors: string[] }}
 */
function validateCreateWebhook(body, { allowlist } = {}) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};

  const urlResult = validateWebhookUrl(b.target_url, { allowlist });
  if (!urlResult.ok) errors.push(urlResult.reason);

  const typesResult = normalizeEventTypes(b.event_types);
  if (!typesResult.ok) errors.push(typesResult.error);

  let enabled = true;
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") {
      errors.push("enabled must be a boolean");
    } else {
      enabled = b.enabled;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      target_url: urlResult.url,
      event_types: typesResult.value,
      enabled
    }
  };
}

/**
 * Validate + normalize a PATCH (partial update) body. Only the provided fields
 * are validated; at least one updatable field must be present.
 *
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
function validateUpdateWebhook(body, { allowlist } = {}) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const value = {};

  if (b.target_url !== undefined) {
    const urlResult = validateWebhookUrl(b.target_url, { allowlist });
    if (!urlResult.ok) errors.push(urlResult.reason);
    else value.target_url = urlResult.url;
  }

  if (b.event_types !== undefined) {
    const typesResult = normalizeEventTypes(b.event_types);
    if (!typesResult.ok) errors.push(typesResult.error);
    else value.event_types = typesResult.value;
  }

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") errors.push("enabled must be a boolean");
    else value.enabled = b.enabled;
  }

  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(value).length === 0) {
    return { ok: false, errors: ["no updatable fields provided (target_url, event_types, enabled)"] };
  }
  return { ok: true, value };
}

module.exports = {
  validateCreateWebhook,
  validateUpdateWebhook,
  normalizeEventTypes,
  WILDCARD,
  MAX_EVENT_TYPES
};
