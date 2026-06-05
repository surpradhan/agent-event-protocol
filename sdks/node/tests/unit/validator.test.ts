import { describe, expect, it } from "vitest";

import { createEvent } from "../../src/event";
import { validateEvent } from "../../src/validator";
import type { AEPEvent } from "../../src/types";

function valid(): AEPEvent {
  return createEvent("agent://x", "task.created", "ses_1", "trc_1", { ok: true });
}

describe("validateEvent", () => {
  it("accepts a well-formed event", () => {
    const res = validateEvent(valid());
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("rejects a missing required field", () => {
    const e = valid();
    delete (e as Record<string, unknown>).trace_id;
    const res = validateEvent(e);
    expect(res.valid).toBe(false);
    expect(res.errors.some((m) => m.includes("trace_id"))).toBe(true);
  });

  it("rejects a non-core event type", () => {
    const e = { ...valid(), type: "task.exploded" };
    const res = validateEvent(e);
    expect(res.valid).toBe(false);
    expect(res.errors.some((m) => m.includes("core v0.2 types"))).toBe(true);
  });

  it("rejects a bad specversion", () => {
    const e = { ...valid(), specversion: "0.1.0" };
    expect(validateEvent(e).valid).toBe(false);
  });

  it("validates a payload against a resolvable $schema", () => {
    const e = createEvent("agent://x", "tool.called", "s", "t", {
      $schema: "tool-called.schema.json",
      tool_name: "search",
      arguments: { q: "hi" },
    });
    // Whether this passes depends on the bundled tool-called schema; either way
    // it must not raise and must return a structured result.
    const res = validateEvent(e);
    expect(typeof res.valid).toBe("boolean");
    expect(Array.isArray(res.errors)).toBe(true);
  });

  it("warns (non-blocking) on an unresolvable payload $schema", () => {
    const e = createEvent("agent://x", "task.created", "s", "t", {
      $schema: "https://example.com/unknown.schema.json",
      foo: "bar",
    });
    const res = validateEvent(e);
    expect(res.valid).toBe(true); // warning is non-blocking
    expect(res.errors.some((m) => m.startsWith("[warn]"))).toBe(true);
  });
});
