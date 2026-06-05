import { describe, expect, it } from "vitest";

import { canonicalize, signEvent, verifySignature } from "../../src/signature";
import type { AEPEvent } from "../../src/types";

const SECRET = "shared-secret-123";

// A fixed event whose signature was produced by the PYTHON SDK (aep._signature)
// with the same secret. Locks the cross-language HMAC canonical-JSON contract:
// a Node-signed event must byte-match a Python-signed one (and verify under it).
const FIXED_EVENT: AEPEvent = {
  specversion: "0.2.0",
  id: "evt_fixedtest0001",
  time: "2026-06-05T12:00:00.000Z",
  source: "agent://node-parity",
  type: "task.created",
  session_id: "ses_parity01",
  trace_id: "trc_parity0001",
  payload: { framework: "node", nested: { b: 2, a: 1 } },
  agent_role: "orchestrator",
};
const PYTHON_SIGNATURE = "zPZDN4bGfJF4MJlyWu9HQXpkr5SlaqOAD9JUEj3Sev0=";

describe("signature", () => {
  it("cross-language parity: Node signs byte-identically to Python", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET);
    expect(signed.signature?.alg).toBe("hmac-sha256");
    expect(signed.signature?.value).toBe(PYTHON_SIGNATURE);
  });

  it("canonical form drops the signature field and sorts top-level keys", () => {
    const canon = canonicalize({ ...FIXED_EVENT, signature: { alg: "x", value: "y" } });
    // signature removed; keys alphabetical; nested payload emptied by the
    // replacer-array form (the documented cross-language canonical behavior).
    expect(
      canon.startsWith('{"agent_role":"orchestrator","id":"evt_fixedtest0001","payload":{}'),
    ).toBe(true);
    expect(canon.includes('"signature"')).toBe(false);
  });

  it("round-trips: a signed event verifies with the same secret", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET);
    expect(verifySignature(signed, SECRET)).toEqual({ valid: true });
  });

  it("verifies the Python-produced signature", () => {
    const event = { ...FIXED_EVENT, signature: { alg: "hmac-sha256", value: PYTHON_SIGNATURE } };
    expect(verifySignature(event, SECRET).valid).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET);
    const res = verifySignature(signed, "wrong-secret");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Signature mismatch");
  });

  it("rejects a missing signature field", () => {
    expect(verifySignature({ ...FIXED_EVENT }, SECRET)).toEqual({
      valid: false,
      error: "Event is missing a 'signature' field",
    });
  });

  it("rejects an unsupported algorithm", () => {
    const event = { ...FIXED_EVENT, signature: { alg: "rsa", value: "x" } };
    const res = verifySignature(event, SECRET);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Unsupported signature algorithm");
  });

  it("rejects a non-string signature.value", () => {
    const event = { ...FIXED_EVENT, signature: { alg: "hmac-sha256" } as never };
    const res = verifySignature(event, SECRET);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("signature.value is missing or not a string");
  });

  it("never throws on malformed base64", () => {
    const event = { ...FIXED_EVENT, signature: { alg: "hmac-sha256", value: "!!!notb64!!!" } };
    expect(verifySignature(event, SECRET).valid).toBe(false);
  });
});
