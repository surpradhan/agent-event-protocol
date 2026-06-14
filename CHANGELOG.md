# Changelog

All notable changes to AEP are documented here.

---

## Export format + compression options (Phase 17-C) — 2026-06-14

Phase 17 (S3/Cloud Export) PR-C — completes the PRD §Phase 17 "format options:
JSON Lines, Parquet, CSV" and "compression: gzip, brotli". Selectable per export
behind the PR-A factories; no change to the sinks.

- **CSV format** (`src/export/formats.js`): a streaming RFC-4180 encoder with a
  fixed envelope column set (`specversion,id,time,source,type,session_id,…`).
  Object-valued fields (`payload`/`labels`/`extensions`/`signature`) are stored
  as JSON strings; cells are quoted (quotes doubled) when they contain a comma,
  quote, CR or LF; a header row is emitted first.
- **Parquet format** (`src/export/parquet.js`, lazily loaded): Apache Parquet via
  `@dsnp/parquetjs`. Envelope fields as UTF8 columns (`id` required, rest
  optional; object fields as JSON strings), written through the same
  `writeRecords` byte-counting + sink concurrency path. Parquet is **columnar and
  self-compressed** (internal per-column GZIP), so the external `--compression`
  layer (and its filename suffix) does **not** apply — `runExport` neutralises it
  to `none` and the object keys `.parquet`. The heavy library is `require`d
  lazily (the jsonl/csv paths never load it), mirroring the S3 sink.
- **brotli compression**: added to the compressor factory (`.br`) alongside gzip
  and none; wraps the text formats (jsonl, csv).
- **CLI**: `--format jsonl|csv|parquet`, `--compression none|gzip|brotli`, with a
  help note that Parquet self-compresses.
- 12 new unit tests (`tests/unit/exportFormats.test.js`) incl. a real
  Parquet write→read-back round-trip; existing export tests updated for the
  expanded support matrix. Adds `@dsnp/parquetjs` (pure-JS, no native build);
  no new CI job. Server suite green.

---

## S3 export sink (Phase 17-B) — 2026-06-14

Phase 17 (S3/Cloud Export) PR-B — the first cloud egress path. Delivers the S3
half of PRD §Phase 17 "export sessions/events to S3". Drops in behind the PR-A
`ExportSink` contract; no change to the export core or the local path.

- **`src/export/s3sink.js` — `S3Sink`**: streams an export object to Amazon S3 via
  the AWS SDK v3 multipart uploader (`@aws-sdk/lib-storage`'s `Upload`), so large
  objects stream up without buffering. Reports an `s3://bucket/key` (or
  `endpoint/bucket/key`) location.
- **Security posture (mirrors the webhook delivery engine)**:
  - **OFF by default** — only constructed when `--sink s3` (or `EXPORT_SINK=s3`)
    is explicitly selected.
  - **Credentials are never accepted as parameters and never logged** — the
    `S3Client` resolves them from the standard AWS credential chain (env vars,
    shared config, SSO, container/instance roles).
  - The heavy AWS SDK is `require`d **lazily** (only when an S3 sink is used), so
    the local path never loads it.
- **`createSink({ kind, dir, bucket, region, endpoint })` factory** in
  `src/export/sink.js` — shared sink construction for the CLI (and the retention
  export path in PR-D).
- **CLI**: `--sink local|s3`, `--bucket`, `--region`, `--endpoint` (each with env
  fallbacks `EXPORT_SINK` / `EXPORT_S3_BUCKET` / `EXPORT_S3_REGION` (or
  `AWS_REGION`) / `EXPORT_S3_ENDPOINT`). `--endpoint` enables S3-compatible stores
  (MinIO, etc.) via path-style addressing.
- **Scope**: S3 only. GCS / Azure Blob (also named in the PRD) are deliberate
  follow-ups — they slot in as sibling sinks behind the same interface.
- Testability: the uploader is injectable, so 13 new unit tests
  (`tests/unit/exportS3.test.js`) drive the full encode→compress→S3 pipeline with
  no network and no AWS SDK calls. No new CI job; server suite green.

---

## Export core + JSONL + local sink (Phase 17-A) — 2026-06-14

Phase 17 (S3/Cloud Export) PR-A — **starts Phase 17.** A pure, streaming export
core plus an operator CLI. Delivers the first cut of PRD §Phase 17 "export
sessions/events … format options: JSON Lines … compression: gzip". The *event*
log is the archival unit (sessions are derived; the prune job operates on events
too), which sets up "export to cold storage before delete" in PR-D.

- **`src/export/` module**:
  - `sink.js` — a minimal pluggable `ExportSink` interface (`write(key, stream)`)
    and a `LocalFileSink` (no cloud dependency) with a path-traversal guard. Cloud
    sinks (S3 in PR-B) drop in behind the same contract.
  - `formats.js` — `createEncoder` / `createCompressor` factories + pure
    `formatExtension` / `compressionExtension` lookups. Ships JSON Lines + gzip
    (and explicit `none`); Parquet/CSV/brotli land in PR-C behind these factories.
  - `index.js` — `writeRecords()` streams records → encoder → optional compressor →
    byte-counter → sink (fully unit-testable with a `LocalFileSink`, no DB), and
    `runExport()` resolves the tenant set, fetches each tenant's time-windowed
    events (reuses `getEventsForQuery`, no new DB method), and writes one object
    per non-empty tenant. Tenant-scoped exactly like the read API / prune job.
- **`src/export.js` operator CLI** (`npm run export`): `--tenant`, `--out`,
  `--prefix`, `--since`/`--until`, `--format`, `--compression`, `--dry-run`,
  `--json`, `--help`. Mirrors `src/prune.js` — run-once, **no always-on
  scheduler** (cron / k8s CronJob wiring documented in PR-D).
- No schema change, no new DB method, no new CI job. 27 new unit tests
  (`tests/unit/export.test.js`); server suite green.

---

## Webhook deliveries observability + docs (Phase 16-D) — 2026-06-13

Phase 16 (Webhooks & Alerts) PR-D — the final slice. Surfaces the delivery history
and documents the feature. **Phase 16 is now complete (A–D).**

- **`GET /webhooks/:id/deliveries`** (read- + tenant-scoped; `?since`/`?until`/
  `?limit`): recent delivery attempts for a webhook, newest first, each with its
  terminal `status`, `attempts`, `last_status_code`, and `last_error`. 404 if the
  webhook isn't the tenant's (existence not leaked). Reuses the
  `listWebhookDeliveries` data method from 16-B; `WebhookDelivery` schema + path
  added to OpenAPI.
- **Dashboard "Webhooks" tab**: lists the tenant's registrations (target,
  event-type filter, enabled/disabled) and, on click, that webhook's recent
  delivery attempts with colour-coded status — verified in the browser preview
  against a live server (real ingest → delivery → failed-with-error rows render).
- **`aep webhooks deliveries <id>`** CLI (`--since`/`--until`/`--limit`/`--json`).
- **OPERATIONS.md §6 "Webhooks & alerts"**: enabling delivery (`WEBHOOKS_ENABLED`,
  off by default), registration, the SSRF security posture + allowlist, the bounded
  retry knobs, payload signing + verification, and deliveries observability (incl.
  the "deliveries are not pruned" / per-node concurrency caveats).
- No new CI job. Server suite: 386 unit + 201 integration.

---

## Webhook HMAC payload signing (Phase 16-C) — 2026-06-13

Phase 16 (Webhooks & Alerts) PR-C — delivers PRD §Phase 16 "signing: webhook
payloads are HMAC-signed for verification".

- **Per-webhook signing secret**: every webhook gets a `whsec_…` secret at
  registration (`webhooks.signing_secret`, SQLite migration `009` + Postgres
  `SCHEMA_DDL` mirror incl. an idempotent `ADD COLUMN IF NOT EXISTS`). It is
  returned **once** in the `POST /webhooks` 201 response and **never again** — GET
  / list responses omit it (the delivery engine reads it via a dedicated internal
  `getWebhookSigningSecret`, never the public webhook shape).
- **Signed deliveries**: the delivery body is serialized in the canonical
  (key-sorted `stableStringify`) form and HMAC-SHA256-signed with the secret,
  reusing the same canonical-JSON + HMAC stack as event signatures
  (`src/_canonical.js`). Deliveries carry **`X-AEP-Signature: hmac-sha256=<base64>`**
  plus `X-AEP-Webhook-Id` / `X-AEP-Delivery-Id` / `X-AEP-Event-Type` headers.
  Because the transmitted bytes are the canonical form, a receiver verifies simply
  by HMAC-ing the raw body received.
- **Verification helper + example**: `src/webhookSignature.js`
  (`generateSigningSecret` / `buildSignatureHeader` / constant-time
  `verifyWebhookSignature`) and a standalone `examples/verify-webhook-signature.js`
  receiver. Webhooks created before this slice (no secret) are delivered unsigned.
- No new CI job. Server suite: 386 unit + 195 integration (incl. a real-listener
  test asserting the signature verifies against the one-time secret).

---

## Webhook event delivery + retries (Phase 16-B) — 2026-06-13

Phase 16 (Webhooks & Alerts) PR-B — delivers PRD §Phase 16 "event delivery: POST
matching events to the webhook URL with retries". Builds on the 16-A registry.

- **Delivery on ingest**: when an event is accepted, it is fanned out to the
  tenant's **enabled** webhooks whose `event_types` filter matches, via a new
  `src/webhookDelivery.js`. Each delivery POSTs `{ delivery_id, webhook_id,
  event_type, delivered_at, event }` to the target URL.
- **OFF by default** — nothing is delivered unless **`WEBHOOKS_ENABLED`** is
  truthy, so a fresh deploy never starts POSTing anywhere. Registration still
  works with delivery disabled.
- **Off the ingest hot path** — delivery is fire-and-forget (scheduled on a
  microtask after the 202 is sent); a slow/failing webhook never adds latency to
  or fails an ingest.
- **Bounded exponential-backoff retries** — retries transient failures (5xx, 408,
  429, network/timeout) up to `WEBHOOK_MAX_RETRIES` (default 4); other 4xx are
  permanent (no retry). Everything is bounded: per-attempt timeout
  (`WEBHOOK_TIMEOUT_MS`), backoff base/ceiling, global concurrency
  (`WEBHOOK_MAX_CONCURRENT`, a semaphore), and max payload size.
- **SSRF re-checked at delivery** — the target is re-validated and its resolved
  IPs are re-checked via a guarded DNS lookup right before connecting, so a host
  that rebinds to a private/loopback address after registration is rejected. (Also
  fixed a 16-A allowlist gap: a `host:port` allowlist entry now exempts that host's
  IPs at delivery time, where DNS gives no port.)
- **`webhook_deliveries` table** (tenant-scoped) records one row per attempt set:
  `status` (pending→success/failed), `attempts`, `last_status_code`, `last_error`,
  timestamps. SQLite migration `008_webhook_deliveries.js` + Postgres `SCHEMA_DDL`
  mirror; new `createWebhookDelivery` / `updateWebhookDelivery` /
  `listWebhookDeliveries` StorageBackend methods.
- No new CI job. Server suite: 373 unit + 193 integration (incl. a real local-listener
  delivery/retry test gated behind `WEBHOOKS_ENABLED` + the allowlist).

---

## Webhook registration & management (Phase 16-A) — 2026-06-13

Phase 16 (Webhooks & Alerts) PR-A — the registration half of PRD §Phase 16
"webhook registration: `POST /webhooks` with event filters and target URL".
Registration & management only; event delivery (16-B) and HMAC signing (16-C)
build on this. This is the project's **first feature that makes outbound network
calls**, so the headline concern is SSRF, addressed up front.

- **`webhooks` table** (tenant-scoped): SQLite migration `007_webhooks.js` +
  Postgres `SCHEMA_DDL` mirror. Stores `target_url`, an `event_types` filter
  (`["*"]` for all, or a subset of the core event types), an `enabled` flag, and
  timestamps.
- **CRUD routes**, all tenant-scoped from the API key:
  - `POST /webhooks` (**write** scope) — register; `event_types` defaults to
    `["*"]`, `enabled` to `true`.
  - `GET /webhooks` / `GET /webhooks/:id` (read) — list / fetch.
  - `PATCH /webhooks/:id` (**write**) — partial update of `target_url` /
    `event_types` / `enabled` (a changed URL is re-validated).
  - `DELETE /webhooks/:id` (**write**) — remove.
- **SSRF guard** (`src/ssrf.js`, pure + unit-tested): rejects non-http(s) schemes,
  embedded credentials, and any target resolving to loopback, RFC1918 private,
  CGNAT, link-local (incl. the `169.254.169.254` cloud-metadata endpoint), IPv6
  ULA/link-local, or other reserved ranges (IPv4-mapped IPv6 is decoded so it
  can't smuggle a private v4; the `64:ff9b::/96` NAT64 well-known prefix is
  decoded too). Applied at registration; a delivery-time DNS-rebind re-check
  (`assertResolvedIpAllowed`) is provided for 16-B. Self-hosters can permit
  specific private targets via the new **`WEBHOOK_TARGET_ALLOWLIST`** env var
  (comma-separated `host` / `host:port`).
- **`aep webhooks`** CLI (`list` / `get` / `create` / `update` / `delete`) and
  OpenAPI under a new **Webhooks** tag (`Webhook` schema).
- No new CI job. Server suite: 350 unit + 186 integration.

---

## Workflow anomaly detection (Phase 15-D) — 2026-06-12

Phase 15 (Advanced Dashboard) PR-D — the final slice: "Anomaly detection: alert
when a workflow deviates from expected patterns" (PRD §Phase 15), with an explicit
definition of *expected*.

- **`GET /analytics/anomalies`** (read- + tenant-scoped; `?since`/`?until`/
  `?threshold`/`?limit`): flags workflows (traces) whose **error-rate**,
  **policy.blocked volume**, or **latency** (slowest operation) exceeds the
  per-tenant cross-trace baseline by more than `threshold` **robust modified-z**
  (median/MAD, Iglewicz–Hoaglin; default 3.5). Robust statistics are used so a
  single spike doesn't mask itself and sparse metrics (mostly-zero counts) still
  flag; a metric only fires when its baseline is *stable* (≥ 3 traces, non-zero
  spread), so a handful of traces or a uniform fleet produce no false positives.
- **Pure `src/anomalies.js`** (`detectAnomalies`, injected `now`, no I/O) — reuses
  the merged `getEventsForQuery` window fetch (no DB change, no migration) and the
  performance module's start→end operation pairing for the latency metric.
- **`aep analytics anomalies`** CLI (severity-coloured summary or `--json`), an
  **Anomalies** dashboard tab (severity-ranked findings + per-metric flags +
  baseline summary, with a tab badge), and OpenAPI under the Analytics tag
  (`AnomalyReport` schema).
- No schema change, no new CI job. Server suite: 282 unit + 169 integration.

---

## Cross-session causation DAG (Phase 15-C) — 2026-06-12

Phase 15 (Advanced Dashboard) PR-C: "Workflow visualization: interactive DAG
showing causation chains" (PRD §Phase 15). Extends the per-session DAG (which
could only show cross-session links as dangling stubs) to a **workflow-level
causation graph spanning every session of a trace**.

- **`GET /workflows/:traceId/graph`** (read- + tenant-scoped, 404 like the workflow
  tree): assembles the event-level causation graph for a whole trace — `nodes`
  (projected events, time-ordered), `edges` (causation parent→child) classified
  **intra- vs cross-session**, a per-session summary, `root_ids`, and
  `cross_session_edge_count`.
