/**
 * Script orchestration on the send path: collecting scripts in Postman
 * inheritance order (collection → folder(s) → request), building the phase
 * state, running the phases through the sandbox pool, and applying what the
 * scripts changed — trust-gated per the 2026-09-17 review rulings:
 *
 *  - `scripts.trusted` lives in the collection info as
 *    `x-ffwd-scripts-trusted` (absent = false = untrusted).
 *  - Untrusted: secret gets return undefined (with a console note), writes
 *    apply to THIS send only (reported in variablesChanged with
 *    persisted: false), and the request origin may not change.
 *  - Trusted: reads and persisted writes allowed; every secret read/write is
 *    logged host-side without values.
 */

import { sealSecret, openSecret } from "../crypt";
import { hideSecrets, type UsedSecret } from "../hiding";
import type { Scope, Store } from "../store";
import { scriptSandbox, PHASE_TIME_LIMIT_MS, MEMORY_LIMIT_BYTES } from "./pool";

export const TRUST_MARKER = "x-ffwd-scripts-trusted";
export const TOTAL_SCRIPT_BUDGET_MS = 10_000;

// ---- caps re-checked host-side (the prelude enforces them too) ----------------
export const CAPS = {
  variableValue: 64 * 1024,
  headerValue: 8 * 1024,
  body: 1024 * 1024,
  url: 8 * 1024,
};

export function isTrustedCollection(collectionJson: any): boolean {
  return collectionJson?.info?.[TRUST_MARKER] === true;
}

export function collectionHasScripts(collectionJson: any): boolean {
  if (Array.isArray(collectionJson?.event) && collectionJson.event.length > 0) return true;
  const walk = (items: any[]): boolean => {
    for (const item of items ?? []) {
      if (Array.isArray(item?.event) && item.event.length > 0) return true;
      if (Array.isArray(item?.item) && walk(item.item)) return true;
    }
    return false;
  };
  return walk(collectionJson?.item ?? []);
}

export interface NamedScript {
  /** Where it came from: "collection", the folder path, or "request". */
  name: string;
  code: string;
}

/** Scripts of one listen kind in inheritance order: collection → folders → request. */
export function collectScripts(collectionJson: any, itemPath: string, listen: "prerequest" | "test"): NamedScript[] {
  const out: NamedScript[] = [];
  const take = (node: any, name: string) => {
    for (const ev of node?.event ?? []) {
      if (!ev || ev.listen !== listen) continue;
      const exec = ev?.script?.exec;
      if (!Array.isArray(exec)) continue;
      const code = exec.filter((l: any) => typeof l === "string").join("\n");
      if (code.trim()) out.push({ name, code });
    }
  };
  take(collectionJson, "collection");
  const parts = itemPath.split("/").filter(Boolean);
  let group = collectionJson;
  for (let i = 0; i < parts.length; i++) {
    const next = (group?.item ?? []).find((it: any) => it?.name === parts[i]);
    if (!next) break;
    const name = i === parts.length - 1 ? "request" : `folder ${parts.slice(0, i + 1).join(" / ")}`;
    take(next, name);
    group = next;
  }
  return out;
}

// ---- phase state -------------------------------------------------------------

interface SecretEntry {
  name: string;
  scope: Scope;
  value: string | null;
}

export interface ScriptPhaseInput {
  collectionJson: any;
  collectionId: string;
  environmentJson: any | null;
  environmentId: string | null;
  itemPath: string;
  requestName: string;
  trusted: boolean;
  listen: "prerequest" | "test";
  request: { method: string; url: string; headers: [string, string][]; body: string | null; bodyMode: string | null; authType: string | null };
  /** decoded values of every secret in scope (trusted only; untrusted sends nulls) — for sandbox use and hiding only, never serialised to a client */
  secrets: SecretEntry[];
  response: { code: number; status: string; responseTime: number; responseSize: number; headers: [string, string][]; bodyText: string | null } | null;
  writesAlready: number;
  timeLimitMs: number;
}

export interface VarOp {
  kind: "var" | "secret";
  scope: Scope;
  name: string;
  value: string;
}

export interface PhaseOutcome {
  ok: boolean;
  crashed?: string;
  error?: { message: string; line?: number; script?: string };
  truncated?: boolean;
  elapsedMs: number;
  request?: { method: string; url: string; headers: [string, string][]; body: string | null; bodyMode: string | null };
  tests?: { name: string; passed: boolean; error?: string }[];
  console?: string[];
  varOps?: VarOp[];
  secretReads?: { name: string; scope: string }[];
  urlSetBy?: string | null;
}

