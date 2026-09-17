/**
 * Variable resolution on the server. The browser never resolves anything:
 * it edits plain v2.1 JSON and this module does all {{var}} work.
 *
 * Scope precedence: collection variables → environment variables → secrets
 * last, so a secret shadows an environment variable of the same name, which
 * shadows a collection variable.
 *
 * Resolution uses postman-collection's VariableScope.replaceIn, which resolves
 * {{vars}} and the built-ins {{$guid}}, {{$timestamp}}, {{$randomInt}} and
 * leaves unknown {{tokens}} untouched (the browser highlights them red).
 * (toObjectResolved was measured to mangle the Url object when
 * ignoreOwnVariables is set, so string-level replaceIn is used instead —
 * see docs/BUILD-REPORT.md.)
 */

import { VariableScope } from "postman-collection";
import type { UsedSecret } from "./hiding";

/** Declaration order: later scopes win. */
export function buildScope(
  collectionJson: unknown,
  environmentJson: unknown | null,
  secrets: UsedSecret[]
): VariableScope {
  const scope = new VariableScope();
  const colVars = extractVariables(collectionJson);
  const envVars = environmentJson ? extractVariables(environmentJson) : [];
  // VariableScope.set on the same key replaces, so apply in ascending precedence.
  for (const v of colVars) scope.set(v.key, v.value);
  for (const v of envVars) scope.set(v.key, v.value);
  for (const s of secrets) scope.set(s.name, s.value);
  return scope;
}

interface RawVar {
  key: string;
  value: string;
  enabled?: boolean;
  type?: string;
}

export function extractVariables(json: unknown): RawVar[] {
  const obj = json as { variable?: RawVar[]; values?: RawVar[] };
  if (!obj) return [];
  const raw = obj.variable ?? obj.values ?? [];
  return raw
    .filter((v) => v && typeof v.key === "string" && v.enabled !== false)
    .map((v) => ({ key: v.key, value: v.value ?? "" }));
}

/** Resolve one string against the scope; unknown {{tokens}} stay as-is. */
export function resolveString(scope: VariableScope, text: string): string {
  return scope.replaceIn(String(text)) as string;
}

/** Find a raw v2.1 item node inside a collection JSON by a slash-joined name path. */
export function findRawItem(collectionJson: any, itemPath: string): any | null {
  const parts = itemPath ? itemPath.split("/").filter(Boolean) : [];
  let group = collectionJson;
  for (const part of parts) {
    const next = (group?.item ?? []).find((i: any) => i?.name === part);
    if (!next) return null;
    group = next;
  }
  return group;
}

/** The first request found in the collection tree (depth-first). */
export function firstRawRequest(collectionJson: any): any | null {
  const dfs = (list: any[]): any | null => {
    for (const entry of list ?? []) {
      if (entry?.request) return entry;
      const nested = dfs(entry?.item ?? []);
      if (nested) return nested;
    }
    return null;
  };
  return dfs(collectionJson?.item ?? []);
}

export interface ResolvedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  queryParams: { key: string; value: string; enabled: boolean }[];
  bodyText: string | null;
  rawBodyMode: string | null;
}

/**
 * Resolve a request node (raw v2.1 JSON) against the scope: URL, params,
 * headers and body. The auth block is returned unresolved-structured; applyAuth
 * turns it into concrete headers/query params.
 */
export function resolveRequest(
  collectionJson: any,
  itemPath: string,
  scope: VariableScope
): { resolved: ResolvedRequest; auth: any } | null {
  const node = itemPath ? findRawItem(collectionJson, itemPath) : firstRawRequest(collectionJson);
  const req = node?.request;
  if (!req) return null;

  const method = String(req.method ?? "GET").toUpperCase();

  // URL: resolve the raw form, and the params list separately.
  let urlRaw = "";
  const queryParams: { key: string; value: string; enabled: boolean }[] = [];
  if (typeof req.url === "string") {
    urlRaw = resolveString(scope, req.url);
  } else if (req.url) {
    urlRaw = resolveString(scope, req.url.raw ?? "");
    for (const q of req.url.query ?? []) {
      if (!q || q.disabled || !q.key) continue;
      queryParams.push({ key: resolveString(scope, q.key), value: resolveString(scope, q.value ?? ""), enabled: true });
    }
  }

  const headers: Record<string, string> = {};
  for (const h of req.header ?? []) {
    if (!h || h.disabled || !h.key) continue;
    headers[resolveString(scope, h.key)] = resolveString(scope, h.value ?? "");
  }

  let bodyText: string | null = null;
  const b = req.body;
  let rawBodyMode: string | null = null;
  if (b) {
    rawBodyMode = b.mode ?? "raw";
    if (b.mode === "raw" || (b.mode === undefined && typeof b.raw === "string")) {
      bodyText = resolveString(scope, b.raw ?? "");
    } else if (b.mode === "urlencoded") {
      const parts = (b.urlencoded ?? [])
        .filter((p: any) => p && !p.disabled && p.key)
        .map((p: any) => `${encodeURIComponent(resolveString(scope, p.key))}=${encodeURIComponent(resolveString(scope, p.value ?? ""))}`);
      bodyText = parts.join("&");
    } else if (b.mode === "formdata") {
      const parts = (b.formdata ?? [])
        .filter((p: any) => p && !p.disabled && p.key && p.type !== "file")
        .map((p: any) => `${encodeURIComponent(resolveString(scope, p.key))}=${encodeURIComponent(resolveString(scope, p.value ?? ""))}`);
      bodyText = parts.join("&");
    }
  }

  // Effective auth: the nearest auth block walking up the tree (item → folders → collection).
  const auth = effectiveAuth(collectionJson, itemPath, req.auth ?? node.auth ?? null);

  return { resolved: { method, url: urlRaw, headers, queryParams, bodyText, rawBodyMode }, auth };
}

