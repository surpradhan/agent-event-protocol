const express = require("express");
const path = require("path");
const { validateEvent } = require("./validator");

const app = express();
const port = process.env.PORT || 8787;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const seenEventIds = new Set();
const sessionEvents = new Map();

const metrics = {
  received: 0,
  accepted: 0,
  rejected: 0,
  duplicates: 0,
  byType: {}
};

function sortByTime(events) {
  return [...events].sort((a, b) => a.time.localeCompare(b.time));
}

function getFilteredEvents(sessionId, typeFilter, textQuery) {
  let events = sortByTime(sessionEvents.get(sessionId) || []);

  if (typeFilter) {
    events = events.filter((e) => e.type === typeFilter);
  }

  if (textQuery) {
    const q = textQuery.toLowerCase();
    events = events.filter((e) => {
      const payload = JSON.stringify(e.payload || {}).toLowerCase();
      return (
        e.id.toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q) ||
        (e.causation_id || "").toLowerCase().includes(q) ||
        payload.includes(q)
      );
    });
  }

  return events;
}

function escapeCsv(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes("\n") || str.includes("\"")) {
    return `"${str.replace(/\"/g, '""')}"`;
  }
  return str;
}

function toCsv(events) {
  const headers = ["session_id", "trace_id", "time", "type", "id", "causation_id", "source", "payload"];
  const rows = events.map((e) => [
    e.session_id,
    e.trace_id,
    e.time,
    e.type,
    e.id,
    e.causation_id || "",
    e.source,
    JSON.stringify(e.payload || {})
  ]);

  return [headers.join(","), ...rows.map((r) => r.map(escapeCsv).join(","))].join("\n");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "aep-ingest", version: "0.1.0" });
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/sessions", (_req, res) => {
  const sessions = [];

  for (const [sessionId, events] of sessionEvents.entries()) {
    if (events.length === 0) continue;

    const sorted = sortByTime(events);
    sessions.push({
      session_id: sessionId,
      trace_id: sorted[0].trace_id,
      source: sorted[0].source,
      event_count: sorted.length,
      started_at: sorted[0].time,
      updated_at: sorted[sorted.length - 1].time
    });
  }

  sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  res.json({ sessions });
});

app.get("/sessions/:sessionId/events", (req, res) => {
  const typeFilter = req.query.type || "";
  const textQuery = req.query.q || "";
  const events = getFilteredEvents(req.params.sessionId, typeFilter, textQuery);
  res.json({ session_id: req.params.sessionId, events });
});

app.get("/sessions/:sessionId/export", (req, res) => {
  const sessionId = req.params.sessionId;
  const format = (req.query.format || "json").toLowerCase();
  const typeFilter = req.query.type || "";
  const textQuery = req.query.q || "";
  const events = getFilteredEvents(sessionId, typeFilter, textQuery);

  if (format === "csv") {
    const csv = toCsv(events);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${sessionId}-events.csv"`);
    return res.send(csv);
  }

  res.setHeader("Content-Disposition", `attachment; filename="${sessionId}-events.json"`);
  return res.json({ session_id: sessionId, events });
});

app.get("/metrics", (_req, res) => {
  res.json({
    ...metrics,
    session_count: sessionEvents.size
  });
});

app.post("/events", (req, res) => {
  metrics.received += 1;

  const event = req.body;
  const { valid, errors } = validateEvent(event);

  if (!valid) {
    metrics.rejected += 1;
    return res.status(400).json({ accepted: false, errors });
  }

  if (seenEventIds.has(event.id)) {
    metrics.duplicates += 1;
    return res.status(200).json({ accepted: true, duplicate: true, id: event.id });
  }

  seenEventIds.add(event.id);
  metrics.accepted += 1;
  metrics.byType[event.type] = (metrics.byType[event.type] || 0) + 1;

  if (!sessionEvents.has(event.session_id)) {
    sessionEvents.set(event.session_id, []);
  }
  sessionEvents.get(event.session_id).push(event);

  return res.status(202).json({ accepted: true, duplicate: false, id: event.id });
});

app.listen(port, () => {
  console.log(`AEP ingest listening on http://localhost:${port}`);
});