function plainVarNames(json: any, kind: "collection" | "environment"): string[] {
  const rows = kind === "collection" ? json?.variable ?? [] : json?.values ?? [];
  return rows.filter((v: any) => v && typeof v.key === "string" && v.key && v.type !== "secret").map((v: any) => v.key);
}

/** Decrypt every secret in scope (trusted sends only; otherwise null values). */
export async function resolveSecretEntries(
  store: Store,
  masterKey: Uint8Array,
  secretsInScope: { scope: Scope; scopeId: string; name: string }[],
  trusted: boolean
): Promise<SecretEntry[]> {
  const out: SecretEntry[] = [];
  for (const s of secretsInScope) {
    let value: string | null = null;
    if (trusted) {
      const sealed = store.getSecret(s.scope, s.scopeId, s.name);
      if (sealed) {
        try {
          value = await openSecret(masterKey, s.scope, s.scopeId, s.name, sealed);
        } catch {
          value = null;
        }
      }
    }
    out.push({ name: s.name, scope: s.scope, value });
  }
  return out;
}

export async function runScriptPhase(input: ScriptPhaseInput): Promise<PhaseOutcome> {
  const scripts = collectScripts(input.collectionJson, input.itemPath, input.listen);
  if (scripts.length === 0) {
    return { ok: true, elapsedMs: 0, tests: [], console: [], varOps: [], secretReads: [] };
  }

  const state = {
    trusted: input.trusted,
    requestName: input.requestName,
    eventName: input.listen,
    collectionId: input.collectionId,
    environmentId: input.environmentId,
    envName: input.environmentJson?.name ?? null,
    request: input.request,
    vars: {
      collection: varsToMap(input.collectionJson?.variable),
      environment: input.environmentJson ? varsToMap(input.environmentJson?.values) : null,
    },
    plainNames: {
      collection: plainVarNames(input.collectionJson, "collection"),
      environment: input.environmentJson ? plainVarNames(input.environmentJson, "environment") : null,
    },
    secrets: input.secrets.map((s) => ({ name: s.name, scope: s.scope, value: input.trusted ? s.value : null })),
    secretNamesAll: input.secrets.map((s) => s.name),
    response: input.response,
    writesAlready: input.writesAlready,
  };

  const outcome = await scriptSandbox().run({
    stateJson: JSON.stringify(state),
    scripts,
    memoryLimitBytes: MEMORY_LIMIT_BYTES,
    timeLimitMs: Math.min(input.timeLimitMs, PHASE_TIME_LIMIT_MS),
  });

  if (!outcome.ok) {
    return { ok: false, crashed: outcome.message, elapsedMs: 0 };
  }

  const r = outcome.result ?? {};
  return {
    ok: true,
    elapsedMs: outcome.elapsedMs,
    request: r.request,
    tests: Array.isArray(r.tests) ? r.tests : [],
    console: Array.isArray(r.console) ? r.console : [],
    truncated: r.truncated === true,
    varOps: Array.isArray(r.varOps) ? r.varOps : [],
    secretReads: Array.isArray(r.secretReads) ? r.secretReads : [],
    urlSetBy: r.urlSetBy ?? null,
    error: outcome.error ?? undefined,
  };
}

function varsToMap(rows: any[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of rows ?? []) {
    if (v && typeof v.key === "string" && v.key && v.enabled !== false && v.type !== "secret") {
      map[v.key] = String(v.value ?? "");
    }
  }
  return map;
}

// ---- applying results ----------------------------------------------------------

export interface PersistResult {
  variablesChanged: { scope: Scope; scopeId: string; name: string; secret: boolean; persisted: boolean; reason?: string }[];
}

/**
 * Apply a phase's variable/secret writes. Trusted collections persist through
 * the Store; untrusted ones get this-send-only changes reported with
 * persisted: false (R2b). Only called after the LAST phase of the send (see
 * sender.ts) — a script cannot change a variable in a way the UI misses.
 */