- **Pure `src/workflowGraph.js`** (`buildWorkflowGraph`, injected `now`, no I/O) +
  thin dual-backend `getWorkflowEvents(traceId, tenantId)` (trivial dialect-identical
  `SELECT … WHERE trace_id = ?`; shaping stays in JS) — the proven fetch-then-shape
  split. Unit-tested with zero database.
- **Dashboard**: the Workflows tab gains a **Session Tree / Causation Graph** toggle;
  the graph view renders an interactive SVG DAG with nodes colour-coded by session,
  **cross-session causation edges highlighted** (purple, dashed), a session legend,
  and click-to-inspect node details.
- **`aep workflow <traceId> --graph`** CLI (summary or `--json`) and OpenAPI under
  the Workflows tag (`WorkflowGraph` schema).
- No schema change, no new CI job. Server suite: 269 unit + 162 integration.

---

## Custom analytics — user-defined queries (Phase 15-B) — 2026-06-12

Phase 15 (Advanced Dashboard) PR-B: "Custom analytics: user-defined queries over
event streams" (PRD §Phase 15), as a **safe, structured query model — never SQL**.

- **Query spec**: a JSON object — `filters` (AND-combined predicates with operators
  `eq`/`ne`/`in`/`nin`/`exists`/`not_exists`/`prefix`/`contains`/`gt`/`gte`/`lt`/`lte`),
  `group_by`, `aggregations` (`count` + `count_distinct`), optional `time_bucket`
  (hour/day/month), `since`/`until`, and `limit`. Field references are whitelist-
  validated: a top-level event field, or a `payload.*` / `labels.*` / `extensions.*`
  dot-path. The segments `__proto__`/`prototype`/`constructor` are rejected
  (prototype-pollution guard).
- **Pure `src/customQuery.js`** (`validateQuerySpec` + `runQuery`, injected `now`,
  no I/O): the DB does a trivial, dialect-identical tenant+window `SELECT` and ALL
  filtering/grouping/aggregation happens in JS — **zero injection surface**, no
  SQLite-vs-Postgres divergence. Unit-tested with zero database.
- **Saved-query library** (persistence): new `saved_queries` table (SQLite migration
  `006` + Postgres `SCHEMA_DDL` mirror; `(tenant_id, name)` UNIQUE) with dual-backend
  `createSavedQuery`/`getSavedQuery`/`listSavedQueries`/`deleteSavedQuery` +
  `getEventsForQuery`.
- **Routes** (all tenant-scoped): `POST /analytics/query` (ad-hoc, read),
  `POST /analytics/saved-queries` (create, **write**), `GET /analytics/saved-queries`
  (list, read), `GET /analytics/saved-queries/:id` (read), `POST
  /analytics/saved-queries/:id/run` (read), `DELETE /analytics/saved-queries/:id`
  (**write**). 400 invalid spec, 409 duplicate name, 404 cross-tenant/unknown.
- **`aep analytics query`** CLI (`--file`/`--spec`/`--save`/`--list`/`--run`/
  `--delete`), a **Custom Analytics** dashboard tab (filter/group/aggregate builder +
  results table + saved-query library), and OpenAPI under the Analytics tag
  (`QuerySpec`/`QueryResult`/`SavedQuery` schemas).
- New SQLite migration + Postgres mirror (covered by the existing `Postgres parity
  tests` job); no new CI job. Server suite: 258 unit + 156 integration.

---

## Performance profiling analytics (Phase 15-A) — 2026-06-12

Phase 15 (Advanced Dashboard) PR-A: latency/performance profiling — "latency
breakdown per agent, per tool, per event type" (PRD §Phase 15).

- **`GET /analytics/performance`** (read- + tenant-scoped, `?since`/`?until`/`?limit`):
  pairs lifecycle events into *operations* — `tool.called`→`tool.result` and
  `task.created`→`task.completed`|`task.failed`, matched by the end event's
  `causation_id` — and reports **p50/p95/p99** latency (computed from event `time`
  fields) sliced `by_tool`, `by_agent` (source), `by_session`, and `by_operation`,
  plus an `overall` summary and a `slowest` list. End events with no in-window
  start (or a negative duration) are reported in `unmatched_ends`.
- **Pure aggregator** `src/performance.js` (`summarizePerformance`, injected `now`,
  no I/O) — mirrors the PR-D pattern: the dual-backend `getPerformanceEvents`
  (`src/db/backends/{sqlite,postgres}.js` + `interface.js` + `src/db/index.js`)
  does a trivial, dialect-identical `SELECT` and the shaping is unit-tested with
  zero database. Percentiles use the nearest-rank method (each reported value is
  an actually-observed sample).
- **`aep analytics performance`** CLI subcommand, a **Performance** dashboard tab
  (`src/public/dashboard.html`) with overall stats + per-tool/agent/operation
  latency tables + a slowest-operations list, and an OpenAPI path under the
  **Analytics** tag (`LatencyStats`/`LatencyGroup` schemas).
- No schema change, no new CI job. Server suite: 229 unit + 141 integration.

---

## SDK-side offline audit-bundle verifiers (Phase 14 add-on) — 2026-06-12

Ports the server's `verifyAuditBundle` to the **Python, Go, and Node SDKs** so a
compliance reviewer can verify a tamper-evident audit bundle (from
`GET /sessions/:id/audit-bundle`, `GET /workflows/:traceId/audit-bundle`, or
`aep audit export`) **entirely offline** — no server, no database — with just the
bundle JSON and the audit signing secret.

- **Python:** `aep.verify_audit_bundle(bundle, secret)` (`aep/_audit.py`).
- **Go:** `aep.VerifyAuditBundle(map, secret)` + `aep.VerifyAuditBundleJSON(bytes, secret)` (`aep/audit.go`).
- **Node:** `verifyAuditBundle(bundle, secret)` (`sdks/node/src/audit.ts`); `stableStringify` is now also exported.
- Each recomputes the content digest over the bundle's events (the v2 deep
  canonical form) and the HMAC signature over its manifest (deep, key-sorted
  JSON) — reusing each SDK's existing canonical primitives, so they are
  **byte-identical to the server**. Returns `{ valid, errors,
  content_digest_match, manifest_signature_valid, per_event }`. Verifiers only
  verify; building/signing stays server-side (where the secret lives).
- **Cross-language parity is locked by a shared known-answer fixture**
  (`tests/fixtures/audit/kat-bundle.json`, generated by the server's
  `buildAuditBundle`): the server (a new anchor test in `tests/unit/audit.test.js`)
  and all three SDKs verify the same bundle and assert the same `content_digest`
  + `signature` constants. Tamper cases (payload mutation, reorder, drop, manifest
  edit, wrong secret, version downgrade, bad alg) are covered in each SDK.
- No new CI job (the existing per-SDK jobs run the new tests). Server suite: 210
  unit + 135 integration. Python +13, Go +10, Node +9 unit tests.

---

## Data-residency region labels (Phase 14 PR-G) — 2026-06-12

Phase 14 (Compliance & Audit Suite) PR-G: data-residency **controls** (PRD
§Phase 14). Deliberately scoped to *declaration + mismatch detection*, not
storage routing.

- **`projects.region`** (migration `005_data_residency.js` + Postgres `SCHEMA_DDL`
  CREATE column + idempotent `ADD COLUMN IF NOT EXISTS`): a project declares the
  region its data should reside in — `EU` / `US` / `APAC` / `global` — via
  `POST /admin/projects { region }`. Nullable (unspecified). Invalid → 400.
- **`DATA_RESIDENCY_REGION`** env declares where this deployment's storage actually
  is. Project responses now include `region` + **`regionEnforced`** — true only
  when the deployment's region satisfies the project's declared region (or it asks
  for none/`global`). A `false` flag tells an operator the data is **not**
  physically in the required region.
- **`src/regions.js`:** pure `normalizeRegion` / `isValidRegion` /
  `getDeploymentRegion` / `isRegionEnforced`.
- **Audit bundles:** when `DATA_RESIDENCY_REGION` is set, exported bundles record
  `data_residency_region` in their **signed manifest** (added only when set, so
  bundles from deployments without it are byte-identical to before).
- **Honest scope (documented in `.env.example`):** AEP does **not** route storage
  by region — a single deployment writes to one backend. Real multi-region routing
  (per-region ingest endpoints/storage) is infrastructure, out of scope. This PR
  delivers the residency *control surface*, not the routing.
- **Docs:** OpenAPI (`region`/`regionEnforced` on the project schema + the create
  body); CHANGELOG; `.env.example`.
- **Tests:** `tests/unit/regions.test.js` (11) + 6 integration cases (store/return
  region, omitted→null+enforced, invalid→400, regionEnforced vs deployment region,
  GET project, audit-bundle manifest residency on/off). No new CI job. 207 unit +
  135 integration green.

---

## Compliance report templates (Phase 14 PR-F) — 2026-06-12

Phase 14 (Compliance & Audit Suite) PR-F: pre-built **compliance report
templates** for SOC 2, HIPAA, GDPR, and the EU AI Act (PRD §Phase 14). Each maps
AEP's live evidence onto the framework's control areas.

- **`src/compliance.js`:** pure `generateComplianceReport(framework, evidence,
  { now, scope })`. Four frameworks, each control's status (`satisfied` /
  `partial` / `unmet`) **derived from real evidence** — HMAC-signed audit bundles
  + signature config (integrity), the API-key access log (audit trail), policy.blocked
  analytics (enforcement / human-oversight), tenant isolation + key scopes (access
  control), the retention policy (storage limitation), and the causation-linked
  event store (record-keeping / traceability). Carries an honest `disclaimer`: it
  maps technical controls, it is not a certification. Defensive evidence defaults;
  deterministic via injected `now`.
- **`GET /compliance/report`** (read + tenant-scoped): `?framework=` (required) +
  optional `?session=`/`?trace=` integrity proof-point (a bundle for that scope is
  built and verified), `?since`/`?until` window for the enforcement evidence, and
  `?format=json|pdf`. Invalid/missing framework → 400; both session+trace → 400.
- **`src/compliance-pdf.js`:** human-readable PDF rendering (deterministic, built-in
  fonts), mirroring the audit-bundle PDF renderer.
- **CLI:** `aep compliance report --framework <id> [--session|--trace] [--since
  --until] [--json|--out|--pdf]` — a colour summary, raw JSON, or a locally
  rendered PDF.
- **Docs:** OpenAPI path + `Compliance` tag; CHANGELOG.
- **Tests:** `tests/unit/compliance.test.js` (16 — framework validity, evidence-
  driven status, summary tally, defaults, determinism) + 12 integration cases (all
  four frameworks, 400s, signing-on/off integrity, EU-AI-Act oversight, PDF). No
  new CI job. 196 unit + 128 integration green.

---

## API-key access logs (Phase 14 PR-E) — 2026-06-12

Phase 14 (Compliance & Audit Suite) PR-E: a full **API-key usage audit trail**
(PRD §Phase 14 "Access logs") — record what each key did, when, and the outcome.

- **Opt-in via `ACCESS_LOG_ENABLED`** (truthy = on; OFF by default). When on, each
  key-authenticated request is recorded: api_key_id, tenant, HTTP method, URL
  **path only** (never the query string — so `/stream?token=…` secrets aren't
  persisted), response status, timestamp. Off by default so the ingest hot path
  takes no extra per-request write.
- **`src/middleware/accessLog.js`:** records on `res.on("finish")`,
  fire-and-forget with errors swallowed — never adds latency to, or fails, the
  observed request. Only requests that resolved to an API key are logged
  (admin-token and keyless dev reads are skipped).
- **`GET /admin/keys/:id/access-log`** (admin-scoped): most-recent-first records
  for a key with `since` (inclusive) / `until` (exclusive) ISO-8601 window +
  `limit` (1–1000, default 100). Returns `{ api_key_id, key_prefix, enabled,
  total, entries, window }`; `enabled` distinguishes "logging off" from "key
  unused". 404 for an unknown key; non-ISO since/until → 400.
- **Schema:** new `api_key_access_log` table — SQLite migration `004_access_logs.js`
  + mirrored in the Postgres `SCHEMA_DDL`. Backend methods `recordApiKeyAccess` /
  `getApiKeyAccessLog` on the interface + both backends; shared `formatAccessLogRow`
  helper keeps the two byte-identical (covered by the Postgres parity CI job).
- **Docs:** OpenAPI path; `AUTH.md` + `.env.example` document `ACCESS_LOG_ENABLED`.
  Caveat: access-log rows are not pruned by the retention job (manage growth at
  the storage layer) — a candidate for a later PR.
- **Tests:** `tests/unit/accessLog.test.js` (env-gate parsing) + 8 integration
  cases (opt-in off-by-default, ingest+read recording, ordering, path has no
  query string, since/until/limit, 400/404, admin auth). No new CI job. 180 unit
  + 115 integration green.

---

## Policy-enforcement analytics (Phase 14 PR-D) — 2026-06-12

Phase 14 (Compliance & Audit Suite) PR-D: `policy.blocked` event analytics — the
compliance view of *what did the agent refuse to do, and when?* (PRD §Phase 14;
delivers the "policy.blocked analytics dashboard live" success criterion).

- **`GET /analytics/policy-blocked`** (read-scoped + tenant-scoped, like `/metrics`):
  returns `total`, ranked breakdowns `by_policy` / `by_action` / `by_source`, a
  per-day `by_day` series (the date prefix of `event.time`), and a `recent` list.
  Optional query params: `since`
  (inclusive) / `until` (exclusive) ISO-8601 time window, and `limit` (1–1000,
  default 20) for the `recent` list. Non-ISO `since`/`until` → 400; repeated params
  are coerced last-wins by the shared `validateQueryParams` middleware.
- **`src/analytics.js`:** new pure `summarizePolicyBlocked(events, { now, limit })`
  — no I/O, unit-testable against fabricated events. Missing/blank `policy` /
  `action_blocked` / `source` fold into an explicit `(unspecified)` bucket so every
  breakdown's counts sum to `total`; ties break alphabetically (deterministic).
- **Storage:** new `getPolicyBlockedEvents(tenantId, { since, until })` on the
  StorageBackend interface + both backends (SQLite null-guard fixed SQL; Postgres
  dynamic `$n`). Aggregation stays in the pure summarizer, so the SQL is trivial
  and dialect-identical (no `json_extract` vs `->>` divergence).
- **CLI:** `aep analytics policy-blocked [--since --until --limit --json]` — a
  human-readable summary or raw JSON.
- **Dashboard:** new "Policy Analytics" tab in `src/public/dashboard.html` —
  ranked bars (policy / action / source), a per-day bar chart, a recent list, and
  since/until filters. Read via the existing token flow.
- **Docs:** OpenAPI path + `Analytics` tag added to `src/openapi.json`.
- **Tests:** `tests/unit/analytics.test.js` (15 cases for the summarizer) + 8
  integration cases appended to `tests/integration/server.test.js` (aggregation,
  window bounds, limit, auth, 400 on bad params, last-wins coercion). No new CI
  job (drift-guard untouched). 176 unit + 107 integration green.

---

## Centralized array-valued query-param handling — 2026-06-11

Follow-up to #93 (closes #94). Repeated query params (`?type=a&type=b`) are
parsed by Express as arrays; passed to a string method or a DB binding they throw
→ HTTP 500. #93 patched the two affected routes with inline `typeof` guards; this
change moves the handling into the shared `validateQueryParams` middleware so any
route that uses it is protected by default, and removes the per-route guards.

