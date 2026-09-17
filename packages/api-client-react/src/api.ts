/**
 * One internal fetch helper. Every request the component makes goes through
 * here: the apiBase is prefixed, and a 401 calls the host's onUnauthorized
 * (so the host can redirect to its own sign-in).
 */
import { toast } from "sonner";

/** What a 401 tells the host/component: where to sign in, when the server advertises it. */
export interface UnauthorizedInfo {
  signInUrl?: string;
}

let apiBase = "/api/ffwd";
let onUnauthorized: ((info: UnauthorizedInfo) => void) | undefined;

export function configureApi(opts: { apiBase: string; onUnauthorized?: (info: UnauthorizedInfo) => void }) {
  apiBase = opts.apiBase.replace(/\/+$/, "");
  onUnauthorized = opts.onUnauthorized;
}

export function apiUrl(path: string): string {
  return apiBase + (path.startsWith("/") ? path : "/" + path);
}

/** GET/fetch helper that toasts the house error shape on failure. */
export async function api<T = any>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(apiUrl(path), init);
    if (res.status === 204) return null as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401) {
        onUnauthorized?.({ signInUrl: data?.error?.details?.sign_in_url });
        toast.error(data?.error?.message ?? "Your session has expired: sign in again.");
        return null;
      }
      toast.error(data?.error?.message ?? `The request failed with status ${res.status}.`);
      return null;
    }
    return data as T;
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    toast.error(err?.message ?? "The server could not be reached.");
    return null;
  }
}