/** Nearest auth block: explicit override wins, else the closest ancestor with one. */
export function effectiveAuth(collectionJson: any, itemPath: string, explicit: any | null = null): any | null {
  if (explicit) return explicit;
  const parts = (itemPath ?? "").split("/").filter(Boolean);
  let group = collectionJson;
  const chain: any[] = [collectionJson?.auth ?? null];
  for (const part of parts) {
    const next = (group?.item ?? []).find((i: any) => i?.name === part);
    if (!next) break;
    chain.push(next.auth ?? null);
    group = next;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i]) return chain[i];
  }
  return null;
}

/**
 * Turn a resolved auth block into concrete headers/query params. Auth parameter
 * values may still carry {{vars}} — they resolve through the same scope, so a
 * secret bearer token never exists as a literal in the collection.
 */
export function applyAuth(
  auth: any | null,
  scope: VariableScope,
  requestUrl: string,
  headers: Record<string, string>
): { url: string; headers: Record<string, string> } {
  const out = { url: requestUrl, headers: { ...headers } };
  if (!auth || auth.type === "none" || auth.type === "noauth") return out;
  const params = new Map<string, string>();
  for (const p of auth[auth.type] ?? []) {
    if (p && p.key && !p.disabled) params.set(String(p.key), String(p.value ?? ""));
  }
  const val = (k: string) => resolveString(scope, params.get(k) ?? "");
  if (auth.type === "bearer") {
    out.headers["Authorization"] = `Bearer ${val("token")}`;
  } else if (auth.type === "basic") {
    const user = val("username");
    const pass = val("password");
    out.headers["Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  } else if (auth.type === "apikey") {
    const key = val("key");
    const value = val("value");
    const where = params.get("in") ?? "header";
    if (where === "query" && key) {
      const u = new URL(out.url);
      u.searchParams.set(key, value);
      out.url = u.toString();
    } else if (key) {
      out.headers[key] = value;
    }
  }
  return out;
}

/**
 * Which secret names does the UNRESOLVED request reference as {{name}} in its
 * URL, headers, body, or the effective auth block? Only those values are
 * pulled from the store for this send.
 */
export function secretNamesUsedIn(requestJson: any, auth: any | null, secretNames: string[]): string[] {
  const texts: string[] = [];
  const req = requestJson?.request ?? requestJson;
  if (req?.url) {
    if (typeof req.url === "string") texts.push(req.url);
    else {
      if (req.url.raw) texts.push(String(req.url.raw));
      for (const q of req.url.query ?? []) texts.push(`${q?.key ?? ""}=${q?.value ?? ""}`);
    }
  }
  for (const h of req?.header ?? []) texts.push(`${h?.key ?? ""}: ${h?.value ?? ""}`);
  const b = req?.body;
  if (typeof b?.raw === "string") texts.push(b.raw);
  for (const list of [b?.urlencoded, b?.formdata]) {
    if (Array.isArray(list)) for (const p of list) texts.push(`${p?.key ?? ""}=${p?.value ?? ""}`);
  }
  if (auth) {
    for (const type of Object.keys(auth)) {
      if (Array.isArray(auth[type])) {
        for (const p of auth[type]) texts.push(`${p?.key ?? ""}=${p?.value ?? ""}`);
      }
    }
  }
  const haystack = texts.join("\n");
  return secretNames.filter((n) => haystack.includes(`{{${n}}}`));
}
