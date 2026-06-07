import { describe, expect, it } from "vitest";

import { canonicalize, canonicalizeV2, signEvent, verifySignature } from "../../src/signature";
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

// Known-answer for the v2 (deep) canonical form, produced by the SERVER
// reference implementation (src/_canonical.js canonicalizeV2 + HMAC) over
// FIXED_EVENT/SECRET. Locks the Node SDK's v2 byte-form to the server's.
const V2_REFERENCE_SIGNATURE = "M3OGzpZ4+SX0MStNZ0wJtb+TV+h/xcy9yPIRC0VaoJQ=";

describe("signature v2 (deep canonicalization — issue #59)", () => {
  it("v1 remains the default (no canon marker, envelope-only)", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET);
    expect(signed.signature?.value).toBe(PYTHON_SIGNATURE);
    expect(signed.signature?.canon).toBeUndefined();
  });

  it("signs v2 byte-identically to the server reference and marks canon", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET, { canon: "v2" });
    expect(signed.signature?.alg).toBe("hmac-sha256");
    expect(signed.signature?.canon).toBe("v2");
    expect(signed.signature?.value).toBe(V2_REFERENCE_SIGNATURE);
  });

  it("v2 canonical form includes the deep-sorted nested payload", () => {
    const canon = canonicalizeV2({ ...FIXED_EVENT });
    expect(canon).toContain('"payload":{"framework":"node","nested":{"a":1,"b":2}}');
    expect(canon.includes('"signature"')).toBe(false);
  });

  it("v2 round-trips and DETECTS nested payload tampering", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET, { canon: "v2" });
    expect(verifySignature(signed, SECRET)).toEqual({ valid: true });

    const tampered = { ...signed, payload: { framework: "node", nested: { b: 2, a: 999 } } };
    expect(verifySignature(tampered, SECRET).valid).toBe(false);
  });

  it("a v2-signed event with a v1 marker does NOT verify (version honoured)", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET, { canon: "v2" });
    signed.signature!.canon = "v1";
    expect(verifySignature(signed, SECRET).valid).toBe(false);
  });

  it("an unmarked deep signature still verifies (transition mode / Go interop)", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET, { canon: "v2" });
    delete signed.signature!.canon; // simulate an unmarked deep emitter
    expect(verifySignature(signed, SECRET).valid).toBe(true);
  });

  it("rejects an unknown canon value with a clear error", () => {
    const signed = signEvent({ ...FIXED_EVENT }, SECRET, { canon: "v2" });
    signed.signature!.canon = "v9";
    const res = verifySignature(signed, SECRET);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Unsupported signature canonicalization");
  });
});