- **`src/middleware/queryValidation.js`:** new `coerceArrayParams(query)` —
  reduces every array-valued param to its **last** value (last wins), pure (returns
  a new object). `validateQueryParams` applies it **first**, before the existing
  length/format checks, so they (and the route handlers) only ever see scalars.
  Because Express 5's `req.query` is a getter-only accessor that re-parses on each
  access (in-place mutation and reassignment are silently lost), the coerced object
  is installed as an own data property via `Object.defineProperty`.
- **`src/server.js`:** `/sessions/:sessionId/export` now runs `validateQueryParams`,
  and the inline `typeof` guards added in #93 are removed from both `/export` and
  `/sessions/:sessionId/events` (the middleware guarantees scalars). `format` on
  `/export` reverts to `(req.query.format || "json").toLowerCase()`.
- **Behaviour change (deliberate):** a repeated filter now resolves to its **last
  value** rather than #93's "treat as absent / no filter" — e.g.
  `?format=json&format=csv` exports CSV, `?type=x&type=task.created` filters by
  `task.created`. Routing `/export` through the middleware also gives it the same
  query-length **400** DoS guards `/events` already had; `/export` ignores
  cursor/limit, so a *valid* one is a no-op, but an *invalid* `?cursor=`/`?limit=`
  now 400s instead of being silently ignored.