export async function applyVarOps(
  store: Store,
  masterKey: Uint8Array,
  opts: {
    trusted: boolean;
    collectionId: string;
    collectionJson: any;
    environmentId: string | null;
    environmentJson: any | null;
    collectionName: string;
    environmentName: string | null;
    itemPath: string;
    varOps: VarOp[];
  }
): Promise<PersistResult> {
  const changed: PersistResult["variablesChanged"] = [];
  const untrustedReason = "scripts in this collection are untrusted (collection settings → Trusted scripts)";

  const colJson: any = structuredClone(opts.collectionJson);
  const envJson: any = opts.environmentJson ? structuredClone(opts.environmentJson) : null;
  let colDirty = false;
  let envDirty = false;

  for (const op of opts.varOps) {
    if (!op || (op.kind !== "var" && op.kind !== "secret")) continue;
    if (typeof op.name !== "string" || !op.name) continue;
    if (typeof op.value !== "string") continue;
    if (op.value.length > CAPS.variableValue) continue;
    const scope: Scope = op.scope === "environment" && opts.environmentId ? "environment" : "collection";
    const scopeId = scope === "environment" ? opts.environmentId! : opts.collectionId;
    const persisted = opts.trusted;

    if (persisted) {
      if (op.kind === "secret") {
        const sealed = await sealSecret(masterKey, scope, scopeId, op.name, op.value);
        store.setSecret(scope, scopeId, op.name, sealed.ciphertext, sealed.nonce);
        auditLog("write", op.name, scope, opts.collectionId, opts.itemPath);
        // keep the stored JSON row in sync (blank value, type secret) so the
        // UI shows it as a secret and resolution keeps using the store
        ensureSecretRow(scope === "collection" ? colJson : envJson, scope, op.name);
        if (scope === "collection") colDirty = true;
        else envDirty = true;
      } else {
        ensurePlainRow(scope === "collection" ? colJson : envJson, scope, op.name, op.value);
        if (scope === "collection") colDirty = true;
        else envDirty = true;
      }
    }

    changed.push({
      scope,
      scopeId,
      name: op.name,
      secret: op.kind === "secret",
      persisted,
      ...(persisted ? {} : { reason: untrustedReason }),
    });
  }

  if (opts.trusted && colDirty) {
    store.updateCollection(opts.collectionId, opts.collectionName, JSON.stringify(colJson));
  }
  if (opts.trusted && envDirty && envJson && opts.environmentId) {
    store.updateEnvironment(opts.environmentId, opts.environmentName ?? "Environment", JSON.stringify(envJson));
  }

  return { variablesChanged: changed };
}

function ensureSecretRow(json: any, scope: Scope, name: string) {
  const rows = scope === "collection" ? (json.variable ??= []) : (json.values ??= []);
  const existing = rows.find((v: any) => v?.key === name);
  if (existing) {
    existing.type = "secret";
    existing.value = "";
  } else {
    rows.push({ key: name, value: "", type: "secret" });
  }
}

function ensurePlainRow(json: any, scope: Scope, name: string, value: string) {
  const rows = scope === "collection" ? (json.variable ??= []) : (json.values ??= []);
  const existing = rows.find((v: any) => v?.key === name);
  if (existing) {
    existing.value = value;
    delete existing.type;
  } else {
    rows.push({ key: name, value });
  }
}

/** R3: every secret read and write by a trusted script is logged, never the value. */
export function auditLog(kind: "read" | "write", name: string, scope: string, collectionId: string, itemPath: string) {
  console.log(`script.secret.${kind} name=${name} scope=${scope} collection=${collectionId} item=${itemPath || "(root)"}`);
}

// ---- hiding ----------------------------------------------------------------------

/**
 * Everything a script phase returns to the browser goes through the hiding
 * engine with the send's secret set PLUS any secret the script read or wrote
 * (the brief's hiding contract; output hiding is UX, input trust is the
 * control — see the R1/R2 rulings).
 */
export function hideScriptText(text: string, used: UsedSecret[]): string {
  return hideSecrets(text, used).text;
}

/** R7: render-safe text — control characters except \n and \t become U+FFFD. */
export function sanitiseText(s: string): string {
  return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "\uFFFD");
}

export function sanitiseScriptOutput(
  lines: string[],
  tests: { name: string; passed: boolean; error?: string }[] | undefined,
  used: UsedSecret[]
): { console: string[]; tests: { name: string; passed: boolean; error?: string }[] } {
  const outLines = (lines ?? []).map((l) => sanitiseText(hideScriptText(String(l).slice(0, 8192), used)));
  const outTests = (tests ?? []).map((t) => ({
    name: sanitiseText(hideScriptText(String(t.name).slice(0, 200), used)),
    passed: t.passed === true,
    ...(t.error ? { error: sanitiseText(hideScriptText(String(t.error), used)) } : {}),
  }));
  return { console: outLines, tests: outTests };
}

/** Origin (scheme + host + port) of a URL string, or the raw string when it has none. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
