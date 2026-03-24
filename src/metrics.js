"use strict";

/**
 * src/metrics.js — In-process HTTP metrics store
 *
 * Tracks per-route request counts and latency histograms so they can be
 * exported in Prometheus text format by GET /metrics/prometheus.
 *
 * All storage is in-process memory.  Metrics reset on server restart, which
 * is acceptable for Prometheus (counters are monotonically scraped anyway).
 *
 * Exports
 * -------
 *   metricsMiddleware          — Express middleware; must be registered early
 *   getPrometheusText(dbStats) — Returns the full Prometheus text payload
 */

// Histogram bucket thresholds in seconds (standard Prometheus defaults)
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// Map: "METHOD route status" → count
const requestCounts = new Map();

// Map: "METHOD route" → { buckets: number[], sum: number, count: number }
// buckets[i] = number of requests with duration <= BUCKETS[i]  (cumulative)
const latencyData = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getOrCreateLatency(key) {
  if (!latencyData.has(key)) {
    latencyData.set(key, {
      buckets: new Array(BUCKETS.length).fill(0),
      sum:     0,
      count:   0
    });
  }
  return latencyData.get(key);
}

function recordRequest(method, route, statusCode, durationSec) {
  // Request count
  const countKey = `${method} ${route} ${statusCode}`;
  requestCounts.set(countKey, (requestCounts.get(countKey) || 0) + 1);

  // Latency histogram — increment every bucket where duration fits
  const latKey = `${method} ${route}`;
  const entry = getOrCreateLatency(latKey);
  for (let i = 0; i < BUCKETS.length; i++) {
    if (durationSec <= BUCKETS[i]) entry.buckets[i]++;
  }
  entry.sum   += durationSec;
  entry.count += 1;
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Attach timing to every response.  Register this before routes.
 */
function metricsMiddleware(req, res, next) {
  const startNs = process.hrtime.bigint();

  res.on("finish", () => {
    // Use the parameterised route path (e.g. "/sessions/:sessionId/events")
    // when available.  For unmatched routes (404s from scanners or probes)
    // we use the sentinel "<unmatched>" to prevent unbounded Map growth from
    // high-cardinality arbitrary paths.
    const route = req.route ? req.route.path : "<unmatched>";
    const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
    recordRequest(req.method, route, res.statusCode, durationSec);
  });

  next();
}

// ---------------------------------------------------------------------------
// Prometheus text format builder
// ---------------------------------------------------------------------------

function label(name, value) {
  return `${name}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the full Prometheus text payload.
 *
 * @param {object} dbStats — result of db.getMetrics() (server-wide, no tenant filter)
 * @returns {string}
 */
function getPrometheusText(dbStats) {
  const lines = [];

  // ---- Ingest counters (from DB) -----------------------------------------

  lines.push("# HELP aep_events_received_total Total events posted to the ingest endpoint");
  lines.push("# TYPE aep_events_received_total counter");
  lines.push(`aep_events_received_total ${dbStats.received}`);
  lines.push("");

  lines.push("# HELP aep_events_accepted_total Total events accepted and persisted");
  lines.push("# TYPE aep_events_accepted_total counter");
  lines.push(`aep_events_accepted_total ${dbStats.accepted}`);
  lines.push("");

  lines.push("# HELP aep_events_rejected_total Total events rejected (schema or signature failure)");
  lines.push("# TYPE aep_events_rejected_total counter");
  lines.push(`aep_events_rejected_total ${dbStats.rejected}`);
  lines.push("");

  lines.push("# HELP aep_events_duplicates_total Total duplicate events discarded");
  lines.push("# TYPE aep_events_duplicates_total counter");
  lines.push(`aep_events_duplicates_total ${dbStats.duplicates}`);
  lines.push("");

  lines.push("# HELP aep_sessions_total Current total number of sessions");
  lines.push("# TYPE aep_sessions_total gauge");
  lines.push(`aep_sessions_total ${dbStats.session_count}`);
  lines.push("");

  lines.push("# HELP aep_workflows_total Current total number of workflows (distinct trace IDs)");
  lines.push("# TYPE aep_workflows_total gauge");
  lines.push(`aep_workflows_total ${dbStats.workflow_count}`);
  lines.push("");

  if (dbStats.byType && Object.keys(dbStats.byType).length > 0) {
    lines.push("# HELP aep_events_by_type_total Accepted events broken down by AEP event type");
    lines.push("# TYPE aep_events_by_type_total counter");
    for (const [type, count] of Object.entries(dbStats.byType)) {
      lines.push(`aep_events_by_type_total{${label("type", type)}} ${count}`);
    }
    lines.push("");
  }

  // ---- HTTP request counts -------------------------------------------------

  if (requestCounts.size > 0) {
    lines.push("# HELP aep_http_requests_total Total HTTP requests by method, route, and status");
    lines.push("# TYPE aep_http_requests_total counter");
    for (const [key, count] of requestCounts) {
      const parts  = key.split(" ");
      const status = parts.pop();
      const route  = parts.pop();
      const method = parts.join(" "); // method shouldn't have spaces, but defensive
      lines.push(
        `aep_http_requests_total{${label("method", method)},${label("route", route)},${label("status", status)}} ${count}`
      );
    }
    lines.push("");
  }

  // ---- Latency histograms ---------------------------------------------------

  if (latencyData.size > 0) {
    lines.push("# HELP aep_http_request_duration_seconds HTTP request duration in seconds");
    lines.push("# TYPE aep_http_request_duration_seconds histogram");
    for (const [key, entry] of latencyData) {
      const spaceIdx = key.indexOf(" ");
      const method = key.slice(0, spaceIdx);
      const route  = key.slice(spaceIdx + 1);
      const lbl    = `${label("method", method)},${label("route", route)}`;

      for (let i = 0; i < BUCKETS.length; i++) {
        lines.push(`aep_http_request_duration_seconds_bucket{${lbl},le="${BUCKETS[i]}"} ${entry.buckets[i]}`);
      }
      // +Inf bucket = total count
      lines.push(`aep_http_request_duration_seconds_bucket{${lbl},le="+Inf"} ${entry.count}`);
      lines.push(`aep_http_request_duration_seconds_sum{${lbl}} ${entry.sum.toFixed(9)}`);
      lines.push(`aep_http_request_duration_seconds_count{${lbl}} ${entry.count}`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

module.exports = { metricsMiddleware, getPrometheusText };
