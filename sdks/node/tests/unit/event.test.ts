import { describe, expect, it } from "vitest";

import { createEvent } from "../../src/event";
import { CORE_EVENT_TYPES } from "../../src/types";

describe("createEvent", () => {
  it("builds a spec-compliant envelope with auto id + time", () => {
    const e = createEvent("agent://x", "task.created", "ses_1", "trc_1", { k: "v" });
    expect(e.specversion).toBe("0.2.0");
    expect(e.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(e.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(e.source).toBe("agent://x");
    expect(e.type).toBe("task.created");
    expect(e.session_id).toBe("ses_1");
    expect(e.trace_id).toBe("trc_1");
    expect(e.payload).toEqual({ k: "v" });
  });

  it("honors explicit id and time", () => {
    const e = createEvent(
      "agent://x",
      "tool.called",
      "s",
      "t",
      {},
      { id: "evt_fixed", time: "2026-01-01T00:00:00.000Z" },
    );
    expect(e.id).toBe("evt_fixed");
    expect(e.time).toBe("2026-01-01T00:00:00.000Z");
  });

  it("includes optional fields only when provided", () => {
    const e = createEvent(
      "agent://x",
      "task.created",
      "s",
      "t",
      {},
      {
        parentSessionId: "ses_parent",
        agentRole: "subagent",
        causationId: "evt_cause",
        labels: { env: "prod" },
      },
    );
    expect(e.parent_session_id).toBe("ses_parent");
    expect(e.agent_role).toBe("subagent");
    expect(e.causation_id).toBe("evt_cause");
    expect(e.labels).toEqual({ env: "prod" });
    // Unset optionals are absent (not null/undefined keys).
    expect("subject" in e).toBe(false);
    expect("tenant" in e).toBe(false);
  });

  it("rejects an unsupported event type", () => {
    expect(() => createEvent("agent://x", "not.a.type", "s", "t", {})).toThrow(
      /Unsupported event type/,
    );
  });

  it("rejects an invalid agent_role", () => {
    expect(() =>
      createEvent("agent://x", "task.created", "s", "t", {}, { agentRole: "boss" }),
    ).toThrow(/Invalid agent_role/);
  });

  it("accepts every core event type", () => {
    for (const t of CORE_EVENT_TYPES) {
      expect(() => createEvent("agent://x", t, "s", "t", {})).not.toThrow();
    }
  });
});
