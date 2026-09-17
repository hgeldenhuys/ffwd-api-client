/**
 * The send path. Resolves variables, applies inherited auth, enforces the
 * proxy policy per hop (with IP pinning when the runtime supports it),
 * performs the request with fetch (manual redirects, 30 s timeout, 10 MB
 * cap), and hides every secret value used in the response and the preview.
 */

import {
  PolicyError,
  checkTarget,
  hopRequest,
  nextRedirectUrl,
  allowedPrivateTargets,
  type IpRecord,
  type ProxyPolicyOptions,
} from "./proxy-policy";
import { applyAuth, buildScope, effectiveAuth, findRawItem, resolveRequest, secretNamesUsedIn } from "./resolve";
import type { UsedSecret } from "./hiding";
import { dedupeWarnings, hideBody, hideHeaders, hideSecrets } from "./hiding";
import type { Scope, Store } from "./store";
import { openSecret } from "./crypt";

export const RESPONSE_CAP_BYTES = 10 * 1024 * 1024;
export const SEND_TIMEOUT_MS = 30_000;

// ---- IP pinning probe -------------------------------------------------------
// Bun's fetch may support connecting to a pinned IP with a separate TLS server
// name (an undocumented `tls` option). Probe it once against a real host and
// remember the answer for the process lifetime.

type PinSupport = "yes" | "no";
let pinSupport: PinSupport | null = null;
let pinProbe: Promise<PinSupport> | null = null;

async function detectPinSupport(): Promise<PinSupport> {
  try {
    const dns = await import("node:dns/promises");
    const { address } = await dns.lookup("example.com");
    const res = await fetch(`https://${address}/`, {
      headers: { Host: "example.com" },
      tls: { serverName: "example.com" },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    } as RequestInit);
    await res.body?.cancel();
    // A TLS name mismatch would throw. Reaching a response means the pinned
    // connection verified against example.com's certificate.
    return "yes";
  } catch {
    return "no";
  }
}

export function pinnedFetchSupport(): Promise<PinSupport> {
  pinProbe ??= detectPinSupport();
  return pinProbe;
}

// ---- Types ------------------------------------------------------------------

export interface SendInput {
  collectionJson: any;
  collectionId: string | null;
  environmentJson: any | null;
  environmentId: string | null;
  itemPath: string;
  secretsInScope: { scope: Scope; scopeId: string; name: string }[];
  externalSignal?: AbortSignal;
}

export interface SendOutput {
  status: number | null;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  bodyBase64: string | null;
  hidden: boolean;
  notHiddenReason?: string;
  contentType: string;
  durationMs: number;
  sizeBytes: number;
  truncated: boolean;
  redirects: string[];
  resolvedRequestHidden: { method: string; url: string; headers: Record<string, string>; body: string | null };
  warnings: string[];
  error?: { code: string; message: string; details?: unknown };
}

// ---- Send -------------------------------------------------------------------


