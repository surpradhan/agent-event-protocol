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

const envelopeSchemaPath = path.join(__dirname, "..", "schemas", "aep-envelope.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const envelopeSchema = readJson(envelopeSchemaPath);
const validateEnvelopeSchema = ajv.compile(envelopeSchema);

function validateEvent(event) {
  const schemaOk = validateEnvelopeSchema(event);
  const typeOk = CORE_EVENT_TYPES.includes(event?.type);

  const errors = [];

  if (!schemaOk) {
    errors.push(...(validateEnvelopeSchema.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`));
  }

  if (!typeOk) {
    errors.push(`type must be one of core v0.1 types; received '${event?.type}'`);
  }

  return { valid: schemaOk && typeOk, errors };
}

module.exports = { validateEvent, CORE_EVENT_TYPES };
