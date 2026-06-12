"use strict";

/**
 * src/customQuery.js — safe user-defined analytics queries (Phase 15-B)
 *
 * Implements the PRD §Phase 15 "Custom analytics: user-defined queries over event
 * streams" as a **structured, parameterised query model — NOT arbitrary SQL**.
 *
 * Security model (this is the whole point of the module):
 *   1. A query is a JSON *spec* (filters + group_by + aggregations + window), never
 *      a string of SQL. Values are only ever compared as data; nothing the caller
 *      supplies is concatenated into a query.
 *   2. Every field reference is validated against a whitelist. Top-level fields are
 *      an explicit allow-list; nested access is limited to `payload.*`, `labels.*`,
 *      and `extensions.*` dot-paths, resolved by safely walking the parsed envelope.
 *   3. Dot-path resolution is hardened against prototype pollution — the segments
 *      `__proto__`, `prototype`, and `constructor` are rejected at validation time
 *      and never traversed.
 *   4. The storage layer fetches the tenant-scoped, time-windowed raw envelopes with
 *      a trivial, dialect-identical SELECT; ALL filtering / grouping / aggregation
 *      happens here in pure JS. So there is no injection surface and no SQLite-vs-
 *      Postgres divergence (mirrors src/analytics.js and src/performance.js).
 *
 * `runQuery` is pure (no I/O, clock only via injected `now`), so the whole model is
 * unit-testable against fabricated events with zero database.
 */

// Bucket label for a missing/blank group key, so every event is counted once.
const UNSPECIFIED = "(unspecified)";

// Top-level envelope fields a query may filter or group on.
const TOP_LEVEL_FIELDS = new Set([
  "id",
  "type",
  "source",
  "session_id",
  "trace_id",
  "parent_session_id",
  "causation_id",
  "agent_role",
  "subject",
  "time",
  "tenant"
]);

// Nested roots whose `<root>.<path>` dot-paths may be referenced.
const NESTED_ROOTS = new Set(["payload", "labels", "extensions"]);

// Path segments that must never be traversed (prototype-pollution guard).
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

const FILTER_OPS = new Set([
  "eq",
  "ne",
  "in",
  "nin",
  "exists",
  "not_exists",
  "prefix",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte"
]);

const VALUELESS_OPS = new Set(["exists", "not_exists"]);
const ARRAY_OPS = new Set(["in", "nin"]);

const TIME_BUCKETS = new Set(["hour", "day", "month"]);

const MAX_FILTERS = 25;
const MAX_GROUP_BY = 5;
const MAX_AGGREGATIONS = 10;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Validate a field reference against the whitelist.
 * @param {*} field
 * @returns {string|null} an error message, or null if valid.
 */
function validateFieldRef(field) {
  if (typeof field !== "string" || field.trim() === "") {
    return "field must be a non-empty string";
  }
  if (TOP_LEVEL_FIELDS.has(field)) return null;

  const dot = field.indexOf(".");
  if (dot === -1) {
    return `unknown field '${field}'`;
  }
  const root = field.slice(0, dot);
  const rest = field.slice(dot + 1);
  if (!NESTED_ROOTS.has(root)) {
    return `field root '${root}' is not queryable (allowed: ${[...NESTED_ROOTS].join(", ")} or a top-level field)`;
  }
  if (rest === "") return `field '${field}' has an empty path`;
  for (const seg of rest.split(".")) {
    if (seg === "") return `field '${field}' has an empty path segment`;
    if (FORBIDDEN_SEGMENTS.has(seg)) return `field '${field}' references a forbidden segment '${seg}'`;
  }
  return null;
}

/**
 * Safely resolve a (pre-validated) field reference on an event envelope.
 * Returns `undefined` when any segment is missing or a non-object is traversed.
 * Only own-enumerable properties are read; forbidden segments never reach here
 * (validation rejects them) but are double-guarded anyway.
 * @param {object} event
 * @param {string} field
 * @returns {*}
 */