- **Out of scope:** the audit-bundle routes (`/sessions/:id/audit-bundle`,
  `/workflows/:traceId/audit-bundle`) keep their inline `format` guard in
  `sendAuditBundle` — they don't take `validateQueryParams`, and `format` there is
  already array-safe. A future option (an app-level custom query parser to protect
  routes that don't use the middleware) is noted in #94 but not done here.
- **Tests:** new `tests/unit/queryValidation.test.js` (8 cases for
  `coerceArrayParams`); the #93 integration tests are reworked to last-wins
  semantics; new integration cases for `/export` last-wins CSV, the new `/export`
  query-length + invalid-cursor/limit 400s, a `/sessions` repeated-`cursor` case
  (proving a route with no inline guard is covered centrally, and that coercion
  runs before validation), and a prototype-pollution probe. Lint clean. No new CI
  jobs.

## Phase 14 PR-C — Audit bundle PDF rendering — 2026-06-11

Completes the PRD's "PDF + JSON" audit-export deliverable. A bundle built by
PR-A/PR-B can now be rendered as a human-readable PDF report for legal /
compliance review. The PDF is a *rendering only* — the JSON bundle remains the
tamper-evident, offline-verifiable artifact — and the report keeps that honest
by printing the bundle's `content_digest`, the manifest signature, and the
verification result it was rendered with.

- **New module [`src/audit-pdf.js`](./src/audit-pdf.js)** —
  `renderAuditBundlePdf(bundle, { verification, now })` → `Promise<Buffer>`,
  built on **pdfkit** (new runtime dependency; pure JS, no install scripts, no
  new `npm audit` findings). Deterministic: `now` is injected (pdfkit's default
  CreationDate is a clock read that perturbs the PDF trailer `/ID` — pinning it
  makes identical inputs render **byte-identical PDFs**, which is regression-
  locked by a unit test). The `verification` result (from `verifyAuditBundle`)
  is an *input*, so the renderer never handles key material — the report states
  VALID, INVALID - TAMPERING DETECTED, or NOT VERIFIED AT RENDER TIME, exactly
  as given. Report sections: manifest summary (scope, tenant, counts, time
  range, digest, signature), verification status, per-event blocks (envelope
  fields, transport-signature presence/canon, deep-stable payload JSON
  truncated at 2,000 chars with an explicit marker), and a how-to-verify
  appendix. Content streams are uncompressed (diffable/inspectable); text is
  sanitized to printable ASCII for legibility — lossy by design, the JSON
  bundle is the record.
- **CLI** ([`src/cli.js`](./src/cli.js)):
  - `aep audit render <bundle.json> [--out report.pdf] [--force]` — verifies the
    bundle first and **refuses to render an unverifiable bundle** unless
    `--force` (the report then shows INVALID prominently and the command exits
    non-zero). Output defaults to the bundle path with a `.pdf` extension; the
    command refuses to overwrite the bundle itself.
  - `aep audit export … --pdf [file]` — writes a PDF companion **alongside**
    the JSON bundle (never instead of it). Filename derived from `--out`
    (`bundle.json` → `bundle.pdf`) unless given explicitly; an explicit name is
    required when the JSON goes to stdout. (Flag-parser note: place `--pdf`
    after the session id or give it a value — documented in `aep audit --help`.)
- **HTTP** ([`src/server.js`](./src/server.js)): `?format=pdf` on
  `GET /sessions/:sessionId/audit-bundle` and
  `GET /workflows/:traceId/audit-bundle` (shared `sendAuditBundle` helper).
  Auth / tenant-scoping / 404 / 503 guards are untouched — the format branch
  runs strictly after all of them. Unrecognized `format` values fall back to
  JSON, mirroring `/export`. The server verifies the freshly built bundle for
  real (cheap) rather than asserting validity, so the PDF's verification
  section reports an actual check. `application/pdf` + `.pdf` attachment
  filename.
- **OpenAPI** ([`src/openapi.json`](./src/openapi.json)): `format` query param
  (enum `json`/`pdf`, default `json`) + `application/pdf` response content on
  both audit-bundle paths.
- **Tests:** `tests/unit/audit-pdf.test.js` (17 tests: PDF structure,
  verification honesty incl. tampered-bundle rendering, payload truncation /
  ASCII sanitization, byte-determinism, no-mutation purity, input validation —
  content assertions decode pdfkit's hex `TJ` text operators back to plain
  text) and 5 integration tests appended to `tests/integration/server.test.js`
  (PDF happy path for both endpoints, JSON fallback for unrecognized format,
  404/503 guards unchanged under `?format=pdf`). No new CI jobs.
- **Docs:** AUTH.md (render/`--pdf`/`?format=pdf` usage + rendering-vs-artifact
  caveat), README.md, SECURITY.md (the PDF carries no integrity guarantee of
  its own).

## Phase 14 PR-B — Audit-bundle HTTP endpoints — 2026-06-11

Builds on Phase 14 PR-A (tamper-evident audit bundles, `src/audit.js` + `aep
audit` CLI). Exposes audit bundles over HTTP so operators and tooling can pull a
signed bundle directly, without the CLI.

- **New `GET /sessions/{sessionId}/audit-bundle`** — builds and returns an
  HMAC-signed audit bundle of a session's events.
- **New `GET /workflows/{traceId}/audit-bundle`** — same, scoped to every session
  sharing a `trace_id` (events combined and ordered by time).
- Both endpoints are **read-scoped** and **tenant-scoped**, mirroring the existing
  `/sessions/{id}/export` and `/workflows/{traceId}` query endpoints. They reuse
  `buildAuditBundle` from PR-A (no new bundle/signing logic) and inject `now` at
  the request boundary so `src/audit.js` stays pure.
- **Requires `AUDIT_SIGNING_SECRET`** (the server-side audit signing key, distinct
  from per-API-key HMAC secrets). When unset, both endpoints return **503** with an
  actionable hint — mirroring how `/admin/*` behaves when `ADMIN_TOKEN` is unset.
- `404` when the scope (session or trace) does not exist for the caller's tenant;
  an existing scope with zero events yields an empty — but still signed — bundle.
- Responses are returned as a JSON download (`Content-Disposition: attachment`) and
  verify offline via `aep audit verify` / `verifyAuditBundle`.
- No schema changes, no new storage-layer methods, and **no new CI job** — the new
  integration coverage runs under the existing test + Postgres-parity jobs.
- OpenAPI spec updated with both paths and an `AuditBundle` schema.

---

## Python SDK `agent-event-protocol` 0.4.1 — 2026-06-10

Docs / source-comment patch. **No functional, signing, or API changes.**

- **Fixed broken links on the PyPI project page** (`../../README.md` →
  absolute GitHub URL, `demos/subagent_research.py` → absolute GitHub URL).
- **Corrected stale v1/v2 compatibility note** in the README: the current server
  *requires* v2 and *rejects* legacy v1 with `401` (issue #65 complete and
  closed); the old wording implied the server still accepted v1.
- **Corrected stale source comments** in `_signature.py` (and the Node / Go SDK
  source files) that said "the server keeps accepting v1 during the transition" —
  updated to reflect issue #65 retirement.

Upgrade with `pip install --upgrade agent-event-protocol`. No code changes are
required for existing users.

---

## Python SDK `agent-event-protocol` 0.4.0 — 2026-06-09

Maintenance release of the Python SDK. **No functional or signing changes** —
0.3.0 already signs the payload-covering **v2** canonical form by default and is
fully compatible with the v2-only server (issue #65). This release only:

- Declares **Python 3.13** support (trove classifier; 3.13 has been exercised in
  CI since #73).
- Verified end-to-end against the v2-only server: default `sign_event(event, secret)`
  emits `signature.canon:"v2"` → `202 Accepted`; an explicit `canon="v1"` → `401`.

Upgrade with `pip install --upgrade agent-event-protocol`. No code changes are
required for existing users.

---

## ⚠️ BREAKING — legacy v1 signature path removed — issue #65 Phase E, 2026-06-09

The **final cleanup** of the v1 per-event-signature retirement (closes #65).
Phase D made the server *reject* v1 by default while keeping the v1 code path and
an escape hatch; Phase E **removes** them entirely. The server now accepts
**only** payload-covering **v2** signatures and there is no longer any way to
re-accept v1.

**Removed (BREAKING):**

- **The legacy v1 canonical form** (`canonicalize`, envelope-only — payload NOT
  covered) and the unmarked **transition mode** that tried both forms. A signed
  ingest is now accepted **iff** `signature.canon === "v2"` **and** the deep HMAC
  verifies. A v1 marker, an absent marker, an unmarked-but-deep-valid signature,
  or any non-`v2` marker → `401` with the actionable message
  *`Signature must use canon:"v2" (payload-covering). Set canon:"v2" or upgrade your AEP SDK.`*
- **The `REQUIRE_CANON_V2` environment variable** (incl. the `=false` / `0` / `no`
  / `off` escape hatch). It is gone — setting it has **no effect**; v1 is always
  rejected. The `verifySignature(event, secret)` call is now unconditional (the
  `requireCanonV2` option was removed).
- **The `SIGNATURE_V1_SUNSET` environment variable** and the RFC 8594
  `Deprecation` / `Sunset` / `Link` response headers (`buildDeprecationHeaders` /
  `V1_DEPRECATION_LINK`). Those fired only on *accepted* v1 ingest, which can no
  longer happen.

**Notes:**

- **Server-only — the SDKs are unchanged.** The published SDKs already default to
  v2 (npm `@surpradhan/aep` >= 0.4.0, PyPI `agent-event-protocol` >= 0.3.0, Go
  `sdks/go` >= 0.3.0). An SDK's explicit `canon:"v1"` option still exists but the
  server will now simply reject what it emits.
- **Metrics unchanged:** the Phase A `aep_signature_verifications_total{form,marked}`
  / `_rejected_total` counters still work (accepted `form` is now always `"v2"`).
- **No `specversion` bump** — this is a server acceptance-policy change, not an
  envelope-schema change.
- **Audit bundles are unaffected** — `src/audit.js` already uses the deep v2 rule
  (`stableStringify` / `canonicalizeV2`).

---

## ⚠️ BREAKING — v1 signatures rejected by default — issue #65 Phase D, 2026-06-09

The **deliberate breaking cutover** of the v1 signature deprecation. The server
now **rejects legacy v1 (envelope-only) per-event signatures by default** and
requires the payload-covering **v2** form. Phase C added this enforcement as
opt-in; Phase D flips the **default** to strict.

**Rationale:** the v2-default SDKs are published (npm `@surpradhan/aep`, PyPI
`agent-event-protocol`, Go `sdks/go`), so emitters already sign `canon:"v2"`, and
there are no real v1 users yet — so the deprecation window is closed today.

- **`REQUIRE_CANON_V2` now defaults to ON.** Unset / empty / any value that is
  not an explicit opt-out → **strict** (reject v1). Only the case-insensitive
  values `false` / `0` / `no` / `off` → transition mode. Re-read per request.
- **What changes:** a v1-signed (or unmarked, or non-`v2`) event on a key with an
  HMAC secret now gets a `401` with the actionable message
  *`Strict mode requires canon:"v2". Upgrade to a v2-default AEP SDK or set canon:"v2".`*
  (SDK-agnostic — the v2-default release is npm >= 0.4.0, PyPI/Go >= 0.3.0).
  v2-signed events are accepted (`202`) as before. Unsigned events on keys with
  **no** HMAC secret are unaffected.
- **Escape hatch (to keep accepting v1 temporarily):** set **`REQUIRE_CANON_V2=false`**
  (or `0`/`no`/`off`). This restores the exact pre-Phase-D transition mode — v1
  **and** v2 accepted, with the Phase B `Deprecation`/`Sunset` headers on accepted
  v1 ingest. The v1 code path and this escape hatch are retained; removing them is
  Phase E.
- **Effective sunset:** today (2026-06-09). A strict `401` is a hard rejection, so
  it carries **no** `Deprecation`/`Sunset` headers (those fire only on *accepted*
  v1, i.e. only under `REQUIRE_CANON_V2=false`).
- **Metrics:** default-strict v1 rejections increment the existing
  `aep_signature_verifications_rejected_total` counter (Phase A) — no new metric.
- **No `verifySignature` logic change** (Phase C already implemented the strict
  path), **no SDK changes**, **no `specversion` bump** (this is a server behaviour
  change, not an envelope-schema change). Server-only.
- **Docs:** `CHANGELOG.md`, `AUTH.md` (canonicalization-versions + verification-
  errors + strict-mode sections), `SECURITY.md`, `OPERATIONS.md`, `.env.example`.

---

## Opt-in strict signature mode — issue #65 Phase C, 2026-06-09

The **third** step toward retiring the legacy v1 (envelope-only) signature form,
and the first that can *reject* it — but only when an operator opts in. Default
behaviour is **unchanged** (transition mode; v1 and v2 both accepted).

- **New env var `REQUIRE_CANON_V2`** (`true`/`1` → on; anything else/unset →
  off). When **on**, the server accepts a per-event signature **iff** it carries
  an explicit `canon:"v2"` marker **and** verifies against the deep,
  payload-covering form. Legacy `canon:"v1"`, **unmarked** signatures (even ones
  that would verify deep, e.g. a pre-v0.3.0 Go emitter), and any non-`v2` marker
  are rejected with `401` and an actionable error. Off by default → no behaviour
  change.
- **No deprecation headers on a strict reject.** A strict `401` is a hard
  rejection (not an *accepted* v1 ingest), so it carries no RFC 8594
  `Deprecation`/`Sunset` headers. Strict rejections increment the existing
  `aep_signature_verifications_rejected_total` counter (Phase A).
- **Independent of `SIGNATURE_V1_SUNSET`.** Reaching the sunset date does **not**
  auto-enable strict mode; enabling it is an explicit operator decision.
- **Verifier change:** `verifySignature(event, secret, { requireCanonV2 })` — the
  policy lives in one unit-testable place; the only caller that opts in is the
  server (via the env). Other callers are unaffected.
- **Docs:** `AUTH.md` (env table, verification-errors table, strict-mode section
  with the accept/reject matrix), `SECURITY.md`, `.env.example`.
- **Scope:** Phase C (opt-in strict); non-breaking by default. The global
  **default** flip to strict (breaking) is Phase D, and v1 cleanup is Phase E —
  both deferred. Tracked in issue #65.

---

## Signature v1 deprecation signaling — issue #65 Phase B, 2026-06-09

The **second, non-breaking** step toward retiring the legacy v1 (envelope-only)
signature form. Building on Phase A's observability, the server now *signals* the
deprecation to emitters via standard HTTP headers. Nothing is rejected — v1
events are still accepted; transition mode is unchanged.

- **RFC 8594 deprecation headers on accepted v1 ingest.** When an *effective-v1*
  signature is accepted, the success response (`202`, or `200` for a duplicate)
  carries:
  - `Deprecation: true` — always.
  - `Link: <…/issues/65>; rel="deprecation"` — points at the rationale.
  - `Sunset: <IMF-fixdate>` (RFC 7231, e.g. `Sun, 06 Sep 2026 00:00:00 GMT`) —
    **only** when `SIGNATURE_V1_SUNSET` is configured.
  v2-signed, unsigned, and rejected requests get **no** deprecation headers.
- **New env var `SIGNATURE_V1_SUNSET`** (ISO-8601 date) — the future date after
  which v1 will be rejected (Phase D); drives the `Sunset` header. Unset → no
  `Sunset` header (default, no committed date yet). A set-but-unparseable value
  logs a startup warning and is treated as unset (no malformed header, no crash).
- **Pure, unit-tested header builder** (`buildDeprecationHeaders`) so the header
  values are verifiable without HTTP.
- **Docs:** `AUTH.md` (deprecation note + env table), `SECURITY.md` (v1→v2
  pointer), `.env.example`.
- **Scope:** Phase B (signaling only); non-breaking, **v1 still accepted**. Later
  phases C–E (opt-in strict mode, default strict, cleanup) are deferred. Tracked
  in issue #65.

---

## Signature canonicalization observability — issue #65 Phase A, 2026-06-08

The **first, non-breaking** step toward retiring the legacy v1 (envelope-only)
signature form. Before the server can stop accepting v1, we must be able to
*measure* who is still emitting it — this PR adds exactly that telemetry and
nothing breaking. Transition mode is unchanged: the server still accepts v1, v2,
and unmarked signatures.

- **`verifySignature` now reports the effective canonical form.** On success it
  returns `{ valid: true, canon: "v1" | "v2" }` — the form that *actually*
  verified, independent of any `signature.canon` marker (in transition mode an
  unmarked signature is classified by whichever form matched). Existing callers
  reading only `.valid`/`.error` are unaffected.
- **New Prometheus counters** (`GET /metrics/prometheus`):
  - `aep_signature_verifications_total{form="v1"|"v2",marked="true"|"false"}` —
    accepted signatures by effective form; `marked` = whether a `signature.canon`
    field was present.
  - `aep_signature_verifications_rejected_total{marked="true"|"false"}` —
    signature verification failures (effective form unknown on failure).
  - Labels are intentionally low cardinality — **no** tenant/source/key labels.
- **Per-tenant attribution via logs, not metric labels.** The first legacy-v1
  ingest per tenant is logged at `info` with `tenant_id` + `source`; subsequent
  ones drop to `debug` (bounded first-seen set) to avoid log spam.
- **JSON `GET /metrics`** now includes a `signatures` block mirroring the counters.
- **Scope:** Phase A (observability only); non-breaking. Later phases B–E
  (deprecation headers, opt-in strict mode, default strict, cleanup) are deferred.
  Tracked in issue #65.

## Python SDK `agent-event-protocol` 0.3.0 — first PyPI release (v2-default signatures), 2026-06-08

The **first actual PyPI release** of the Python SDK, bumping `0.2.0` → `0.3.0`.
The SDK has been usable from source (`pip install -e`) all along but was never
published; this packages the issue #59 v2-default signature work for PyPI.

- **Distribution name is `agent-event-protocol`** (matches the project's full
  name and GitHub repo). The bare `aep` name was already taken on PyPI, so the
  distribution name spells the project out while the **import name stays `aep`** —
  users `pip install agent-event-protocol` then `import aep`. This is a one-way
  door once published.
- **v2 (deep) signature canonicalization is the default** (carried in from #66 /
  issue #59): `sign_event(event, secret)` produces a deep, payload-covering
  signature with a `signature.canon: "v2"` marker, and the auto-signing
  `AEPClient` / `AsyncAEPClient` emit v2 automatically. Pass `canon="v1"` for the
  legacy envelope-only form. **Compatibility:** a v2-default emitter requires a
  v2-aware AEP server (server PR #60+); the server still accepts v1 during the
  transition.
- **Packaging:** complete PyPI metadata (authors, project URLs, keywords,
  classifiers for Python 3.10–3.12 + MIT) and a tag-triggered
  `release-python-sdk.yml` release workflow — `python-sdk-v*` tag → `verify`
  (ancestry + build + `pytest`) → required-reviewer `pypi-publish` environment →
  Trusted Publishing (OIDC, no API token). No version bump of the protocol or
  other SDKs.

## Go SDK — monorepo module path + first release (`sdks/go/v0.3.0`), 2026-06-08

Makes the **Go SDK** actually `go get`-able for the first time. It shipped the
issue #59 v2-default signature work but was never published — its `go.mod`
declared `module github.com/surpradhan/aep-go`, a repository that **does not
exist**, so the module could only be consumed via a local `replace` directive.

- **Module path migrated** `github.com/surpradhan/aep-go` →
  `github.com/surpradhan/agent-event-protocol/sdks/go` (Option B: a subdirectory
  module of this monorepo — single source of truth, no mirror repo to sync). All
  internal imports across `sdks/go/` (and the `otelbridge` module's `require` /
  `replace` / imports, which depend on the SDK via the local path) were updated
  accordingly.
- **Consumer migration** (the old path never resolved, so no real consumers
  break):
  - `go get github.com/surpradhan/agent-event-protocol/sdks/go@latest`
  - `import "github.com/surpradhan/agent-event-protocol/sdks/go/aep"`
- **Releasing is by Git tag only** — Go has no registry upload/token. Subdirectory
  modules use the path-prefixed tag convention `sdks/go/vMAJOR.MINOR.PATCH`; the
  module proxy fetches from GitHub on demand. **`v0.3.0` is the first real tag**
  (aligns with the v2-default milestone). A tag-triggered, non-publishing
  `release-go-sdk.yml` smoke gate (ancestry + `go build`/`go test`) was added; it
  is not a required PR check. See the Go SDK README "Releasing" section.
- No protocol or behaviour change; no change to the required CI checks (the
  existing `Go SDK unit tests` job still gates PRs).

## Node SDK `@surpradhan/aep` 0.4.0 — v2-default signatures (release), 2026-06-08

Release of the issue #59 signature work for the Node SDK (npm `@surpradhan/aep`),
bumping `0.3.0` → `0.4.0`. Cut by pushing a `node-sdk-v0.4.0` tag (verify →
required-reviewer approval → `npm publish --provenance`).

Since 0.3.0:
- **v2 (deep) signature canonicalization is now the DEFAULT** (#66). `signEvent`
  produces a deep, payload-covering signature with a `signature.canon: "v2"`
  marker, so payload tamper-evidence is on without opt-in.
- v2 signing was first added as opt-in in #61; `verifySignature` is version-aware
  (honours `canon`; absent → transition mode accepting either form).
- **Behaviour change:** the default signature bytes differ from 0.3.x (v1,
  envelope-only) and now carry a `canon` marker. v1 remains available via
  `signEvent(event, secret, { canon: "v1" })`. **Compatibility:** a v2-default
  emitter requires a v2-aware AEP server (one including server PR #60+); the
  server still accepts v1 during the transition.

## All SDKs: v2 (deep) signature canonicalization is now the DEFAULT (issue #59), 2026-06-08

**Behaviour change** — the final functional step of issue #59. With all three SDK
emitters (Node, Python, Go) and the server already supporting v2, the signing
**default** flips from v1 (envelope-only) to **v2** (deep, payload-covering). New
signatures cover nested payloads and carry a `signature.canon: "v2"` marker
without opt-in, so payload tamper-evidence is on by default.

- **Node SDK** (`sdks/node/src/signature.ts`): `signEvent(event, secret)` now
  defaults to `canon: "v2"`. Pass `{ canon: "v1" }` for the legacy envelope-only
  form.
- **Python SDK** (`sdks/python/aep/_signature.py`): `sign_event(event, secret)`
  now defaults to `canon="v2"`. Pass `canon="v1"` for the legacy form. The
  auto-signing `AEPClient` / `AsyncAEPClient` therefore emit v2 automatically.
- **Go SDK** (`sdks/go/aep/signature.go`): `SignEvent(event, secret)` now defaults
  to v2. New `SignEventV1` convenience signs the legacy envelope-only form;
  `SignEventV2` / `SignEventWithCanon` unchanged.
- **Cross-language parity preserved:** the shared v2 known-answer vector
  (`M3OGzpZ4+SX0MStNZ0wJtb+TV+h/xcy9yPIRC0VaoJQ=`) is now produced via the default
  signing path; the v1 known-answer (`zPZDN4bGfJF4MJlyWu9HQXpkr5SlaqOAD9JUEj3Sev0=`)
  is now produced via an explicit `canon="v1"` call. Both stay locked by tests.
- **Verifiers unchanged.** `verifySignature` in every SDK and the server stays
  version-aware (honours `canon`; absent → transition mode accepting either form).

**Compatibility:** a v2-default emitter requires a v2-aware server (server PR #60+,
i.e. one with version-aware verification). Older servers predating
`signature.canon` support would reject v2 — talk to them with the explicit v1 form.

**Out of scope (deferred):** the server still runs **transition mode** and keeps
accepting v1; it is *not* changed to require v2 here. No SDK version bumps / no
npm or PyPI publish. Hard-retiring v1 (server requiring `canon: "v2"`) is a
separate later breaking change tracked in its own issue.

---

## Go SDK: opt-in v2 (deep) signature canonicalization + v1 interop fix (issue #59), 2026-06-08

**SDK feature + interop fix** — the third (and final SDK) emitter migration toward
the unified deep canonical form (after the Node and Python SDKs). The server
already verifies v2.

- **`sdks/go/aep/signature.go`:**
  - New `canonicalFormV2` — deep canonical form (recursive key sort covering
    nested payloads). **Byte-identical to the server, Node, and Python SDKs** for
    JSON values shared across runtimes (locked by the *same* server-derived
    known-answer vector as the Node/Python tests).
  - New ECMAScript `Number`-to-string formatter (`ecmaFormatFloat`) so v2 float
    bytes match `JSON.stringify` (Node/server) across exponent ranges — replacing
    the previous `%.0f`/`FormatFloat 'f'` rendering that diverged for non-integer
    floats. Documented and locked by `TestECMANumberFormatting`.
  - New custom string serializer (`ecmaQuote`) for canonical string values AND
    object keys, replacing `encoding/json` which HTML-escapes `<`, `>`, `&` by
    default and escapes U+2028/U+2029 even with `SetEscapeHTML(false)`. `ecmaQuote`
    emits those raw (matching `JSON.stringify` / Python `json.dumps(ensure_ascii=
    False)`), so canonical bytes — and thus signatures — agree cross-runtime for
    events whose envelope or payload contains those characters (common: URLs with
    `&`, `&&`/`<`/`>` in code, HTML). Locked by `TestEcmaQuote` and server-derived
    special-character known-answer vectors (v1 envelope + v2 payload).
  - `SignEvent(event, secret)` — still the default, now signs the shared **v1**
    (shallow, envelope-only) form. New `SignEventV2` / `SignEventWithCanon` opt
    into v2 (deep) and add a `signature.canon: "v2"` marker.
  - `VerifySignature` is now **version-aware**: honours `signature.canon`
    (`"v2"`→deep, `"v1"`→shallow, absent→transition mode accepting either),
    rejects unknown markers via `ErrValidation`, and never panics (bad base64 →
    plain mismatch) — mirroring the server.
  - **Two interop fixes (BEHAVIOUR CHANGE for existing Go signers):**
    1. **Encoding** — `signature.value` is now **base64** (was hex). Hex never
       verified on the server/Node/Python (everyone else uses base64).
    2. **Canonical form** — v1 is now the shared **shallow** form (was a bespoke
       *deep* form). Combined with the hex encoding, the old Go output matched
       neither v1 nor v2 and was non-interoperable in practice, so no
       cross-language consumer relied on it.
  - `Signature` gains an optional `Canon` field (`json:"canon,omitempty"`).
- **Tests (`sdks/go/aep/signature_v2_test.go`):** lock Go **v1** and **v2** to the
  shared cross-language known-answer vectors (`zPZD…` / `M3OG…`); prove v2 detects
  nested-payload tampering, v1 is envelope-only, version honouring (v2 digest
  declared `v1` → reject), transition mode (unmarked deep/v1 → accept), unknown
  canon → reject (sign + verify), and bad-base64 → mismatch (no panic). Added
  **special-character** known-answer vectors (`<`, `>`, `&`, U+2028/U+2029,
  control chars, astral emoji — v1 envelope + v2 payload) and a `TestEcmaQuote`
  unit test, both locked to server-derived values.
- **Cross-verified end-to-end:** a Go-signed v2 event verifies on the server, its
  nested-payload tamper is detected, an unmarked deep sig is accepted (transition
  mode), a mislabelled-`v1` deep sig is rejected; a Go-signed v1 event also
  verifies on the server.
- **Docs:** `sdks/go/README.md` documents v1 vs v2, `SignEventV2`, and the interop
  behaviour change.
- **No default change for the protocol** (v1 stays the SDK default). Flipping the
  default to v2 and retiring v1 remains tracked in issue #59. No module/tag bump.

## Python SDK: opt-in v2 (deep) signature canonicalization (issue #59), 2026-06-07

**SDK feature, additive, non-breaking** — the second emitter migration toward the
unified deep canonical form (after the Node SDK). The server already verifies v2.

- **`sdks/python/aep/_signature.py`:**
  - New `canonicalize_v2(event)` — deep canonical form via
    `json.dumps(..., sort_keys=True, separators=(",",":"), ensure_ascii=False)`
    (recursive key sort covering nested payloads). **Byte-identical to the server
    and Node SDK** for JSON values shared across runtimes (verified by a
    server-derived known-answer vector — the *same* vector as the Node SDK test).
  - `sign_event(event, secret, *, canon="v1")` — `canon` defaults to `"v1"`
    (unchanged, envelope-only); `canon="v2"` signs the deep form and adds a
    `signature.canon: "v2"` marker so payload tampering is detectable.
  - `verify_signature` is now **version-aware**: honours `signature.canon`
    (`"v2"`→deep, `"v1"`→shallow, absent→transition mode accepting either),
    rejects unknown/non-string markers without raising — mirroring the server.
  - `canonicalize_v2` exported from `aep`.
- **Tests:** existing v1 behavior preserved unchanged; new tests lock the Python
  **v2** form to the shared server-derived known-answer, prove v2 detects nested
  payload tampering, and cover version honouring / transition mode / unknown +
  non-string markers. Cross-verified end-to-end: a **Python-signed v2 event
  verifies on the server** and the server detects its payload tampering.
- **Docs:** `sdks/python/README.md` documents v1 vs v2 and the `canon` option.
- **No default change, no breaking change** (v1 stays the default; the auto-signing
  client still signs v1; the Go emitter still signs v1). Flipping the default to
  v2 and retiring v1 remains tracked in issue #59. No PyPI version bump/publish.

## Node SDK: opt-in v2 (deep) signature canonicalization (issue #59), 2026-06-07

**SDK feature, additive, non-breaking** — the first *emitter* migration toward
the unified deep canonical form. The server already verifies v2 (prior PR); this
lets the Node SDK *produce* it.

- **`sdks/node/src/signature.ts`:**
  - New `canonicalizeV2(event)` — deep, recursively key-sorted canonical form
    covering nested payloads, **byte-identical to the server's `canonicalizeV2`**
    (null-prototype accumulator so `__proto__` payload keys survive).
  - `signEvent(event, secret, { canon })` — `canon` defaults to `"v1"`
    (unchanged, envelope-only); `{ canon: "v2" }` signs the deep form and adds a
    `signature.canon: "v2"` marker so payload tampering is detectable.
  - `verifySignature` is now **version-aware**: honours `signature.canon`
    (`"v2"`→deep, `"v1"`→shallow, absent→transition mode accepting either),
    rejects unknown/unsupported markers — mirroring the server.
  - `signature.canon` added to the `AEPEvent` signature type; `canonicalizeV2` +
    `SignOptions` exported.
- **Tests:** the existing **v1 cross-language known-answer** (Python-produced
  fixture) is preserved unchanged; new tests lock the Node **v2** form to a
  **server-derived known-answer vector**, prove v2 detects nested-payload
  tampering, and cover version honouring / transition mode / unknown markers.
- **Docs:** `sdks/node/README.md` documents v1 vs v2 and the `canon` option.
- **No default change, no breaking change** (v1 stays the default; the Python/Go
  emitters still sign v1). Flipping the default to v2 and retiring v1 remains
  tracked in issue #59. Node SDK version unchanged (`0.3.0`); a release/version
  bump is a separate step.

## Versioned signature canonicalization — server verifier (issue #59), 2026-06-07

**Server-only, additive, non-breaking** — the foundation slice for unifying the
per-event signature canonical form across implementations (issue #59). No SDK
emitter changes yet; those follow in their own PRs.

- **Problem:** the per-event HMAC canonical form diverged — the server, Python
  SDK, and Node SDK use a shallow envelope-only rule (nested `payload` serializes
  as `{}`, so payload tampering is invisible), while the Go SDK already signs a
  *deep* form. A Go-signed event with a payload therefore failed server
  verification (latent interop bug), and no per-event signature covered payloads.
- **`src/_canonical.js`:** new `canonicalizeV2(event)` — the deep, recursively
  key-sorted canonical form covering the whole event including nested payloads.
  `canonicalize` (v1, shallow) is unchanged and still byte-identical. The Phase 14
  audit bundle's per-event serialization now reuses `canonicalizeV2`, so a v2
  signature and the audit `content_digest` agree on "the canonical event".
- **`src/signature.js`:** `verifySignature` is now **version-aware** via an
  optional `signature.canon` marker:
  - `canon: "v2"` → verified against the deep form only.
  - `canon: "v1"` → verified against the shallow form only.
  - `canon` absent → **transition mode**: accepted if it matches *either* form,
    so every existing emitter keeps working — including the unmarked deep
    Go-SDK signatures, which now verify (the interop bug is fixed). Both forms are
    HMAC-keyed by the same secret, so this widens accepted encodings without
    weakening security. An unknown `canon` is rejected with a clear error.
- **No event-schema change** (`signature` is already `additionalProperties:true`);
  **no new CI job** (drift-guard untouched, 13 checks); tests folded into the
  existing unit suite. `verifySignature` back-compat regression-locked.
- **Docs:** `AUTH.md` documents the v1/v2 forms, the `canon` marker, the
  transition behaviour, and the cross-language number-format caveat.
- **Deferred to follow-up PRs (issue #59):** migrate the Node/Python/Go SDK
  *emitters* to sign v2 (with a shared number-serialization rule + cross-language
  known-answer parity tests), then flip the default to v2 and retire v1.

## Tamper-evident audit export bundles — Phase 14 PR-A, 2026-06-06

**First slice of the Compliance & Audit Suite (Phase 14).** A signed, offline-
verifiable JSON audit bundle built on AEP's existing HMAC primitives. JSON only —
the download endpoints (PR-B) and PDF rendering (PR-C) come later.

- **New module** [`src/audit.js`](./src/audit.js) — pure / deterministic
  (`now` is injected; never reads the clock):
  - `buildAuditBundle({ events, meta, secret, now })` → `{ aep_audit_version,
    manifest, events, signature }`. The `manifest` records `scope`
    (`session_id` / `trace_id`), `tenant_id`, `event_count`, `time_range`, a
    `content_digest` (SHA-256 over the ordered events), `exported_at`, and a
    `per_event_signatures` summary. The bundle `signature` is an HMAC-SHA256 over
    the manifest.
  - `verifyAuditBundle(bundle, secret)` → `{ valid, errors, content_digest_match,
    manifest_signature_valid, per_event }`. Recomputes the digest and the manifest
    signature and compares them timing-safe (`crypto.timingSafeEqual`).
  - **Tamper-evidence (detection, not immutability):** mutating any event byte
    (including nested **payload** fields), reordering events, or adding/dropping
    an event breaks `content_digest_match`; editing the manifest breaks
    `manifest_signature_valid`. Because the digest lives inside the signed
    manifest, an attacker cannot edit an event and silently re-patch the digest.
  - **Hardening:** the deep serializer uses a null-prototype accumulator so a
    payload key literally named `__proto__` is covered by the digest (a plain
    object would silently drop it → tamper-evasion); and `aep_audit_version` is
    included in the *signed* manifest (with a top-level copy cross-checked at
    verify time) so the bundle format version can't be downgraded undetected.
    `verifyAuditBundle` also honours the signed `content_digest_alg` (sha256/
    sha512) instead of assuming sha256, `buildAuditBundle` rejects an invalid
    `now` with a clear error, and `aep audit export` refuses to sign a
    misleading empty bundle for a missing/empty session unless `--allow-empty`.
    Post-review polish: a missing/non-number `manifest.event_count` is now itself
    a verify error (defense-in-depth can't be silently deleted); `aep audit
    export` warns when it omits `trace_id`/`tenant_id` scope because a session
    spans multiple values; and `stableStringify`'s JSON-value-equality semantics
    are documented.
- **Canonicalization refactor (no behaviour change):** the per-event
  `canonicalize` helper moved into [`src/_canonical.js`](./src/_canonical.js) and
  is re-exported from `src/signature.js`; `verifySignature` is byte-identical
  (regression-locked by `tests/unit/signature.test.js`). The audit path uses a
  new deep `stableStringify` in the same module so the digest covers nested
  payloads (the per-event signature's array-replacer rule does not — kept that
  way for cross-SDK parity; see the note below).
- **New env var `AUDIT_SIGNING_SECRET`** — server-side audit signing key, distinct
  from per-API-key HMAC secrets. When unset, audit export/verify fail with a clear
  error (mirrors how `ADMIN_TOKEN` gates `/admin/*`). Documented in `.env.example`,
  `SECURITY.md`, and `AUTH.md`.
- **CLI** ([`src/cli.js`](./src/cli.js)):
  - `aep audit export <session_id> [--out bundle.json] [--type] [--q]` — fetches
    the session's events via the read API, builds + signs the bundle.
  - `aep audit verify <bundle.json> [--json]` — offline verify; exit 0 valid / 1
    invalid; human or JSON output.
- **Tests:** `tests/unit/audit.test.js` (tamper matrix, round-trip, error paths)
  and `tests/unit/signature.test.js` (canonicalize + `verifySignature` regression
  lock) folded into the existing unit suite — **no new CI job** (drift-guard
  untouched, still 13 required checks).
- **Known limitation / follow-up:** the per-event transport signature still
  covers only the envelope (not nested payloads) for cross-SDK parity. The audit
  bundle closes this gap for compliance via its deep digest; unifying the two
  (deepening the per-event signature across the Python/Go/Node SDKs) is a
  candidate for a later PR.

## Operations & deployment guide — Phase 13 PR-E (docs), 2026-06-06

**Docs only — no code, no CI, no SDK changes.** The capstone of Phase 13 (Hosted
SaaS): an operator-facing guide that ties together the Postgres backend (PR-B),
projects / tiers / quotas (PR-C), and retention / pruning (PR-D) for a production
deployment.

- **New doc** [`OPERATIONS.md`](./OPERATIONS.md):
  - **Choosing a storage backend** — SQLite (default) vs Postgres, `STORAGE_BACKEND`
    + `DATABASE_URL` (with `PG*` libpq fallback), and the idempotent on-boot schema.
  - **Postgres production deployment** — connection string, a minimal
    `docker-compose` Postgres overlay, managed-PG notes, and `pg` connection-pool
    sizing guidance.
  - **Projects, tiers & quotas** — creating projects (`POST /admin/projects`),
    binding keys via `projectId`, the tier defaults table, `TIER_*` env overrides,
    and what a `429` + `Retry-After` means for clients — with the documented
    caveats (metered by `tenant_id`, event-count not bytes, soft single-node limit).
  - **Retention & pruning runbook** — what `npm run prune` does, `--dry-run` /
    `--json` / `--help`, the keep-forever rule, the tenant-scoping caveat,
    idempotency/observability, and concrete **crontab** + **Kubernetes `CronJob`**
    scheduling recipes (reusing the server image with `command: ["node",
    "src/prune.js"]` against the same DB Secret).
  - **Phase 13 production checklist.**
- **Cross-links added** from [`README.md`](./README.md) (docs table),
  [`SETUP.md`](./SETUP.md) (§16 Production Considerations + corrected the
  "Persistent storage" note now that the Postgres backend has shipped), and
  `.claude/CLAUDE.md` (docs tree).
- **Drift-guard impact: none** — docs only, no CI workflow change (still 13
  required checks).

---

## Node SDK 0.3.0 — first npm release, 2026-06-06

First published release of the Node SDK (`@surpradhan/aep`) to the public npm
registry. There are **no SDK code changes since `0.2.0`** — the version is
bumped to start the public npm line at `0.3.0`, and the published tarball is
functionally identical to what `0.2.0` would have been.

- **`sdks/node/package.json` / `sdks/node/package-lock.json`** — version
  `0.2.0` → `0.3.0`.
- **Released via the tag-triggered `Release Node SDK` workflow.** Pushing
  `node-sdk-v0.3.0` (on the squash commit on `main`) runs `npm publish
  --provenance --access public`. The release is gated to reviewed code: the
  pipeline fails unless the tagged commit is an ancestor of `origin/main`, and
  the actual publish runs only after a required-reviewer approval in the
  `npm-publish` deployment environment (see #49 / #50 and
  `sdks/node/README.md` → Publishing / Releases).
- **Contents (unchanged from `0.2.0`):** SDK core — `createEvent`,
  `validateEvent`, `signEvent`/`verifySignature`, and `AEPClient` (dual
  ESM + CJS, cross-language HMAC parity) — plus zero-code LangChain.js /
  LangGraph auto-instrumentation via `instrument()`. The tarball ships only
  `dist/` (+ README, LICENSE, package.json) via the `"files"` allowlist.

Drift-guard impact: none — version/docs only, no CI workflow change.

---

## Vercel AI SDK integration docs (OTEL bridge), 2026-06-06

**Docs + example only — no new instrumentor code, no SDK or CI changes.** The
Vercel AI SDK (`ai` package) already emits OpenTelemetry spans natively when
`experimental_telemetry: { isEnabled: true }` is set, and AEP's Phase 12a
Collector exporter (`otelbridge/`) already maps OTEL spans to AEP events. This
change documents how to wire those together and is explicit about how cleanly
Vercel's spans land — verified directly against `ai@6.0.197`'s
`recordSpan` source.

- **New doc** `docs/integrations/vercel-ai-sdk.md` — end-to-end wiring:
  enable `experimental_telemetry` → boot the OTEL Node SDK → OTLP to a Collector
  built with `otelbridge/builder-config.yaml` → AEP. Copy-pasteable Vercel
  `generateText({..., experimental_telemetry:{isEnabled:true, metadata:{...}}})`
  + tracing.ts + Collector config snippets. Documents the verified span shape
  (`ai.generateText` / `.doGenerate`, `ai.streamText` / `.doStream`,
  `ai.generateObject` / `.doGenerate`, `ai.streamObject` / `.doStream`,
  `ai.embed` / `embedMany` / `.doEmbed`, `ai.rerank` / `.doRerank`,
  `ai.toolCall`) and attributes (`operation.name`, `resource.name`,
  `ai.operationId`, `ai.telemetry.functionId`, `ai.telemetry.metadata.<key>`,
  `ai.model.{provider,id}`, `ai.settings.*`, `ai.toolCall.{name,id,args,result}`,
  `gen_ai.*`).
- **Honest mapping caveat.** All Vercel `ai.*` spans are emitted with OTEL kind
  `INTERNAL` (the SDK's `recordSpan` does not set a kind). The existing AEP
  mapper's tool rule requires `kind ∈ {CLIENT, SERVER}` and its error rule
  requires `"error"` in the span name, so under the stock mapper every Vercel
  span (including `ai.toolCall` and failed spans) classifies as
  `task.completed`. The full payload (`gen_ai.*` under `payload.gen_ai`,
  `ai.*` under `payload.attributes`, `span_name` preserved) is captured — what
  is lost today is per-event-type classification. The doc documents three paths
  to richer mapping (Collector `transformprocessor` rewrite, an AEP mapper
  pass, or a future first-party instrumentor) and recommends the OTEL bridge
  for now.
- **New example** `examples/vercel-ai-sdk/` — `tracing.mjs` (OTEL Node SDK boot)
  + `app.mjs` (`generateText` + one tool, telemetry enabled) +
  `collector-config.yaml` (uses only components shipped in
  `otelbridge/builder-config.yaml`). Illustrative only: running it needs an LLM
  API key, a running Collector, and a running AEP server, so there is **no** CI
  test for it.
- **README + PRD updated**; the Phase 12g roadmap entry is now split into a
  ✅ Node/LangChain.js line and a ✅ Vercel AI SDK (docs-only OTEL bridge) line.
- **No code changes** under `sdks/node/src/`; no CI job added; no required-checks
  list change (drift-guard verified — still 12 checks).

---

## Node SDK — npm release pipeline, 2026-06-06

Makes the already-merged Node SDK (`@surpradhan/aep`, `sdks/node/`, currently
`0.2.0`) cleanly publishable to the public npm registry, and adds the GitHub
Actions workflow that does the actual publish. No version bump and no real
publish in this change — only the plumbing.

- **`sdks/node/package.json`** — added `publishConfig` (`{"access": "public",
  "provenance": true}`), `repository` (with `"directory": "sdks/node"`),
  `homepage`, `bugs`, `author`, `keywords`, and a `prepublishOnly: npm run
  build` script. The `"files": ["dist"]` allowlist (plus npm's
  always-included README + LICENSE + package.json) ensures `npm pack` ships
  only the built artifacts — `src/`, `tests/`, `demos/`, `tsconfig.json`,
  `tsup.config.ts`, `vitest.config.ts`, `.prettierrc.json`, and
  `package-lock.json` are all excluded.
- **`sdks/node/LICENSE`** — MIT, matching the root repo license, so the
  published tarball includes a license file (npm auto-includes it).
- **`.github/workflows/release-node-sdk.yml`** — triggered ONLY on tags
  matching `node-sdk-v*` (never on push to a branch, never on a PR). The
  job checks out, sets up Node 20 with the npm registry, runs `npm ci →
  build → test`, then `npm publish --provenance --access public`. The job
  is granted `id-token: write` so the npm CLI can request the Sigstore
  attestation that backs provenance. Publish auth comes from the
  `NPM_TOKEN` repo secret (maintainer adds it once).
- **Docs** — `sdks/node/README.md` gains a "Publishing / Releases" section
  describing the bump-version → tag → workflow flow, and `PRD.md` notes
  that the Node SDK is now published on npm with provenance.

Drift-guard impact: none. The release workflow is a separate file (not
`ci.yml`) and a tag-triggered publish job is not a PR status check, so the
12 required checks tracked by `.github/scripts/check_required_checks.py`
are unchanged.

---

## Phase 12g (PR2) — Node.js LangChain.js / LangGraph auto-instrumentation, 2026-06-05

Builds on the Node SDK core (PR1). No change to the SDK core's event output or to
any other SDK. Adds the first **Node-runtime** zero-code framework instrumentation,
completing the user's "all three remaining SDKs" (OpenAI Agents 12e, Claude Agent
SDK 12f, Node.js 12g).

**New: `instrument()` for LangChain.js / LangGraph** (`sdks/node/src/instrument.ts`)

`await instrument()` patches `CompiledStateGraph.invoke`/`.stream` to inject an AEP
callback handler, so an unmodified `graph.invoke(...)` emits a full AEP causation
DAG with no other code changes. Tested against `@langchain/langgraph` 1.x +
`@langchain/core` 1.x.

- **Architecture mirrors the Python SDK.** A transport-neutral `EmissionCore`
  (background drain-loop emitter + bounded run table) owns all
  causation/trace/session/handoff threading and exposes semantic ops
  (`openAgentRun`/`closeAgentRun`/`openToolRun`/…). A framework-agnostic
  `LangGraphMapper` (never imports LangChain → unit-testable with plain objects)
  translates normalized callback info into core calls. The LangChain
  `BaseCallbackHandler` adapter is built lazily and is the only piece that touches
  the framework.
- **Event mapping (settled against a real offline trace):** the graph run (no
  parent) → orchestrator `task.*`; each LangGraph node (`metadata.langgraph_node`)
  with a tracked parent → sub-agent `task.*` via `handoff.started`/`completed`;
  `tool` callbacks → `tool.called`/`tool.result`/`error.raised`. One `trace_id`
  per run; every `causation_id` resolves to a real emitted event. Intermediate
  runnables and framework-internal hidden chains (e.g. `__start__`, tagged
  `langsmith:hidden`) are skipped to keep the DAG clean.
- **LangChain is an optional peer** — imported dynamically only when instrumenting,
  marked external in the build (never bundled), so the core SDK has no LangChain
  dependency and `instrument()` is a clean no-op + warning when it's absent.
- **Host-safe** — callbacks are pure observers that never throw into the host run;
  emit failures are swallowed on the drain loop; the run table is bounded with
  eviction + warnings; idempotent (un)instrument restores the patched methods.
- **Public API:** `instrument(options?)` / `uninstrument()` / `flush(timeoutMs?)`
  (all async), plus `EmissionCore` / `LangGraphMapper` exported for advanced use.

**Demo** — `sdks/node/demos/langgraph-multiagent.mjs`: a 2-node graph
(researcher → writer) with a `web_search` tool, runnable **offline with no LLM
key**, emitting a clean DAG then printing the server-reconstructed session tree.

**Tests** — 13 unit tests drive the `LangGraphMapper` mapping with fabricated
callback info + a recorder client (runnable without LangChain installed) — covering
orchestrator pair, node sub-agent + handoff, hidden-chain skip, intermediate-runnable
skip, untracked-parent fallback, tool called/result/error, tool-arg coercion,
chain failure, two-node trace, run-cap bound, and emit-failure host-safety — plus a
live integration test that runs a real LangGraph graph through `instrument()` and
asserts the server DAG (auto-skips when no server is reachable). Built-`dist`
ESM+CJS verified to instrument end-to-end.

---

## Phase 12g (PR1) — Node.js / TypeScript SDK core, 2026-06-05

No breaking changes to the event envelope schema or existing API contracts, and
no change to any other SDK. Purely additive: a new third-language SDK.

**New: `@surpradhan/aep` — the AEP Node.js / TypeScript SDK** (`sdks/node/`)

The first JS/TS SDK, mirroring the Python and Go SDKs (same envelope, same client
surface, same cross-language HMAC signing contract). Greenfield package — there
was no JS SDK before this. This is **PR1 of Phase 12g (the SDK core)**; zero-code
LangChain.js auto-instrumentation (`instrument()`) follows in PR2.

- **Core modules** (TypeScript, `src/`): `createEvent()` (v0.2.0 envelope factory,
  auto id/time, validates type + agent_role); `validateEvent()` (ajv 2020-12
  against the bundled envelope schema + optional `payload.$schema`, with
  non-blocking `[warn]` entries); `signEvent()` / `verifySignature()` /
  `canonicalize()` (HMAC-SHA256, `node:crypto`, timing-safe); `AEPClient` (async
  `fetch`-based: `emit` / `emitBatch` / `getSessions` / `getSessionEvents` /
  `getSessionTree` / `getSessionExport` / `getWorkflow` / `getMetrics` / `health` /
  `ready`); full `AEPError` hierarchy.
- **Cross-language signing parity** — the canonical form is byte-identical to the
  Python/Go SDKs and the server (`src/signature.js`): envelope minus `signature`,
  top-level keys sorted, `JSON.stringify(copy, sortedKeys)`. A unit test locks
  this against a **Python-produced signature fixture**, so a Node-signed event
  verifies under the Python/Go verifiers and vice versa.
- **Packaging** — dual **ESM + CJS** build with `.d.ts` via tsup; schemas bundled
  (inlined, no runtime file I/O); Node ≥ 20 (native `fetch`/`node:crypto`); npm
  name `@surpradhan/aep` (matches the Go module owner).
- **Tooling** — `tsup` (build), `tsc --noEmit` (typecheck), `vitest` (tests),
  `prettier` (format).
- **Tests** — 40 unit tests (event/validator/signature/http/client; no server, no
  framework; incl. the cross-language signature parity check, client filter/default
  parity, and the request-timeout-covers-body-read behavior) + 2 live integration
  tests that auto-skip when no AEP server is reachable (emit→read-back roundtrip,
  health).
- **Demo** — `sdks/node/demos/emit.mjs`: emits a small causation chain and reads
  the session back from the server.

**CI** — new `node-sdk-test` matrix job (Node 20.x + 22.x: install / format-check /
typecheck / build / test). Required checks go **10 → 12**; the drift-guard
(`Required checks in sync`) updates were applied together: `.github/workflows/ci.yml`,
the CONTRIBUTING required-checks block, and the `main` branch-protection contexts.

---

## Phase 12f — Framework Auto-Instrumentation (Anthropic Claude Agent SDK), 2026-06-05

No breaking changes to the event envelope schema or existing API contracts, and
**no change to the LangGraph (12b), CrewAI (12c), AutoGen (12d), or OpenAI Agents
SDK (12e) event output** (all regression-locked by their unchanged test suites).
Purely additive: a fifth framework registered alongside the existing four.

**New: Anthropic Claude Agent SDK auto-instrumentation** (`sdks/python/aep/instrument.py`)

`import aep; aep.instrument()` now also instruments the **Anthropic Claude Agent
SDK** — an unmodified `query()` / `ClaudeSDKClient` run emits a full AEP causation
DAG with no other code changes. Tested against `claude-agent-sdk>=0.2` (developed
on 0.2.x). This is the fifth major framework (LangGraph, CrewAI, AutoGen, OpenAI
Agents SDK, Claude Agent SDK).

- **Hook injection, not monkey-patching internals** — the SDK exposes
  `ClaudeAgentOptions.hooks` as its supported, in-process observation surface.
  The instrumentor injects observer `HookMatcher`s into `options.hooks` at the two
  methods both entry points consume — `InternalClient.process_query` (used by
  `query()`) and `ClaudeSDKClient.connect` (the streaming client) — analogous to
  LangGraph's `RunnableConfig` callback injection. Patching the consuming methods
  (not the public `query` function) makes it robust to `from claude_agent_sdk
  import query` import timing. `uninstrument()` restores both methods.
- **Event mapping (settled against the real hook API)** — the **top-level agent**
  (one per `session_id`) is the orchestrator `task.*` (new `trace_id` + root
  `session_id`), opened lazily on its first hook and closed on `Stop`; each
  `SubagentStart` opens a **sub-agent** `task.*` reached via
  `handoff.started`/`handoff.completed`, closed by `SubagentStop`; `PreToolUse`
  → `tool.called`, `PostToolUse` → `tool.result`, `PostToolUseFailure` →
  `error.raised`. One `trace_id` spans the run; every `causation_id` resolves to a
  real emitted event.
- **Exact attribution + pairing by id** — every tool/sub-agent hook carries an
  `agent_id` (which agent it belongs to) and a `tool_use_id` (the tool call), so a
  tool nests on its owning agent's session (the sub-agent named by `agent_id` if
  one is open, else the root) and `tool.called`/`tool.result` pair exactly by
  `tool_use_id` — no inference, no LIFO heuristics. The multi-agent DAG is
  explicit, richer than the message stream (where sub-agent internals hide behind
  a `Task` tool call).
- **Pure-observer hooks** — each injected hook returns `{}` (proceed, no decision)
  and swallows its own errors, so AEP telemetry can never alter or break the host
  agent run. They coexist with any hooks the user configures. Caveat (documented):
  the top-level run is closed by the `Stop` hook, so a multi-turn `ClaudeSDKClient`
  session records one trace per turn; sub-agents left open at `Stop` are closed
  defensively then.
- **Graceful, host-safe** — no-op + warning when the SDK is absent or its hook API
  has drifted (availability claimed only when the hook types + injection methods
  import); idempotent re-instrumentation (injection de-dups our callbacks);
  options are copied (never mutated) when hooks are injected; the run table and the
  open-sub-agent index are bounded. A `MIN_CLAUDE_AGENT_VERSION` floor and the
  installed version are surfaced in warnings.

**Demo** — `demos/claude_agent_multiagent.py`: an orchestrator + reviewer
sub-agent with `Read`/`Grep`/`Bash` tools (one failing). Runs **offline with no
API key and no `claude` binary** by replaying scripted hooks through a real
`query()` via a control-protocol fake transport (set `AEP_DEMO_ANTHROPIC=1` for a
real run), emitting a clean DAG — then prints the server-reconstructed session
tree.

**Tests** — 22 unit tests drive the `AEPClaudeAgentTracer` hook callbacks with
fabricated hook-input dicts and a recorder client (runnable without the SDK
installed) — covering root-only, lazy root, idempotent root, sub-agent + handoff,
tool on root vs sub-agent (attributed by `agent_id`), tool error, repeated tools,
straggler sub-agent closed at `Stop`, multi-session isolation, the `{}` no-op hook
contract, run-cap bound, and host-safety (emit failure + callback exception
swallowed) — plus real method-patch/restore and idempotent-injection tests. Two
integration tests: a **fully hermetic** one drives a real `query()` through a
control-protocol fake transport (replies to `initialize`, replays scripted
`hook_callback` control requests so the injected hooks fire through the SDK's real
dispatch, then a `result`) and asserts the server DAG — no API key, no network, no
binary; plus a real-`query()` test that auto-skips unless `ANTHROPIC_API_KEY` is
set. All Phase 12b–12e tests remain green and unchanged.

**CI** — `python-sdk-test` now installs `sdks/python[dev,langgraph,crewai,autogen,openai-agents,claude-agent,otel]`.

**Optional dependencies** — added `[claude-agent]` extra to `pyproject.toml`:
`pip install -e "sdks/python[claude-agent]"`.

---

## Phase 12e — Framework Auto-Instrumentation (OpenAI Agents SDK), 2026-06-05

No breaking changes to the event envelope schema or existing API contracts, and
**no change to the LangGraph (12b), CrewAI (12c), or AutoGen (12d) event output**
(all regression-locked by their unchanged test suites). This is purely additive: a
fourth framework registered alongside the existing three.

**New: OpenAI Agents SDK auto-instrumentation** (`sdks/python/aep/instrument.py`)

`import aep; aep.instrument()` now also instruments the **OpenAI Agents SDK** — an
unmodified `Runner.run()` / `Runner.run_sync()` emits a full AEP causation DAG with
no other code changes. Tested against `openai-agents>=0.1` (developed on 0.17.x).
This is the fourth major framework (LangGraph, CrewAI, AutoGen, OpenAI Agents SDK).

- **Tracing processor, not monkey-patching** — the Agents SDK exposes a supported,
  global tracing pipeline you join with `agents.tracing.add_trace_processor`. The
  instrumentor registers an `AEPOpenAIAgentsTracer` (a duck-typed `TracingProcessor`)
  *alongside* (not replacing) the SDK's own exporter — mirroring 12b/12c/12d's
  choice of the supported observation surface over patching internals.
  `uninstrument()` removes only our processor (via `set_processors`), leaving the
  SDK's default exporter and any other processors untouched.
- **Event mapping (settled against a real captured trace)** — the **trace** (one
  per top-level `Runner.run`) is the orchestrator `task.*` (new `trace_id` + root
  `session_id`); each `agent` span is a **sub-agent** `task.*` reached via
  `handoff.started`/`handoff.completed` on the workflow session — matching how the
  SDK itself trees agents as siblings under the workflow root (the AutoGen
  team→agents star). The real `from_agent` of a `handoff` span is preserved on the
  handed-to agent's `task.created` payload as `handoff_from`. A `function` span maps
  to `tool.called` → `tool.result` (or `error.raised` when the span carries an
  error). One `trace_id` spans the run; every `causation_id` resolves to a real
  emitted event.
- **Exact tool pairing by `span_id`** — a tool is a single `function` span carrying
  both its start and end, so its `tool.called`/`tool.result` pair exactly by
  `span_id` with no LIFO heuristics. A tool (and a nested agent, as with
  agents-as-tools) attaches to its owning agent's session, resolved by walking the
  span tree's `parent_id` chain to the nearest enclosing open agent, falling back
  to the always-open workflow root so nothing escapes the run's single trace.
  **Agents-as-tools** (`agent.as_tool(...)`) — verified end-to-end against a real
  trace — nest the inner agent as a sub-agent of the calling agent while the
  as_tool function still emits its own tool pair (a faithful double-representation,
  single trace, 0 dangling).
- **Honest failure semantics** — the tracing surface only reports failures the SDK
  records on a span (e.g. a tool error sets `span.error`). An *uncaught* exception
  from `Runner.run` is not delivered to processors (spans/trace still close cleanly
  and the exception propagates to the caller), so such a run is recorded
  `completed`; AEP deliberately does **not** bolt on a separate failure path that
  would race the SDK's own close. Documented as a caveat rather than over-claimed.
- **Graceful, host-safe** — no-op + warning when the SDK is absent or its tracing
  API has drifted (availability is claimed only when `add_trace_processor` imports);
  every processor callback is wrapped so a telemetry bug never breaks the host run;
  emit failures swallowed; idempotent re-instrumentation (never stacks a second AEP
  processor). `on_trace_end` closes any sub-agent that never received its own
  span-end (so a straggler still gets its `task.completed`); a span arriving with no
  tracked trace root is warned about (once) rather than silently splitting the run;
  `uninstrument()` warns if the SDK's (private) processor list can't be reached to
  remove our tracer rather than leaving it silently registered. The core run table,
  the span-parent index, and the pending-handoff index are all bounded with
  eviction + warnings. A `MIN_OPENAI_AGENTS_VERSION` floor and the installed
  version are surfaced in warnings.

**Demo** — `demos/openai_agents_multiagent.py`: a triage → spanish handoff with a
`get_weather` tool. Runs **offline with no LLM API key** via a scripted `Model`
(set `AEP_DEMO_OPENAI=1` for a real model), emitting a clean DAG — orchestrator + 2
sub-agent sessions + a tool pair on one trace — then prints the server-reconstructed
session tree.

**Tests** — 27 unit tests drive the `AEPOpenAIAgentsTracer` tracing-processor
mapping with fabricated trace/span objects and a recorder client (runnable without
the SDK installed) — covering orchestrator-only, sub-agent + handoff DAG,
`handoff_from` enrichment, tool called/result/error, repeated tools, parent
resolution through turn spans, fallback to the workflow root, agent failure,
agents-as-tools nesting (mirroring the real `function → task → agent` tree + its
tool pair), straggler close at trace-end, orphan-span (missing trace-start)
safety, empty-string tool input, run-cap + span-index bounds, stray span ends, and
host-safety (emit failure + callback exception swallowed) — plus a real
processor-registration/removal test. Two integration tests run a real `Runner.run`
against a live server (one verifies the workflow/agent/handoff DAG incl.
`handoff_from`; one drives a real tool call and asserts a linked `tool.called` →
`tool.result` pair) and auto-skip when unreachable. All Phase 12b, 12c, and 12d
tests remain green and unchanged.

**CI** — `python-sdk-test` now installs `sdks/python[dev,langgraph,crewai,autogen,openai-agents,otel]`.

**Optional dependencies** — added `[openai-agents]` extra to `pyproject.toml`:
`pip install -e "sdks/python[openai-agents]"`.

---

## Phase 12d — Framework Auto-Instrumentation (AutoGen), 2026-06-05

No breaking changes to the event envelope schema or existing API contracts, and
**no change to the LangGraph (12b) or CrewAI (12c) event output** (both are
regression-locked by their unchanged test suites). This is purely additive: a
third framework registered alongside the existing two.

**New: AutoGen AgentChat auto-instrumentation** (`sdks/python/aep/instrument.py`)

`import aep; aep.instrument()` now also instruments **AutoGen AgentChat** — an
unmodified `team.run()` / `team.run_stream()` emits a full AEP causation DAG with
no other code changes. Tested against `autogen-agentchat>=0.4` (developed on 0.7.x).
AutoGen is the third major framework, satisfying the PRD's ≥3-framework metric
(LangGraph, CrewAI, AutoGen).

- **Stream tracer, not a callback/bus** — AutoGen AgentChat has neither a callback
  registry nor an event bus; a team surfaces its activity only as the async stream
  of messages/events yielded by `BaseGroupChat.run_stream`. The instrumentor wraps
  that method (which `BaseGroupChat.run` consumes internally, so one tap covers
  both) with an `AEPAutoGenTracer` that re-yields every item unchanged while
  translating it into `_EmissionCore` calls — mirroring 12b/12c's choice of the
  supported observation surface over monkey-patching internals. `uninstrument()`
  restores the original method.
- **Event mapping (settled against a real trace)** — the **team** is the
  orchestrator `task.*` (new `trace_id` + root `session_id`); each distinct message
  `source` (an agent name) is opened lazily as a **sub-agent** `task.*` with
  `parent_session_id` → team, reached via `handoff.started`/`handoff.completed` on
  the team session; a `ToolCallRequestEvent` → `tool.called` and the matching
  `ToolCallExecutionEvent` → `tool.result` (or `error.raised` when `is_error`).
  One `trace_id` spans the run; every `causation_id` resolves to a real emitted
  event. A run-level exception closes the orchestrator `task.failed` and
  propagates unchanged; observed sub-agents close `task.completed`.
- **Exact tool pairing by `call_id`** — AutoGen tags each `FunctionExecutionResult`
  with the `call_id` of its `FunctionCall`, so tool starts/closes are matched
  exactly (even for parallel tool calls returned out of order) — no LIFO heuristics
  needed. In-team agents run through the AgentChat runtime (not
  `BaseChatAgent.run_stream`), so there is no double-counting.
- **Concurrency-safe** — each `run_stream` invocation gets a fresh run context
  whose run-table keys are namespaced by a unique token, so concurrent team runs
  never collide on the shared (bounded) core run table.
- **Graceful, host-safe** — no-op + warning when AutoGen is absent or its team base
  class has drifted (availability is claimed only when
  `BaseGroupChat` imports — so 0.2-era `pyautogen` degrades cleanly); per-item
  mapping errors are swallowed so a telemetry bug never breaks the host stream;
  emit failures swallowed; run exceptions still propagate; idempotent
  re-instrumentation. A `MIN_AUTOGEN_VERSION` floor (tested against 0.7.x) and the
  installed version are surfaced in warnings.

**Demo** — `demos/autogen_multiagent.py`: a 2-agent round-robin team
(researcher → writer) with a `web_search` tool. Runs **offline with no LLM API
key** via `autogen-ext`'s `ReplayChatCompletionClient` (set `AEP_DEMO_OPENAI=1`
for a real model), emitting a clean DAG — orchestrator + 2 sub-agent sessions +
a tool pair on one trace — then prints the server-reconstructed session tree.

**Tests** — 19 unit tests drive the `AEPAutoGenTracer` mapping with fabricated
AutoGen-shaped events and a recorder client (runnable without AutoGen installed) —
including parallel-tool `call_id` matching, orphan tool close, run-failure,
run-cap bound, transparent passthrough, and stream-mapping-error host-safety
cases — plus a real class-patch/restore test. Two integration tests run a real
`team.run()` against a live server (one verifies the team/agent/handoff DAG; one
drives a real tool call via the offline replay client and asserts a linked
`tool.called` → `tool.result` pair) and auto-skip when unreachable. All Phase 12b
and 12c tests remain green and unchanged.

**CI** — `python-sdk-test` now installs `sdks/python[dev,langgraph,crewai,autogen,otel]`.

**Optional dependencies** — added `[autogen]` extra to `pyproject.toml`:
`pip install -e "sdks/python[autogen]"`.

---

## Phase 12c — Framework Auto-Instrumentation (CrewAI), 2026-06-05

No breaking changes to the event envelope schema or existing API contracts, and
**no change to Phase 12b's LangGraph event output** (the refactor below is
regression-locked by the unchanged Phase 12b test suite).

**New: CrewAI auto-instrumentation** (`sdks/python/aep/instrument.py`)

`import aep; aep.instrument()` now also instruments **CrewAI** — an unmodified
`Crew.kickoff()` emits a full AEP causation DAG with no other code changes.
Tested against `crewai>=1.0` (developed on 1.14).

- **Transport-neutral emission core** — the framework-agnostic machinery (the
  background `_Emitter` queue, run bookkeeping, ID helpers, and the
  lifecycle→event mapping: run-open → `task.created`/`tool.called`, run-close →
  `task.completed`/`tool.result`/`task.failed`, parent→child →
  `handoff.started`/`handoff.completed`, plus causation/trace/session threading)
  now lives in a transport-neutral `_EmissionCore`. The LangChain handler and the
  new CrewAI listener are thin adapters over it. The LangGraph path is unchanged.
- **Event-bus listener, not internals-wrapping** — CrewAI does **not** use
  LangChain callbacks, so the instrumentor subscribes an `AEPCrewListener` to
  CrewAI's own event bus (`crewai.events.crewai_event_bus`), the supported
  extension point — mirroring 12b's choice of LangGraph's `RunnableConfig`
  callbacks over monkey-patching. `uninstrument()` unsubscribes.
- **Event mapping** — `Crew.kickoff()` → orchestrator `task.*` (new `trace_id` +
  root `session_id`); each task (named for its assigned agent) → sub-agent
  `task.*` with `parent_session_id` → crew, reached via `handoff.started`/
  `handoff.completed` on the crew session; tool usage → `tool.called`/
  `tool.result`, `error.raised` on failure. One `trace_id` spans the kickoff;
  every `causation_id` resolves to a real emitted event.
- **Agent-vs-Task nesting (settled against a real trace)** — CrewAI fires
  `TaskStarted` *then* `AgentExecutionStarted` inside it, so a Task wraps its
  Agent execution. The **Task** is therefore the sub-agent session and the agent
  is folded into it; an agent that runs outside any task (e.g. a hierarchical
  manager) opens its own agent-keyed sub-agent session as a fallback.
- **Relaxed LangChain gate** — `instrument()` only requires `langchain-core` when
  a LangChain-family framework is actually instrumented. With only CrewAI
  installed, `aep.instrument()` works without `langchain-core` present.
- **Graceful, host-safe** — no-op + warning when CrewAI is absent or its event API
  has drifted (the instrumentor only claims availability when `crewai.events` is
  importable); emit failures swallowed; crew exceptions still propagate;
  idempotent re-instrumentation. A `MIN_CREWAI_VERSION` floor (tested against
  1.14.x) and the installed CrewAI version are surfaced in warnings.
- **Robust tool pairing** — each tool invocation is tracked under a unique key, so
  repeated or concurrent tools in the same scope never collide; a `tool.result`/
  `error.raised` matches the most-recent open tool in its scope and falls back to
  global LIFO if the close event resolved a different scope than the open (e.g.
  CrewAI omitted `from_task` on the finished event) — so a tool pair always closes
  instead of leaving a dangling `tool.called`. The open-tool index is bounded
  (oldest evicted + warned) so never-closed tool starts can't grow it unbounded.
  Tool attribution is exact for sequential crews and best-effort under concurrent
  agents.

**Demo** — `demos/crewai_multiagent.py`: a 3-agent sequential research crew
(researcher → analyst → writer) with two tools. Runs **offline with no LLM API
key** via a tiny scripted stub LLM (set `AEP_DEMO_OPENAI=1` for a real model),
emitting a clean DAG — orchestrator + 3 sub-agent sessions + tool pairs on one
trace — then prints the server-reconstructed session tree.

**Tests** — 17 unit tests drive the `AEPCrewListener` mapping with fabricated
CrewAI-shaped events and a mock client (runnable without CrewAI installed) —
including repeated-tool, scope-drift, and orphan-close cases — plus a real-bus
subscribe/unsubscribe test. Two integration tests run a real `Crew.kickoff()`
against a live server (one verifies the crew/task/handoff DAG; one drives a real
tool call via an offline scripted LLM and asserts a linked `tool.called` →
`tool.result` pair) and auto-skip when unreachable. All Phase 12b tests remain
green and unchanged.

**CI** — `python-sdk-test` now installs `sdks/python[dev,langgraph,crewai,otel]`.

**Optional dependencies** — added `[crewai]` extra to `pyproject.toml`:
`pip install -e "sdks/python[crewai]"`.

**Future phases** — Phase 12d+ (AutoGen, Anthropic/OpenAI Agents SDK patching;
Node.js for LangChain.js and Vercel AI SDK).

---

## Fix — `/dashboard` & `/openapi.json` static serving under Express 5, 2026-06-04

No breaking changes to the event envelope schema or existing API contracts.

**Server** (`src/server.js`)

- `res.sendFile()` was called with a full absolute path. Under Express 5, `send()`
  applies its dotfiles policy (default `"ignore"`) to the whole resolved path when
  no `root` is given, so a checkout whose path contains a dot-directory (e.g. a
  `.claude/worktrees/...` git worktree) caused both routes to 404. Both now pass a
  `root` option so the trusted prefix is exempt from the dotfiles check and only
  the filename (no dot) is policy-checked.
- Added a `GET /dashboard` → 200 regression test (the existing `/openapi.json`
  test only failed from a dot-directory checkout; CI uses a clean path). (PR #27)

---

## Phase 12b — Framework Auto-Instrumentation (LangGraph), 2026-06-04

No breaking changes to the event envelope schema or existing API contracts.

**New: `aep.instrument()` Python function** (`sdks/python/aep/instrument.py`)

One line — `import aep; aep.instrument()` — makes LangGraph workflows emit a full
AEP event DAG with no other code changes. Tested against `langgraph>=0.1`
(developed on 1.x).

- **Callback-based, not method-wrapping** — instrumentation is a LangChain
  `BaseCallbackHandler` injected into every `CompiledStateGraph.invoke` / `ainvoke`
  / `stream` / `astream` via the call's `RunnableConfig` (inherited by all child
  runs). This is LangGraph's supported extension point and survives node fan-out.
- **Rich event mapping** — graph run → orchestrator `task.created`/`task.completed`/
  `task.failed`; each node → sub-agent `task.*`; orchestrator→node transitions →
  `handoff.started`/`handoff.completed`; tool calls (`on_tool_*`) →
  `tool.called`/`tool.result`, with `error.raised` on tool failure.
- **Full causation DAG** — one `trace_id` per graph run; each node gets its own
  `session_id` with `parent_session_id` pointing at the orchestrator; every event's
  `causation_id` references the event that triggered it (verified: zero dangling
  references in the demo run).
- **Pluggable framework registry** — `FrameworkInstrumentor` + `_INSTRUMENTORS`
  registry; adding CrewAI/AutoGen later means registering one class.
- **Graceful, host-safe** — no-op + warning if LangGraph/langchain-core absent or
  if framework internals differ (warns loudly, never falsely reports success);
  emit failures are logged and swallowed; exceptions in the graph still propagate.
  Idempotent (`instrument()` twice won't double-patch); `uninstrument()` restores.
- **Configuration** — `AEP_INGEST_URL`/`AEP_API_KEY` env vars or
  `instrument(server_url=…, api_key=…)`; accepts an injected `client=` for tests.

**Demo** — `demos/langgraph_multiagent.py`: a 10-node LangGraph research workflow
(orchestrator → 3 parallel researchers → synthesize → fact-check + risk-review →
editor → publish). Running it emits 38 events across 10 sessions sharing one
trace, then prints the server-reconstructed session tree.

**Tests** — 20 unit tests: ID/config-injection helpers (dependency-free) plus the
real callback handler driven through the LangGraph callback sequence, asserting
event types, causation links, sub-agent linkage, and host-safety (emit failures
don't propagate). Integration test runs a real graph against a live server and
auto-skips when unreachable (via `tests/integration/conftest.py`).

**CI** — new `python-sdk-test` job (Python 3.10/3.11/3.12): installs
`sdks/python[dev,langgraph]`, lints with ruff, runs the SDK test suite.

**Optional dependencies** — added `[langgraph]` extra to `pyproject.toml`:
`pip install -e "sdks/python[langgraph]"`.

**Future phases** — Phase 12c+ (CrewAI, AutoGen, Anthropic/OpenAI SDK patching;
Node.js for LangChain.js and Vercel AI SDK).

---

## Phase 12a — OpenTelemetry Collector Plugin, 2026-06-04

No breaking changes to the event envelope schema or existing API contracts.

**New: AEP OpenTelemetry Collector exporter** (`otelbridge/` — separate Go module `github.com/surpradhan/aep-otel-bridge`)

Completes the OTEL story from Phase 11 — any OTEL-instrumented system can emit to AEP through a standard Collector pipeline, with no application code changes:

- **Collector exporter** (`exporters/aepexporter/`) — config / factory / exporter built on the opentelemetry-collector v0.96 pattern; batches events and emits via the AEP Go client
- **pdata-native span-to-event mapper** — mirrors the reference classification (`error.raised` > `handoff.completed` > `tool.result` > `task.completed`/`task.failed` > default); `trace_id` → AEP `trace_id` + `session_id` (`ses_<trace_id[:16]>`); parent span ID → `causation_id`; `gen_ai.*` → payload; `service.name` → `agent://` source
- **Build & demo** — `builder-config.yaml` (ocb) to build a Collector including the exporter; `docker-compose.yml` (app → Collector → AEP) with an API-key bootstrap step (`/events` has no dev-mode bypass)
- **CI** — new `otelbridge-test` job; the AEP Go SDK was also repaired and added to CI (it previously did not compile from a clean checkout — jsonschema API, embedded-schema path, BOM, event-type validation, OTEL mapper)

**Tests** — exporter unit tests built on in-memory `ptrace.Traces` (no server required)

**Not yet verified end-to-end:** the ocb Collector build and full `docker-compose` run, and a live-server integration test — see `otelbridge/README.md` "Status".

---

## Phase 11 — OpenTelemetry Bridge (SDK), 2026-06-04

No breaking changes to the event envelope schema or existing API contracts.

**New: `aep.otel` Python module** (`sdks/python/aep/otel/`)

A drop-in OpenTelemetry bridge that emits AEP events from OTEL spans:

- **Span-to-event mapper** (`mapper.py`) — `map_span_to_event()` translates an OTEL `ReadableSpan` to an AEP event. Priority-ordered classification: `error.raised` (error status + "error" in name) > `handoff.completed` > `tool.result` (CLIENT/SERVER + "tool") > `task.completed`/`task.failed` > default
- **Span exporter** (`exporter.py`) — `AEPSpanExporter` implements the OTEL `SpanExporter` interface; works with `SimpleSpanProcessor` and `BatchSpanProcessor`; structured logging; partial-failure handling (SUCCESS if any span exports, FAILURE if all fail)
- **Trace context preservation** — `trace_id` → AEP `trace_id` and `session_id` (`ses_<trace_id[:16]>`, so all spans in a trace share a session); parent span ID → `causation_id`; `Resource.service.name` → `agent://<service>` source (configurable prefix); `gen_ai.*` attributes (OTEL GenAI SIG) → payload
- **Event validation** — generated events are validated against the AEP schema before emission
- **Go mapper** (`sdks/go/aep/otel/mapper.go`) — span-to-event logic for language parity

**Demo** — `demos/otel_bridge.py`: multi-agent orchestrator instrumented with OTEL, exporting to AEP

**Tests** — 38 unit tests (27 mapper + 11 exporter), no server required

**Delivered in Phase 12a:** OTEL Collector exporter plugin; end-to-end Datadog/NewRelic → Collector → AEP demo.

---

## Phase 10 — Kubernetes Operator (2026-06-03)

No breaking changes to the event envelope schema or existing API contracts.

**New: AEP Operator** (`operator/` — separate Go module `github.com/surpradhan/aep-operator`)

Zero-code instrumentation of agent workloads via sidecar injection:

- **`AgentInstrumentation` CRD** (cluster-scoped) — `namespaceSelector`, `podSelector`, `apiKeySecretRef`, `sidecarImage`, `resources`, and `env` overrides
- **Mutating webhook** — opt-in via `aep.dev/inject=true` annotation; injects the AEP sidecar with downward-API env vars, Secret-backed API key, configurable resources, and a hardened `SecurityContext`
- **Controller** — reconciles `AgentInstrumentation` CRs; maintains `status.injectedCount` and `status.conditions` (Ready/Disabled/InjectionFailed)
- **Helm chart** (`operator/helm/aep-operator/`) — cert-manager TLS, configurable `namespaceSelector`, all values documented
- **Tests** — 22 unit (10 controller + 12 webhook) + 4 envtest integration tests

---

## Phase 9 — Go SDK (2026-06-03)

No breaking changes to the event envelope schema or existing API contracts.

**New: `aep-go` Go package** (`sdks/go/`)

A production-ready Go SDK with full parity to JavaScript and Python SDKs:

- **Types & Events** — `EventType` enum, `AgentRole` enum, 12 core event types, `CreateEvent()` factory with optional fields
- **Validation** — JSON Schema validation via `jsonschema/v5`; payload `$schema` resolution with 1-hour TTL caching; graceful handling of invalid/relative URIs (warnings, not errors)
- **Signing** — `SignEvent()` / `VerifySignature()` — HMAC-SHA256 with canonical JSON form (exact parity with JS/Python); `hmac.Equal()` for constant-time verification
- **HTTP clients** — `Client` (sync) and `AsyncClient` (async with goroutines); both support context timeouts, API key auth, all endpoints; explicit HTTP 202/422 handling
- **Error hierarchy** — `AEPError` base type + specific types: `ErrValidation`, `ErrAuth`, `ErrRateLimit`, `ErrNotFound`, `ErrConnection`, `ErrServer`
- **CLI tool** (`cmd/aep-go/`) — `emit`, `session`, `validate`, `health`, `ready` commands with full flag coverage
- **Examples** — `subagent_research.go` — multi-agent orchestrator + 3 parallel sub-agents with causation chains

**Test suite** (`tests/`)

80+ tests:
- 69+ unit tests (event creation, validation, signing, client methods)
- 11 integration tests (auto-skip if server unavailable) covering emit, batch, multi-agent workflows, signatures

**Key improvements**
- Payload schema cache with TTL prevents unbounded memory growth in long-running processes
- Context cancellation detection in `AsyncClient.EmitBatch` prevents resource leaks
- HTTP 422 handler extracts schema validation error messages from response body
- Comprehensive error tests for network failures, invalid URIs, relative URIs

---

## Phase 8 — Python SDK (2026-06-02)

No breaking changes to the event envelope schema or existing API contracts.

**New: `aep` Python package** (`sdks/python/`)

A production-ready Python SDK with full parity to the JavaScript implementation:

- `create_event()` — mirrors `createEvent.js`; auto-generates `id`/`time`, validates type + agent role, omits `None` optional fields
- `validate_event()` — Draft 2020-12 JSON Schema validation via `jsonschema`; payload `$schema` resolution; `[warn]`-prefixed non-blocking warnings
- `sign_event()` / `verify_signature()` — HMAC-SHA256 signing with exact JS canonical form (`JSON.stringify(copy, sortedKeys)` semantics); `hmac.compare_digest` for timing safety
- `AEPClient` — synchronous HTTP client backed by `httpx`; full endpoint coverage; context manager; `ResourceWarning` on unclosed clients
- `AsyncAEPClient` — async HTTP client; `emit_batch` uses `asyncio.gather` (concurrent, not sequential); all requests complete before raising on partial failure
- `AEPServerError` — new exception class for HTTP 5xx with `.status_code` attribute (completes the full `AEPError` hierarchy: `AEPValidationError`, `AEPAuthError`, `AEPRateLimitError`, `AEPNotFoundError`, `AEPConnectionError`, `AEPServerError`)
- Schemas bundled in `aep/schemas/` with `package-data` so the package works after standalone `pip install`
- `py.typed` marker (PEP 561) for mypy/pyright annotation support
- `demos/subagent_research.py` — Python port of the multi-agent research demo (orchestrator + 3 parallel sub-agents)

**Test suite** (`tests/unit/`, `tests/integration/`)

107 unit tests (no server required) using `respx` mocks + `pytest-asyncio`, covering:
- Event creation, validation, HMAC signing/verification, sync and async client behaviour
- All error paths: 400/401/403/404/429/5xx and `ConnectError`
- `emit_batch` partial-failure contract (all requests complete before raise)
- `__repr__` key masking safety for short keys

11 integration tests auto-skip when `AEP_INGEST_URL` is unreachable (moved to `conftest.py` — no import-time HTTP probe on unit-only runs).

**New internal module** (`aep/_http.py`)

`handle_response`, `parse_retry_after`, `_safe_json` extracted from `client.py` so both sync and async clients share the helpers without cross-module private imports.

---

## Phase 7 — Production Hardening (2026-03-24)

No breaking changes to the event envelope schema or existing API contracts.

**Pagination** (`src/db/index.js`, `src/server.js`)

`GET /sessions` and `GET /sessions/:id/events` now accept `?limit` and `?cursor` query params and return `next_cursor` in every response. Cursors are opaque base64url tokens encoding the sort position of the last returned item; an invalid or missing cursor silently falls back to the first page. Page size caps: 500 for sessions, 1000 for events.

**Rate limiting** (`src/middleware/rateLimit.js`)

`POST /events` enforces a per-API-key fixed-window rate limit (default 300 req/min, configurable via `RATE_LIMIT_RPM`). Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers. Exceeding the limit returns HTTP 429 with a `Retry-After` header. Set `RATE_LIMIT_RPM=0` to disable entirely.

**Graceful shutdown** (`src/server.js`)

`SIGTERM` and `SIGINT` handlers stop accepting new connections, drain in-flight requests via `httpServer.close()`, close the SQLite connection, and exit cleanly. A 30-second hard-exit timeout prevents stalled shutdown.

**Docker** (`Dockerfile`, `docker-compose.yml`)

Multi-stage build (deps → runtime) on `node:20-alpine`. Runs as the unprivileged `node` user. Built-in `HEALTHCHECK` polls `GET /health`. `docker-compose.yml` mounts a named volume for the SQLite file and passes all config via environment variables.

**Environment configuration** (`.env.example`)

`.env.example` documents every variable (`PORT`, `DATABASE_PATH`, `LOG_LEVEL`, `LOG_PRETTY`, `ADMIN_TOKEN`, `DASHBOARD_TOKEN`, `RATE_LIMIT_RPM`, `HOST_PORT`) with type, default, and production notes.

**Prometheus metrics** (`src/metrics.js`, `src/server.js`)

`GET /metrics/prometheus` (no auth) exports in Prometheus text format 0.0.4:
- Counters: `aep_events_received_total`, `aep_events_accepted_total`, `aep_events_rejected_total`, `aep_events_duplicates_total`
- Gauges: `aep_sessions_total`, `aep_workflows_total`
- Per-type counter: `aep_events_by_type_total{type="..."}`
- HTTP counters: `aep_http_requests_total{method, route, status}`
- Latency histograms: `aep_http_request_duration_seconds{method, route}` with 11 standard buckets

**Structured logging** (`src/logger.js`, `src/server.js`)

All `console.log` calls replaced with pino. Every log line is newline-delimited JSON with `service`, `level`, and `time` fields. Request logs include `method`, `path`, `status`, and `tenant_id`. Log level controlled by `LOG_LEVEL` (default `info`).

**Health probes** (`src/server.js`)

`GET /health` now executes `SELECT 1` against the database and returns HTTP 503 with `{ ok: false, checks: { db: "error" } }` if unreachable. New `GET /ready` endpoint verifies both DB connectivity and that the `events` table exists (schema migrated); returns 503 until both pass.

---

## Phase 6 — Testing & Developer Experience (2026-03-24)

No breaking changes to the event envelope schema or existing API contracts.

**New: test suite**

82 tests using Node.js's built-in `node:test` runner (no new runtime dependencies):
- `tests/unit/` — 55 tests covering `validator.js`, `createEvent.js`, and `coreEventTypes.js`
- `tests/integration/` — 27 tests covering every HTTP endpoint including auth, deduplication, export formats, session tree, workflow, metrics, admin key lifecycle, and OpenAPI response shape
- `tests/fixtures/` — 19 JSON fixture files (12 valid, one per core event type; 7 invalid covering distinct failure modes)
- `.github/workflows/ci.yml` — GitHub Actions CI running on Node 20 and 22

**New: `aep` CLI** (`src/cli.js`)

Four new commands added alongside the existing `validate` command. The binary is declared under `"bin"` in `package.json` and available via `npx aep` or `npm link`:
- `aep emit` — emit any event envelope with full flag coverage of all optional fields
- `aep session <id>` — print a session's event timeline with optional `--type` / `--q` filters
- `aep export <id>` — stream session events as JSON or CSV to stdout or `--out <file>`
- `aep workflow <traceId>` — fetch and pretty-print the full multi-agent workflow tree

**New: OpenAPI 3.1 spec**

`src/openapi.json` — a complete spec covering all 13 endpoints, all request/response schemas, both security schemes (`ApiKeyAuth` and `AdminAuth`), and full error responses. Served at:
- `GET /openapi.json` — raw JSON (no auth required)
- `GET /docs` — Swagger UI via CDN (no auth required)

**server.js change (non-breaking)**

`app.listen()` is now guarded by `require.main === module`, and `module.exports = { app }` is added at the bottom. This allows the integration test suite to import the Express app directly without starting a server.

---

## Phase 5 — Auth & Multi-Tenancy (2026-03-24)

No breaking changes to the event envelope schema. Server-side only.

**New database table**

`api_keys` — stores key hash, display prefix, tenant binding, permission scopes, and an optional HMAC secret. Raw keys are never persisted.

**New columns on existing tables**

`events.tenant_id` and `sessions.tenant_id` — assigned from the ingest API key at write time. Existing rows are backfilled to `"default"`.

**New endpoints**

`POST /admin/keys`, `GET /admin/keys`, `DELETE /admin/keys/:id` — key lifecycle management, requires `ADMIN_TOKEN`.

**Behaviour changes**

- All write and read endpoints now require authentication when `DASHBOARD_TOKEN` or API keys are configured. See [AUTH.md](./AUTH.md) for details.
- The `tenant` field in the envelope is now enforced: the effective tenant comes from the API key, providing isolation regardless of the envelope value.
- The `signature` field is now verified on ingest if the API key has an `hmacSecret` configured (HMAC-SHA256 over a canonical JSON form of the event).

---

## v0.2.0 (2026-03-22)

**Breaking changes**

| Field | Change |
|---|---|
| `specversion` | Value bumped from `"0.1.0"` to `"0.2.0"`. Events with the old value will fail envelope validation. |

**New fields (all optional)**

`parent_session_id` (string) — References the `session_id` of the agent that spawned this session. Absent on root/top-level and standalone sessions. Enables tree reconstruction without requiring callers to maintain external maps.

`agent_role` (enum: `"orchestrator"` | `"subagent"` | `"standalone"`) — Explicit node-type label. Allows a consumer to classify every session without inferring role from the presence/absence of `parent_session_id` alone.

**Payload schema validation**

`payload` now accepts an optional `$schema` property (string URI). When present, the validator resolves the schema from `schemas/payloads/` and validates the payload against it. Unknown or unresolvable `$schema` references produce a `[warn]` annotation but do not mark the event invalid, preserving backward compatibility. A built-in payload schema for `tool.called` is shipped at `schemas/payloads/tool-called.schema.json`.

### Migration guide: v0.1.0 → v0.2.0

1. **Update `specversion`** in every event from `"0.1.0"` to `"0.2.0"`. The `createEvent` factory handles this automatically; hand-crafted JSON files must be updated manually.

2. **`agent_role` and `parent_session_id` are optional** — no changes required for existing single-agent scenarios. Add `agent_role: "standalone"` to existing agents for clarity; it is not validated as required.

3. **Payload `$schema` is opt-in** — existing payloads without a `$schema` key continue to be accepted as plain objects with no change in behaviour.

4. **Validator warnings** — the updated `validateEvent()` returns entries prefixed with `[warn]` for unresolvable payload schemas. Callers that treat all `errors` entries as fatal should filter by the `[warn]` prefix or check the `valid` boolean (warnings do not flip it to `false`).
