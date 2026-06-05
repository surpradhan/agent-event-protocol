/**
 * `@surpradhan/aep` — Node.js / TypeScript SDK for the Agent Event Protocol.
 *
 * Phase 12g (PR1) ships the SDK core: event factory, validation, HMAC signing,
 * and the ingest/query client — mirroring the Python and Go SDKs. Framework
 * auto-instrumentation (`instrument()` for LangChain.js) lands in PR2.
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
export { signEvent, verifySignature, canonicalize } from "./signature.js";
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
