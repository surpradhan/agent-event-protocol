/**
 * `@surpradhan/aep` — Node.js / TypeScript SDK for the Agent Event Protocol.
 *
 * Ships the SDK core: event factory, validation, HMAC signing, and the
 * ingest/query client — mirroring the Python and Go SDKs. Also exports
 * `instrument()` for LangChain.js/LangGraph framework auto-instrumentation.
 */

export {
  EventType,
  AgentRole,
  CORE_EVENT_TYPES,
  type AEPEvent,
  type ValidationResult,
  type SignatureResult,
} from "./types.js";
export { DEFAULT_SERVER_URL, SPEC_VERSION } from "./constants.js";
export { createEvent, type CreateEventOptions } from "./event.js";
export { validateEvent } from "./validator.js";
export {
  signEvent,
  verifySignature,
  canonicalize,
  canonicalizeV2,
  stableStringify,
  type SignOptions,
} from "./signature.js";
export { verifyAuditBundle, type AuditVerification, type AuditPerEvent } from "./audit.js";
export { handleResponse, parseRetryAfter } from "./http.js";
export {
  AEPClient,
  type AEPClientOptions,
  type ListParams,
  type SessionEventParams,
} from "./client.js";
export {
  AEPError,
  AEPValidationError,
  AEPAuthError,
  AEPRateLimitError,
  AEPNotFoundError,
  AEPConnectionError,
  AEPServerError,
} from "./exceptions.js";
export {
  instrument,
  uninstrument,
  flush,
  EmissionCore,
  LangGraphMapper,
  type InstrumentOptions,
  type ChainStartInfo,
  type ToolStartInfo,
} from "./instrument.js";