function resolveField(event, field) {
  if (!event || typeof event !== "object") return undefined;
  if (TOP_LEVEL_FIELDS.has(field)) return event[field];

  const dot = field.indexOf(".");
  const root = field.slice(0, dot);
  const rest = field.slice(dot + 1);
  let cur = event[root];
  for (const seg of rest.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (FORBIDDEN_SEGMENTS.has(seg)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Coerce two values for an ordered (gt/gte/lt/lte) comparison.
 * Numeric when both look numeric; otherwise string (lexicographic — correct for
 * ISO-8601 timestamps).
 * @returns {number} -1 / 0 / 1, or NaN if `a` is null/undefined.
 */
function compareOrdered(a, b) {
  if (a === null || a === undefined) return NaN;
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && a !== "" && b !== "") {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Evaluate one filter against one event. */
function matchFilter(event, filter) {
  const actual = resolveField(event, filter.field);

  // exists / not_exists are presence checks (objects count as present).
  if (filter.op === "exists") return actual !== undefined && actual !== null;
  if (filter.op === "not_exists") return actual === undefined || actual === null;

  // For the scalar comparison operators, a non-scalar (object/array) value is
  // treated the same as a missing value rather than stringified to
  // "[object Object]": eq/in/prefix/contains/gt… never match; ne/nin do match
  // (a non-scalar is "not equal to" any scalar) — consistent with how a missing
  // field behaves.
  if (actual !== null && typeof actual === "object") {
    return filter.op === "ne" || filter.op === "nin";
  }

  switch (filter.op) {
    case "eq":
      return actual !== undefined && actual !== null && String(actual) === String(filter.value);
    case "ne":
      return !(actual !== undefined && actual !== null && String(actual) === String(filter.value));
    case "in":
      return actual !== undefined && actual !== null && filter.value.some((v) => String(v) === String(actual));
    case "nin":
      return !(actual !== undefined && actual !== null && filter.value.some((v) => String(v) === String(actual)));
    case "prefix":
      return typeof actual !== "undefined" && actual !== null && String(actual).startsWith(String(filter.value));
    case "contains":
      return typeof actual !== "undefined" && actual !== null && String(actual).includes(String(filter.value));
    case "gt":
      return compareOrdered(actual, filter.value) > 0;
    case "gte":
      return compareOrdered(actual, filter.value) >= 0;
    case "lt": {
      const c = compareOrdered(actual, filter.value);
      return !Number.isNaN(c) && c < 0;
    }
    case "lte": {
      const c = compareOrdered(actual, filter.value);
      return !Number.isNaN(c) && c <= 0;
    }
    default:
      return false;
  }
}

/** Coerce a resolved value to a stable group-key string. */
function groupKeyValue(v) {
  if (v === undefined || v === null) return UNSPECIFIED;
  if (typeof v === "object") {
    // Objects/arrays aren't sensible group keys — fold to a single bucket.
    return UNSPECIFIED;
  }
  const s = String(v);
  return s === "" ? UNSPECIFIED : s;
}

/** Derive the time-bucket label for an event given a granularity. */
function timeBucket(event, granularity) {
  const t = event && typeof event.time === "string" ? event.time : "";
  if (t.length < 7) return UNSPECIFIED;
  switch (granularity) {
    case "month":
      return t.slice(0, 7); // YYYY-MM
    case "day":
      return t.length >= 10 ? t.slice(0, 10) : UNSPECIFIED; // YYYY-MM-DD
    case "hour":
      return t.length >= 13 ? t.slice(0, 13) : UNSPECIFIED; // YYYY-MM-DDTHH
    default:
      return UNSPECIFIED;
  }
}

/**
 * Validate (and normalise) a query spec.
 * @param {*} spec
 * @returns {{ ok: boolean, errors: string[], normalized: object|null }}
 */
function validateQuerySpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, errors: ["query spec must be a JSON object"], normalized: null };
  }

  // ----- filters -----
  let filters = [];
  if (spec.filters !== undefined) {
    if (!Array.isArray(spec.filters)) {
      errors.push("filters must be an array");
    } else if (spec.filters.length > MAX_FILTERS) {
      errors.push(`too many filters (max ${MAX_FILTERS})`);
    } else {
      spec.filters.forEach((f, i) => {
        if (!f || typeof f !== "object") {
          errors.push(`filters[${i}] must be an object`);
          return;
        }
        const fieldErr = validateFieldRef(f.field);
        if (fieldErr) errors.push(`filters[${i}].${fieldErr}`);
        if (!FILTER_OPS.has(f.op)) {
          errors.push(`filters[${i}].op '${f.op}' is not a valid operator`);
          return;
        }
        if (ARRAY_OPS.has(f.op)) {
          if (!Array.isArray(f.value) || f.value.length === 0) {
            errors.push(`filters[${i}] op '${f.op}' requires a non-empty 'value' array`);
          }
        } else if (!VALUELESS_OPS.has(f.op)) {
          if (f.value === undefined || f.value === null || typeof f.value === "object") {
            errors.push(`filters[${i}] op '${f.op}' requires a scalar 'value'`);
          }
        }
      });
    }
    filters = Array.isArray(spec.filters) ? spec.filters : [];
  }

  // ----- group_by -----
  let groupBy = [];
  if (spec.group_by !== undefined) {
    if (!Array.isArray(spec.group_by)) {
      errors.push("group_by must be an array of field names");
    } else if (spec.group_by.length > MAX_GROUP_BY) {
      errors.push(`too many group_by fields (max ${MAX_GROUP_BY})`);
    } else {
      spec.group_by.forEach((field, i) => {
        const err = validateFieldRef(field);
        if (err) errors.push(`group_by[${i}]: ${err}`);
      });
      groupBy = spec.group_by.slice();
    }
  }

  // ----- time_bucket -----
  let timeBkt = null;
  if (spec.time_bucket !== undefined && spec.time_bucket !== null) {
    if (!TIME_BUCKETS.has(spec.time_bucket)) {
      errors.push(`time_bucket must be one of: ${[...TIME_BUCKETS].join(", ")}`);
    } else {
      timeBkt = spec.time_bucket;
    }
  }

  // ----- aggregations -----
  let aggs = [{ op: "count" }];
  if (spec.aggregations !== undefined) {
    if (!Array.isArray(spec.aggregations)) {
      errors.push("aggregations must be an array");
    } else if (spec.aggregations.length > MAX_AGGREGATIONS) {
      errors.push(`too many aggregations (max ${MAX_AGGREGATIONS})`);
    } else {
      const normalized = [];
      spec.aggregations.forEach((a, i) => {
        if (!a || typeof a !== "object") {
          errors.push(`aggregations[${i}] must be an object`);
          return;
        }
        if (a.op === "count") {
          normalized.push({ op: "count" });
        } else if (a.op === "count_distinct") {
          const err = validateFieldRef(a.field);
          if (err) errors.push(`aggregations[${i}]: ${err}`);
          else normalized.push({ op: "count_distinct", field: a.field });
        } else {
          errors.push(`aggregations[${i}].op '${a.op}' is not supported (use 'count' or 'count_distinct')`);
        }
      });
      // Always guarantee a count so a group always has a magnitude.
      if (!normalized.some((a) => a.op === "count")) normalized.unshift({ op: "count" });
      aggs = normalized;
    }
  }

  // ----- window + limit -----
  for (const bound of ["since", "until"]) {
    if (spec[bound] !== undefined && spec[bound] !== null) {
      if (typeof spec[bound] !== "string" || Number.isNaN(Date.parse(spec[bound]))) {
        errors.push(`${bound} must be an ISO-8601 timestamp`);
      }
    }
  }

  let limit = DEFAULT_LIMIT;
  if (spec.limit !== undefined && spec.limit !== null) {
    const n = Number(spec.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      errors.push(`limit must be an integer in [1, ${MAX_LIMIT}]`);
    } else {
      limit = n;
    }
  }

  if (errors.length) return { ok: false, errors, normalized: null };

  return {
    ok: true,
    errors: [],
    normalized: {
      filters,
      group_by: groupBy,
      time_bucket: timeBkt,
      aggregations: aggs,
      since: spec.since ?? null,
      until: spec.until ?? null,
      limit
    }
  };
}

/**
 * Run a (normalised) query spec over a set of event envelopes. Pure.
 *
 * The caller is responsible for tenant-scoping and (optionally) pre-windowing the
 * events; `since`/`until` in the spec are re-applied here so the function is
 * self-contained and testable.
 *
 * @param {Array<object>} events  raw event envelopes (any order)
 * @param {object} spec           a spec from validateQuerySpec().normalized
 * @param {{ now?: Date }} [opts]
 * @returns {{
 *   total_matched: number,
 *   rows: Array<object>,
 *   group_by: string[],
 *   time_bucket: string|null,
 *   aggregations: string[],
 *   truncated: boolean,
 *   generated_at: string
 * }}
 */
function runQuery(events, spec, { now = new Date() } = {}) {
  const list = Array.isArray(events) ? events : [];
  const { filters, group_by: groupBy, time_bucket: timeBkt, aggregations, since, until, limit } = spec;

  const distinctAggs = aggregations.filter((a) => a.op === "count_distinct");

  const groups = new Map(); // key string -> { group, count, distinct: Map<field, Set> }
  let totalMatched = 0;

  for (const ev of list) {
    // Window (inclusive since, exclusive until) on event time, matching the rest
    // of the store's lexicographic-on-ISO model.
    const t = ev && typeof ev.time === "string" ? ev.time : "";
    if (since && !(t >= since)) continue;
    if (until && !(t < until)) continue;

    if (!filters.every((f) => matchFilter(ev, f))) continue;
    totalMatched += 1;

    // Build the group descriptor (ordered: group_by fields, then time bucket).
    const groupObj = {};
    const keyParts = [];
    for (const field of groupBy) {
      const val = groupKeyValue(resolveField(ev, field));
      groupObj[field] = val;
      keyParts.push(`${field}=${val}`);
    }
    if (timeBkt) {
      const b = timeBucket(ev, timeBkt);
      groupObj._bucket = b;
      keyParts.push(`_bucket=${b}`);
    }
    const key = JSON.stringify(keyParts);

    let g = groups.get(key);
    if (!g) {
      g = { group: groupObj, count: 0, distinct: new Map() };
      for (const a of distinctAggs) g.distinct.set(a.field, new Set());
      groups.set(key, g);
    }
    g.count += 1;
    for (const a of distinctAggs) {
      const v = resolveField(ev, a.field);
      if (v !== undefined && v !== null) g.distinct.get(a.field).add(String(v));
    }
  }

  let rows = [...groups.values()].map((g) => {
    const row = { group: g.group, count: g.count };
    if (distinctAggs.length) {
      row.distinct = {};
      for (const [field, set] of g.distinct) row.distinct[field] = set.size;
    }
    return row;
  });

  // Deterministic: count desc, then group key asc.
  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return JSON.stringify(a.group).localeCompare(JSON.stringify(b.group));
  });

  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);

  return {
    total_matched: totalMatched,
    rows,
    group_by: groupBy,
    time_bucket: timeBkt,
    aggregations: aggregations.map((a) => (a.op === "count" ? "count" : `count_distinct:${a.field}`)),
    truncated,
    generated_at: now.toISOString()
  };
}

module.exports = {
  validateQuerySpec,
  runQuery,
  resolveField,
  validateFieldRef,
  UNSPECIFIED,
  TOP_LEVEL_FIELDS,
  FILTER_OPS
};
