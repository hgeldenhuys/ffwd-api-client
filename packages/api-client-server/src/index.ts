/**
 * @ffwd/api-client-server — the API client's server core as an embeddable
 * package: no React, no DOM, no React Router. Mount `createApiClientHandler`
 * on any fetch-based router.
 */

// handler + error shape
export { createApiClientHandler, type CreateApiClientHandlerOptions } from "./handler";
export { apiError } from "./api-error";

// storage
export {
  SqliteStore,
  getStore,
  storeFromEnv,
  type Store,
  type Scope,
  type SecretRow,
  type CollectionRow,
  type EnvironmentRow,
  type HistoryRow,
} from "./store";

// auth
export {
  accessKeyAuth,
  anyOf,
  safeDest,
  type AuthFn,
  type AuthResult,
  SESSION_COOKIE,
  mintSessionToken,
  verifySessionToken,
  sessionCookie,
  clearSessionCookie,
  sessionFromRequest,
  constantTimeEqual,
} from "./session";

// proxy policy
export {
  PolicyError,
  checkTarget,
  checkUrlShape,
  resolveHost,
  assertAddressesAllowed,
  allowedPrivateTargets,
  isDeniedIp,
  parseIp,
  isDottedQuad,
  refuseNonCanonicalIpLiteral,
  nextRedirectUrl,
  hopRequest,
  MAX_REDIRECTS,
  type IpRecord,
  type ProxyPolicyOptions,
} from "./proxy-policy";

// send + resolution + hiding (for hosts that want the pieces)
export { performSend, pinnedFetchSupport, type SendInput, type SendOutput, RESPONSE_CAP_BYTES, SEND_TIMEOUT_MS } from "./sender";
export { buildScope, resolveRequest, applyAuth, effectiveAuth, secretNamesUsedIn } from "./resolve";
export { hideSecrets, hideHeaders, hideBody, dedupeWarnings, HIDE_MARK, MIN_HIDEABLE_LENGTH, type UsedSecret, type HideResult } from "./hiding";
export { importCollection, importEnvironment } from "./import-export";
export { sealSecret, openSecret } from "./crypt";

// host helpers (env validation; the handler itself never reads process.env)
export { loadEnv, getEnv, assertNotProductionOverride } from "./env";
