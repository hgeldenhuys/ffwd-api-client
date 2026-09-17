export interface V21Param {
  key: string;
  value: string;
  disabled?: boolean;
}
export interface V21Header extends V21Param {}
export interface V21Request {
  method: string;
  url: { raw: string; query?: V21Param[] } | string;
  header?: V21Header[];
  body?: { mode: "raw" | "urlencoded" | "formdata" | "none"; raw?: string; urlencoded?: V21Param[]; formdata?: V21Param[] };
  description?: string;
}
export interface V21Auth {
  type: "bearer" | "basic" | "apikey" | "noauth" | string;
  bearer?: V21Param[];
  basic?: V21Param[];
  apikey?: V21Param[];
}
export interface V21Event {
  listen?: "prerequest" | "test" | string;
  script?: { type?: string; exec?: string[] };
  disabled?: boolean;
}
export interface V21Item {
  name: string;
  request?: V21Request;
  auth?: V21Auth;
  event?: V21Event[];
  item?: V21Item[];
}
export interface V21Collection {
  info: { name: string; _postman_id?: string; schema?: string; description?: string; "x-ffwd-scripts-trusted"?: boolean };
  item: V21Item[];
  variable?: { key: string; value: string; type?: string; enabled?: boolean }[];
  auth?: V21Auth;
}
export interface V21Environment {
  name?: string;
  values: { key: string; value: string; enabled?: boolean; type?: string }[];
}

export interface CollectionMeta {
  id: string;
  name: string;
  json: V21Collection;
  updatedAt: string;
}
export interface EnvironmentMeta {
  id: string;
  name: string;
  json: V21Environment;
  updatedAt: string;
}
export interface SecretMeta {
  name: string;
  scope: "collection" | "environment";
  scopeId: string;
  has_value: boolean;
  updated_at: string;
  last_used_at: string | null;
}
export interface HistoryMeta {
  id: string;
  at: string;
  request: any;
  environmentId: string | null;
  collectionId: string | null;
  itemPath: string | null;
  status: number | null;
  error: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
}

export interface ScriptPhaseReport {
  console: string[];
  error?: { message: string; line?: number };
  truncated?: true;
}
export interface ScriptTestsReport extends ScriptPhaseReport {
  results: { name: string; passed: boolean; error?: string }[];
}
export interface ScriptsReport {
  prerequest: ScriptPhaseReport;
  tests: ScriptTestsReport;
  variablesChanged: { scope: "collection" | "environment"; scopeId: string; name: string; secret: boolean; persisted: boolean; reason?: string }[];
}

export interface SendResult {
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
  scripts?: ScriptsReport;
}

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export function blankCollection(name: string): V21Collection {
  return {
    info: {
      name,
      _postman_id: crypto.randomUUID(),
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      // collections created in the app start with trusted scripts; imported
      // ones start untrusted (the server sets the same marker on import)
      "x-ffwd-scripts-trusted": true,
    },
    item: [],
    variable: [],
  };
}

export function blankRequest(): V21Request {
  return { method: "GET", url: { raw: "", query: [] }, header: [] };
}

export function blankEnvironment(name: string): V21Environment {
  return { name, values: [] };
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** GET helper that toasts the house error shape on failure. */
export async function api<T = any>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (res.status === 204) return null as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const { toast } = await import("sonner");
      toast.error(data?.error?.message ?? `The request failed with status ${res.status}.`);
      return null;
    }
    return data as T;
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    const { toast } = await import("sonner");
    toast.error(err?.message ?? "The server could not be reached.");
    return null;
  }
}
