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
import {
  collectScripts,
  resolveSecretEntries,
  runScriptPhase,
  applyVarOps,
  sanitiseScriptOutput,
  sanitiseText,
  hideScriptText,
  originOf,
  auditLog,
  isTrustedCollection,
  CAPS,
  TOTAL_SCRIPT_BUDGET_MS,
  type VarOp,
  type PersistResult,
} from "./scripts/run";

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

export interface ScriptPhaseReport {
  console: string[];
  error?: { message: string; line?: number };
  truncated?: true;
}

export interface ScriptTestsReport extends ScriptPhaseReport {
  results: { name: string; passed: boolean; error?: string }[];
}

export interface SendScriptsReport {
  prerequest: ScriptPhaseReport;
  tests: ScriptTestsReport;
  variablesChanged: { scope: Scope; scopeId: string; name: string; secret: boolean; persisted: boolean; reason?: string }[];
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
  /** Present when the collection carries scripts (even when a phase failed). */
  scripts?: SendScriptsReport;
}

// ---- Send -------------------------------------------------------------------


export function isTrustedForScripts(collectionJson: any): boolean {
  return isTrustedCollection(collectionJson);
}

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
  let url0 = withQuery(withAuth.url, found.resolved.queryParams);
  let bodyText = found.resolved.bodyText;
  let method = found.resolved.method;
  let currentHeaders = { ...withAuth.headers };
  if (bodyText !== null && !Object.keys(currentHeaders).some((k) => k.toLowerCase() === "content-type")) {
    currentHeaders["Content-Type"] = guessContentType(found.resolved.rawBodyMode ?? "raw", bodyText);
  }

  // ---- scripts: pre-request phase -------------------------------------------
  // The stored request is never touched: mutations apply to this send only.
  const trusted = isTrustedCollection(input.collectionJson);
  const prereqScripts = collectScripts(input.collectionJson, input.itemPath, "prerequest");
  const testScripts = collectScripts(input.collectionJson, input.itemPath, "test");
  const hasScripts = prereqScripts.length > 0 || testScripts.length > 0;
  const scriptSecretEntries = hasScripts
    ? await resolveSecretEntries(store, masterKey, input.secretsInScope, trusted)
    : [];
  let scriptElapsedMs = 0;
  let varOps: VarOp[] = [];
  const scriptReads: { name: string; scope: string }[] = [];
  const rawPhases: {
    prerequest: { console: string[]; error?: { message: string; line?: number; script?: string }; truncated: boolean } | null;
    tests: { tests: { name: string; passed: boolean; error?: string }[]; console: string[]; error?: { message: string; line?: number; script?: string }; truncated: boolean } | null;
  } = { prerequest: null, tests: null };

  if (prereqScripts.length > 0) {
    const phase = await runScriptPhase({
      collectionJson: input.collectionJson,
      collectionId: input.collectionId!,
      environmentJson: input.environmentJson,
      environmentId: input.environmentId,
      itemPath: input.itemPath,
      requestName: requestDisplayName(input.collectionJson, input.itemPath, rawNode),
      trusted,
      listen: "prerequest",
      request: {
        method,
        url: url0,
        headers: Object.entries(currentHeaders) as [string, string][],
        body: bodyText,
        bodyMode: found.resolved.rawBodyMode,
        authType: found.auth?.type ?? null,
      },
      secrets: scriptSecretEntries,
      response: null,
      writesAlready: 0,
      timeLimitMs: TOTAL_SCRIPT_BUDGET_MS,
    });
    scriptElapsedMs += phase.elapsedMs;

    if (!phase.ok) {
      // sandbox crash (R5) or unknown worker failure — house error, no send
      return errorOutput(
        "script_sandbox_crashed",
        "the script sandbox crashed and was restarted; the send was not performed",
        { reason: phase.crashed ?? "unknown" },
        started,
        warnings
      );
    }
    rawPhases.prerequest = {
      console: phase.console ?? [],
      error: phase.error,
      truncated: phase.truncated === true,
    };

    if (phase.error) {
      const where = phase.error.script ?? "unknown";
      const line = phase.error.line !== undefined ? ` at line ${phase.error.line}` : "";
      return errorOutput(
        "prerequest_failed",
        `The pre-request script (${where}) failed${line}: ${phase.error.message}`,
        { script: where, line: phase.error.line },
        started,
        warnings
      );
    }

    // Apply this-send-only request mutations (caps re-checked host-side).
    const mutated = phase.request;
    if (mutated) {
      const capFail = checkScriptRequestCaps(mutated);
      if (capFail) {
        return errorOutput("prerequest_failed", `The pre-request script (${phase.urlSetBy ?? "unknown"}) exceeded a cap: ${capFail}`, {}, started, warnings);
      }
      method = String(mutated.method ?? method).toUpperCase();
      if (typeof mutated.url === "string" && mutated.url) {
        // untrusted collections may not move the request to another origin (R2c)
        if (!trusted && originOf(mutated.url) !== originOf(url0)) {
          return errorOutput(
            "script_origin_refused",
            `The send was refused: a pre-request script (${phase.urlSetBy ?? "unknown"}) changed the request's origin, and scripts in this collection are untrusted. Turn on "Trusted scripts" for the collection (collection settings) only if you wrote or have read them.`,
            { storedOrigin: originOf(url0), scriptOrigin: originOf(mutated.url) },
            started,
            warnings
          );
        }
        url0 = mutated.url;
      }
      if (Array.isArray(mutated.headers)) {
        currentHeaders = {};
        for (const [k, v] of mutated.headers) {
          if (typeof k === "string" && typeof v === "string") currentHeaders[k] = v;
        }
      }
      if (mutated.body === null || typeof mutated.body === "string") {
        bodyText = mutated.body;
      }
      if (bodyText !== null && !Object.keys(currentHeaders).some((k) => k.toLowerCase() === "content-type")) {
        currentHeaders["Content-Type"] = guessContentType(mutated.bodyMode ?? "raw", bodyText);
      }
    }
    varOps = phase.varOps ?? [];
    scriptReads.push(...(phase.secretReads ?? []));
  }


  const policyFail = async (err: unknown, url: string, headers: Record<string, string>, redirects: string[]) => {
    const merged = await mergeScriptSecrets(used, varOps, scriptSecretEntries, trusted, input, scriptReads);
    const code = err instanceof PolicyError ? err.code : "send_failed";
    const message =
      err instanceof PolicyError
        ? err.message
        : `The request could not be sent: ${hideSecrets(String((err as Error)?.message ?? err), merged).text}`;
    return errorOutput(code, message, { url: hideSecrets(url, merged).text }, started, warnings, redirects, method, headers, bodyText, merged, url);
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
    return await policyFail(err, url0, currentHeaders, redirects);
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
          return await policyFail(err, currentUrl.toString(), currentHeaders, redirects);
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
      const text = isText ? buf.toString("utf8") : null;

      // 5. Hide every secret value in headers, body, and the preview.
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (responseHeaders[k] = v));

      // ---- scripts: test phase (on the RAW response; hiding happens below) ----
      let persisted: PersistResult = { variablesChanged: [] };
      if (testScripts.length > 0) {
        const remaining = Math.max(0, TOTAL_SCRIPT_BUDGET_MS - scriptElapsedMs);
        if (remaining <= 0) {
          rawPhases.tests = { tests: [], console: [], truncated: false, error: { message: "script time budget exhausted (10 s per send)" } };
        } else {
          const phase = await runScriptPhase({
            collectionJson: input.collectionJson,
            collectionId: input.collectionId!,
            environmentJson: input.environmentJson,
            environmentId: input.environmentId,
            itemPath: input.itemPath,
            requestName: requestDisplayName(input.collectionJson, input.itemPath, rawNode),
            trusted,
            listen: "test",
            request: {
              method,
              url: url0,
              headers: Object.entries(currentHeaders) as [string, string][],
              body: bodyText,
              bodyMode: found.resolved.rawBodyMode,
              authType: found.auth?.type ?? null,
            },
            secrets: scriptSecretEntries,
            response: {
              code: res.status,
              status: res.statusText,
              responseTime: durationMs,
              responseSize: sizeBytes,
              headers: [...res.headers.entries()] as [string, string][],
              bodyText: text,
            },
            writesAlready: varOps.length,
            timeLimitMs: remaining,
          });
          scriptElapsedMs += phase.elapsedMs;
          if (!phase.ok) {
            return errorOutput(
              "script_sandbox_crashed",
              "the script sandbox crashed and was restarted; the send was not performed",
              { reason: phase.crashed ?? "unknown" },
              started,
              warnings
            );
          }
          rawPhases.tests = {
            tests: phase.tests ?? [],
            console: phase.console ?? [],
            error: phase.error,
            truncated: phase.truncated === true,
          };
          varOps = varOps.concat(phase.varOps ?? []);
          scriptReads.push(...(phase.secretReads ?? []));
        }
      }

      // Persist what scripts changed, after the test phase (trusted) or as
      // this-send-only changes with a reason (untrusted, R2b).
      if (hasScripts && varOps.length > 0) {
        persisted = await applyVarOps(store, masterKey, {
          trusted,
          collectionId: input.collectionId!,
          collectionJson: input.collectionJson,
          environmentId: input.environmentId,
          environmentJson: input.environmentJson,
          collectionName: input.collectionJson?.info?.name ?? "Collection",
          environmentName: input.environmentJson?.name ?? null,
          itemPath: input.itemPath,
          varOps,
        });
      }

      // Secrets a script READ or WROTE join the hide set for everything below.
      const mergedUsed = await mergeScriptSecrets(used, varOps, scriptSecretEntries, trusted, input, scriptReads);

      const hiddenHeaders = hideHeaders(responseHeaders, mergedUsed);
      warnings.push(...hiddenHeaders.warnings);
      const hiddenBody = hideBody(text, isText, contentType, mergedUsed);
      warnings.push(...hiddenBody.warnings);

      const scripts = buildScriptsReport(rawPhases, persisted, mergedUsed);

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
          url: hideSecrets(url0, mergedUsed).text,
          headers: hideHeaders(currentHeaders, mergedUsed).headers,
          body: bodyText === null ? null : hideSecrets(bodyText, mergedUsed).text,
        },
        warnings: dedupeWarnings(warnings),
        scripts: scripts ?? undefined,
      };
    }
  } catch (err: any) {
    noteAbort();
    const mergedUsed = await mergeScriptSecrets(used, varOps, scriptSecretEntries, trusted, input, scriptReads);
    if (hasScripts && varOps.length > 0) {
      // no test phase ran (the send failed): pre-request writes settle now
      try {
        await applyVarOps(store, masterKey, {
          trusted,
          collectionId: input.collectionId!,
          collectionJson: input.collectionJson,
          environmentId: input.environmentId,
          environmentJson: input.environmentJson,
          collectionName: input.collectionJson?.info?.name ?? "Collection",
          environmentName: input.environmentJson?.name ?? null,
          itemPath: input.itemPath,
          varOps,
        });
      } catch {
        // persistence of script writes must never mask the send's own error
      }
    }
    const raw = String(err?.message ?? err);
    const hidden = hideSecrets(raw, mergedUsed);
    warnings.push(...hidden.warnings);
    const aborted = err?.name === "AbortError" || err?.name === "TimeoutError";
    const code = aborted ? (cancelled ? "cancelled" : "timeout") : "send_failed";
    const message = aborted
      ? cancelled
        ? "The send was cancelled."
        : `The request timed out after ${timeoutMs / 1000} seconds: the server did not answer in time.`
      : hidden.text;
    return errorOutput(code, message, { cause: err?.cause ? String(err.cause) : "unknown" }, started, warnings, redirects, method, currentHeaders, bodyText, mergedUsed, url0);
  } finally {
    clearTimeout(timeout);
    input.externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---- helpers ----------------------------------------------------------------

function requestDisplayName(collectionJson: any, itemPath: string, rawNode: any): string {
  const parts = itemPath.split("/").filter(Boolean);
  if (parts.length > 0) return parts[parts.length - 1];
  return rawNode?.name ?? collectionJson?.info?.name ?? "request";
}

function checkScriptRequestCaps(mutated: { method?: unknown; url?: unknown; headers?: unknown; body?: unknown }): string | null {
  if (typeof mutated.url === "string" && mutated.url.length > CAPS.url) {
    return `url too long (${mutated.url.length} chars, cap ${CAPS.url})`;
  }
  if (Array.isArray(mutated.headers)) {
    for (const [k, v] of mutated.headers) {
      if (typeof v === "string" && v.length > CAPS.headerValue) {
        return `header ${k} value too long (${v.length} chars, cap ${CAPS.headerValue})`;
      }
    }
  }
  if (typeof mutated.body === "string" && mutated.body.length > CAPS.body) {
    return `body too long (${mutated.body.length} chars, cap ${CAPS.body})`;
  }
  return null;
}

/**
 * Secrets a script read (trusted only — untrusted reads never return values)
 * or wrote join the hide set, so everything the script phase returns to the
 * browser goes through hiding with the full set.
 */
async function mergeScriptSecrets(
  used: UsedSecret[],
  varOps: VarOp[],
  secretEntries: { name: string; scope: string; value: string | null }[],
  trusted: boolean,
  input: SendInput,
  scriptReads: { name: string; scope: string }[]
): Promise<UsedSecret[]> {
  const merged = [...used];
  const byName = new Map(merged.map((u) => [u.name, u]));
  const add = (name: string, value: string | null | undefined) => {
    if (!value || byName.has(name)) return;
    byName.set(name, { name, value });
    merged.push({ name, value });
  };
  if (trusted) {
    for (const r of scriptReads) {
      const entry = secretEntries.find((s) => s.name === r.name && s.scope === r.scope);
      if (entry?.value) {
        add(entry.name, entry.value);
        auditLog("read", entry.name, r.scope, input.collectionId ?? "", input.itemPath);
      }
    }
  }
  for (const op of varOps) {
    if (op?.kind === "secret" && typeof op.value === "string") add(op.name, op.value);
  }
  return merged;
}

function buildScriptsReport(
  raw: {
    prerequest: { console: string[]; error?: { message: string; line?: number; script?: string }; truncated: boolean } | null;
    tests: { tests: { name: string; passed: boolean; error?: string }[]; console: string[]; error?: { message: string; line?: number; script?: string }; truncated: boolean } | null;
  },
  persisted: PersistResult,
  used: UsedSecret[]
): SendScriptsReport | null {
  if (!raw.prerequest && !raw.tests) return null;
  const prereq = raw.prerequest;
  const t = raw.tests;
  const pOut = sanitiseScriptOutput(prereq?.console ?? [], undefined, used);
  const tOut = sanitiseScriptOutput(t?.console ?? [], t?.tests, used);
  const phaseError = (e: { message: string; line?: number } | undefined) =>
    e
      ? {
          message: sanitiseText(hideScriptText(e.message, used)),
          ...(e.line !== undefined ? { line: e.line } : {}),
        }
      : undefined;
  return {
    prerequest: {
      console: pOut.console,
      ...(phaseError(prereq?.error) ? { error: phaseError(prereq!.error)! } : {}),
      ...(prereq?.truncated ? { truncated: true as const } : {}),
    },
    tests: {
      results: tOut.tests,
      console: tOut.console,
      ...(phaseError(t?.error) ? { error: phaseError(t!.error)! } : {}),
      ...(t?.truncated ? { truncated: true as const } : {}),
    },
    variablesChanged: persisted.variablesChanged,
  };
}

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
