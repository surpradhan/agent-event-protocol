const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { CORE_EVENT_TYPES } = require("./coreEventTypes");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const sanitized = raw.replace(/^\uFEFF/, "");
  return JSON.parse(sanitized);
}

const SCHEMAS_DIR = path.join(__dirname, "..", "schemas");
const envelopeSchemaPath = path.join(SCHEMAS_DIR, "aep-envelope.schema.json");
const payloadSchemasDir = path.join(SCHEMAS_DIR, "payloads");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const envelopeSchema = readJson(envelopeSchemaPath);
const validateEnvelopeSchema = ajv.compile(envelopeSchema);

// Build a registry of known payload schemas keyed by their $id URI.
// Schemas are loaded lazily on first reference to avoid startup cost.
const payloadSchemaCache = {};

function resolvePayloadSchema(schemaRef) {
  if (payloadSchemaCache[schemaRef]) {
    return payloadSchemaCache[schemaRef];
  }

  // 1. Try exact $id match among already-loaded schemas
  const existing = ajv.getSchema(schemaRef);
  if (existing) {
    payloadSchemaCache[schemaRef] = existing;
    return existing;
  }

  // 2. Try loading from the local schemas/payloads/ directory by convention.
  //    URI format: https://aep.dev/schemas/payloads/<filename>.schema.json
  //    or short-form: aep.payloads/<filename>
  if (!fs.existsSync(payloadSchemasDir)) {
    return null;
  }

  const uriBasename = schemaRef.split("/").pop();
  const candidate = path.join(payloadSchemasDir, uriBasename);

  if (!fs.existsSync(candidate)) {
    // Try adding .schema.json suffix if the ref doesn't end with it
    const withSuffix = candidate.endsWith(".schema.json")
      ? null
      : candidate + ".schema.json";
    if (!withSuffix || !fs.existsSync(withSuffix)) {
      return null;
    }
  }

  const resolvedPath = fs.existsSync(candidate) ? candidate : candidate + ".schema.json";

  try {
    const schema = readJson(resolvedPath);
    const validate = ajv.compile(schema);
    payloadSchemaCache[schemaRef] = validate;
    return validate;
  } catch (_) {
    return null;
  }
}

function validateEvent(event) {
  const schemaOk = validateEnvelopeSchema(event);
  const typeOk = CORE_EVENT_TYPES.includes(event?.type);

  const errors = [];

  if (!schemaOk) {
    errors.push(...(validateEnvelopeSchema.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`));
  }

  if (!typeOk) {
    errors.push(`type must be one of core v0.2 types; received '${event?.type}'`);
  }

  // Payload schema validation: if payload carries a $schema reference, validate against it.
  const payloadSchemaRef = event?.payload?.$schema;
  if (payloadSchemaRef) {
    const validatePayload = resolvePayloadSchema(payloadSchemaRef);
    if (validatePayload) {
      const payloadOk = validatePayload(event.payload);
      if (!payloadOk) {
        errors.push(
          ...(validatePayload.errors || []).map(
            (e) => `payload${e.instancePath || ""} ${e.message} (from $schema: ${payloadSchemaRef})`
          )
        );
      }
    } else {
      // Unknown schema reference — warn but do not fail (accept-any fallback preserved)
      errors.push(
        `[warn] payload.$schema '${payloadSchemaRef}' could not be resolved; payload accepted as-is`
      );
    }
  }

  // A warning-only payload.$schema miss should not mark the event invalid
  const payloadWarnOnly =
    payloadSchemaRef &&
    !resolvePayloadSchema(payloadSchemaRef) &&
    errors.some((e) => e.startsWith("[warn]"));

  const valid =
    schemaOk &&
    typeOk &&
    errors.filter((e) => !e.startsWith("[warn]")).length === 0;

  return { valid, errors };
}

module.exports = { validateEvent, CORE_EVENT_TYPES };