export async function performSend(
  store: Store,
  masterKey: Uint8Array,
  input: SendInput,
  policy: ProxyPolicyOptions = {}
): Promise<SendOutput> {
  const timeoutMs = policy.timeoutMs ?? SEND_TIMEOUT_MS;
  const maxBytes = policy.maxBytes ?? RESPONSE_CAP_BYTES;
  const allowPrivate = policy.allowPrivateTargets ?? allowedPrivateTargets();
  const started = performance.now();
  const warnings: string[] = [];

  // 1. Which secrets does this request reference? Resolve only those.
  const used: UsedSecret[] = [];
  const names = input.secretsInScope.map((s) => s.name);
  const rawNode = findRawItem(input.collectionJson, input.itemPath);
  const rawAuth = effectiveAuth(input.collectionJson, input.itemPath, rawNode?.auth ?? rawNode?.request?.auth ?? null);
  const usedNames = secretNamesUsedIn(rawNode ?? {}, rawAuth, names);
  for (const name of usedNames) {
    const entry = input.secretsInScope.find((s) => s.name === name)!;
    const sealed = store.getSecret(entry.scope, entry.scopeId, name);
    if (!sealed) continue;
    try {
      const value = await openSecret(masterKey, entry.scope, entry.scopeId, name, sealed);
      used.push({ name, value });
      store.touchSecret(entry.scope, entry.scopeId, name);
    } catch {
      return errorOutput(
        "secret_decrypt_failed",
        `The secret "${name}" could not be decrypted: the server's SECRETS_MASTER_KEY may have changed since it was set. Set the value again.`,
        { name },
        started,
        warnings
      );
    }
  }

  // 2. Resolve variables (secrets last = highest precedence) + inherited auth.
  const scope = buildScope(input.collectionJson, input.environmentJson, used);
  const found = resolveRequest(input.collectionJson, input.itemPath, scope);
  if (!found) {
    return errorOutput(
      "item_not_found",
      "The request could not be found in the collection: re-open the collection and try again.",
      { itemPath: input.itemPath },
      started,
      warnings
    );
  }
  const withAuth = applyAuth(found.auth, scope, found.resolved.url, found.resolved.headers);
  const url0 = withQuery(withAuth.url, found.resolved.queryParams);
  let bodyText = found.resolved.bodyText;
  let method = found.resolved.method;
  let currentHeaders = { ...withAuth.headers };
  if (bodyText !== null && !Object.keys(currentHeaders).some((k) => k.toLowerCase() === "content-type")) {
    currentHeaders["Content-Type"] = guessContentType(found.resolved.rawBodyMode ?? "raw", bodyText);
  }

  const policyFail = (err: unknown, url: string, headers: Record<string, string>, redirects: string[]) => {
    const code = err instanceof PolicyError ? err.code : "send_failed";
    const message =
      err instanceof PolicyError
        ? err.message
        : `The request could not be sent: ${hideSecrets(String((err as Error)?.message ?? err), used).text}`;
    return errorOutput(code, message, { url: hideSecrets(url, used).text }, started, warnings, redirects, method, headers, bodyText, used, url);
  };

  // 3. Policy on the first hop.
  let currentUrl: URL;
  let addresses: IpRecord[];
  let redirects: string[] = [];
  try {
    const checked = await checkTarget(url0, allowPrivate);
    currentUrl = checked.url;
    addresses = checked.addresses;
  } catch (err) {
    return policyFail(err, url0, currentHeaders, redirects);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  input.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  let cancelled = false;
  const noteAbort = () => {
    if (input.externalSignal?.aborted) cancelled = true;
  };
  controller.signal.addEventListener("abort", noteAbort, { once: true });

  const pin = allowPrivate ? null : await pinnedFetchSupport();
  let hop = 0;

  try {
    for (;;) {
      // IP pinning: connect to the checked address, keep Host + TLS SNI.
      let fetchUrl = currentUrl.toString();
      const hopHeaders = new Headers(currentHeaders);
      if (pin === "yes" && addresses.length > 0) {
        const port = currentUrl.port || (currentUrl.protocol === "https:" ? "443" : "80");
        fetchUrl = `${currentUrl.protocol}//${addresses[0].address}:${port}${currentUrl.pathname}${currentUrl.search}`;
        hopHeaders.set("Host", currentUrl.host);
      }

      const res = await fetch(fetchUrl, {
        method,
        headers: hopHeaders,
        body: method === "GET" || method === "HEAD" ? undefined : bodyText ?? undefined,
        redirect: "manual",
        signal: controller.signal,
        tls: pin === "yes" ? { serverName: currentUrl.hostname } : undefined,
      } as RequestInit);

      const next = nextRedirectUrl(currentUrl, res.status, res.headers.get("location"), hop);
      if (next) {
        redirects.push(`${res.status} → ${next.toString()}`);
        await res.body?.cancel();
        const hopped = hopRequest(new Headers(currentHeaders), currentUrl, next, res.status, method);
        currentUrl = next;
        method = hopped.method;
        if (hopped.dropBody) bodyText = null;
        currentHeaders = Object.fromEntries(hopped.headers.entries());
        try {
          const checked = await checkTarget(currentUrl.toString(), allowPrivate);
          addresses = checked.addresses;
        } catch (err) {
          return policyFail(err, currentUrl.toString(), currentHeaders, redirects);
        }
        hop++;
        continue;
      }

      // 4. Read the response under the 10 MB cap.
      const contentType = res.headers.get("content-type") ?? "";
      const isText =
        contentType === "" ||
        contentType.startsWith("text/") ||
        /\b(json|xml|javascript|html|x-www-form-urlencoded|csv|yaml|toml|graphql)\b/i.test(contentType);
      let sizeBytes = 0;
      let truncated = false;
      const chunks: Buffer[] = [];
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(Buffer.from(value));
            sizeBytes += value.byteLength;
            if (sizeBytes >= maxBytes) {
              truncated = true;
              await reader.cancel();
              break;
            }
          }
        }
      }
      const buf = Buffer.concat(chunks);
      const durationMs = Math.round(performance.now() - started);

      // 5. Hide every secret value in headers, body, and the preview.
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (responseHeaders[k] = v));
      const hiddenHeaders = hideHeaders(responseHeaders, used);
      warnings.push(...hiddenHeaders.warnings);
      const text = isText ? buf.toString("utf8") : null;
      const hiddenBody = hideBody(text, isText, contentType, used);
      warnings.push(...hiddenBody.warnings);

      return {
        status: res.status,
        statusText: res.statusText,
        headers: hiddenHeaders.headers,
        body: hiddenBody.body,
        bodyBase64: hiddenBody.base64,
        hidden: hiddenBody.hidden,
        notHiddenReason: hiddenBody.notHiddenReason,
        contentType,
        durationMs,
        sizeBytes,
        truncated,
        redirects,
        resolvedRequestHidden: {
          method,
          url: hideSecrets(url0, used).text,
          headers: hideHeaders(currentHeaders, used).headers,
          body: bodyText === null ? null : hideSecrets(bodyText, used).text,
        },
        warnings: dedupeWarnings(warnings),
      };
    }
  } catch (err: any) {
    noteAbort();
    const raw = String(err?.message ?? err);
    const hidden = hideSecrets(raw, used);
    warnings.push(...hidden.warnings);
    const aborted = err?.name === "AbortError" || err?.name === "TimeoutError";
    const code = aborted ? (cancelled ? "cancelled" : "timeout") : "send_failed";
    const message = aborted
      ? cancelled
        ? "The send was cancelled."
        : `The request timed out after ${timeoutMs / 1000} seconds: the server did not answer in time.`
      : hidden.text;
    return errorOutput(code, message, { cause: err?.cause ? String(err.cause) : "unknown" }, started, warnings, redirects, method, currentHeaders, bodyText, used, url0);
  } finally {
    clearTimeout(timeout);
    input.externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---- helpers ----------------------------------------------------------------

function withQuery(url: string, params: { key: string; value: string; enabled: boolean }[]): string {
  if (!params.length) return url;
  try {
    const u = new URL(url);
    for (const p of params) if (p.enabled && p.key) u.searchParams.set(p.key, p.value);
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + params.filter((p) => p.enabled && p.key).map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join("&");
  }
}

function guessContentType(mode: string | null, body: string): string {
  if (mode === "urlencoded") return "application/x-www-form-urlencoded";
  if (mode === "raw") {
    try {
      JSON.parse(body);
      return "application/json";
    } catch {
      return "text/plain";
    }
  }
  return "text/plain";
}

function errorOutput(
  code: string,
  message: string,
  details: unknown,
  started: number,
  warnings: string[],
  redirects: string[] = [],
  method = "GET",
  headers: Record<string, string> = {},
  bodyText: string | null = null,
  used: UsedSecret[] = [],
  url = ""
): SendOutput {
  return {
    status: null,
    statusText: "",
    headers: {},
    body: null,
    bodyBase64: null,
    hidden: false,
    contentType: "",
    durationMs: Math.round(performance.now() - started),
    sizeBytes: 0,
    truncated: false,
    redirects,
    resolvedRequestHidden: {
      method,
      url: hideSecrets(url, used).text,
      headers: hideHeaders(headers, used).headers,
      body: bodyText === null ? null : hideSecrets(bodyText, used).text,
    },
    warnings: dedupeWarnings(warnings),
    error: { code, message, details },
  };
}
