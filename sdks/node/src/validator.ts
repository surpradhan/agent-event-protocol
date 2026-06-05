/**
 * Event validation against the AEP v0.2.0 envelope schema (+ optional payload
 * schema). Mirrors `sdks/python/aep/_validator.py` / the server's
 * `src/validator.js`. Schemas are bundled (imported JSON, inlined by the
 * bundler), so there is no runtime file I/O.
 */

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import envelopeSchema from "./schemas/aep-envelope.schema.json" with { type: "json" };
import toolCalledSchema from "./schemas/payloads/tool-called.schema.json" with { type: "json" };
import { AEPEvent, CORE_EVENT_TYPES, ValidationResult } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const envelopeValidator: ValidateFunction = ajv.compile(envelopeSchema);

// Payload schemas, keyed by file basename, resolved from a payload's `$schema`.
const PAYLOAD_VALIDATORS: Record<string, ValidateFunction> = {
  "tool-called.schema.json": ajv.compile(toolCalledSchema),
};

function sanitize(value: unknown, maxLen = 100): string {
  return String(value ?? "")
    .slice(0, maxLen)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function resolvePayloadValidator(schemaRef: string): ValidateFunction | null {
  const basename = schemaRef.split("/").pop() ?? schemaRef;
  if (PAYLOAD_VALIDATORS[basename]) return PAYLOAD_VALIDATORS[basename];
  if (!basename.endsWith(".schema.json")) {
    const withExt = `${basename}.schema.json`;
    if (PAYLOAD_VALIDATORS[withExt]) return PAYLOAD_VALIDATORS[withExt];
  }
  return null;
}

/**
 * Validate `event` against the AEP v0.2.0 envelope schema, the core event-type
 * list, and (if `payload.$schema` resolves to a bundled schema) the payload.
 * Returns `{ valid, errors }`; `errors` entries prefixed `[warn]` are
 * non-blocking warnings.
 */
export function validateEvent(event: AEPEvent): ValidationResult {
  const errors: string[] = [];

  const schemaOk = envelopeValidator(event);
  if (!schemaOk && envelopeValidator.errors) {
    for (const err of envelopeValidator.errors) {
      const path = err.instancePath || "/";
      errors.push(`${path} ${err.message}`);
    }
  }

  const rawType = event && typeof event === "object" ? event.type : undefined;
  const typeOk =
    !!event && typeof event === "object" && CORE_EVENT_TYPES.includes(rawType as string);
  if (!typeOk) {
    errors.push(`type must be one of core v0.2 types; received '${sanitize(rawType)}'`);
  }

  // Optional payload-schema validation, keyed off payload.$schema.
  let payloadSchemaRef: string | undefined;
  const payload = event && typeof event === "object" ? event.payload : undefined;
  if (payload && typeof payload === "object") {
    const ref = (payload as Record<string, unknown>)["$schema"];
    if (typeof ref === "string") payloadSchemaRef = ref;
  }

  if (payloadSchemaRef) {
    const pv = resolvePayloadValidator(payloadSchemaRef);
    if (pv) {
      const ok = pv(payload);
      if (!ok && pv.errors) {
        for (const err of pv.errors) {
          const path = `payload${err.instancePath || ""}`;
          errors.push(`${path} ${err.message} (from $schema: ${sanitize(payloadSchemaRef)})`);
        }
      }
    } else {
      errors.push(
        `[warn] payload.$schema '${sanitize(payloadSchemaRef)}' could not be resolved; ` +
          "payload accepted as-is",
      );
    }
  }

  const blocking = errors.filter((e) => !e.startsWith("[warn]"));
  return { valid: Boolean(schemaOk) && typeOk && blocking.length === 0, errors };
}
