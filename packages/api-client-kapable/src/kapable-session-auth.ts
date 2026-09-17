/**
 * "Sign in with Kapable" auth for kapable-auth member sessions. Mirrors the
 * proven customer-app shape (start → callback → backchannel exchange → app
 * session cookie). Identity-only: the app keeps its own HMAC-signed cookie;
 * kapable-auth's platform session cookie never reaches this host.
 *
 * The handler exposes this auth's two routes under its basePath:
 *   GET <basePath>/auth/sso/start?dest=<path>   → 303 to the platform's SSO start
 *   GET <basePath>/auth/sso/callback            → exchange + cookie + 303 to dest
 * A host may also mount the handler for the top-level `/auth/sso/*` paths so
 * the platform's `return_to` can be `${publicUrl}/auth/sso/callback`.
 */
import type { AuthFn, AuthResult } from "@ffwd/api-client-server";
import { safeDest } from "@ffwd/api-client-server";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

const SSO_STATE_TTL_SECONDS = 10 * 60;

/** Identity returned by POST {authBase}/sso/exchange (mirrors the reference). */
export type KapableExchange = {
  member_id: string;
  org_id: string;
  email: string;
  name?: string;
  claims: { is_platform_staff: boolean; is_org_member: boolean; role: string };
  session_ttl_seconds: number;
};

export interface KapableSessionAuthOptions {
  /** e.g. https://{org}.kapable.ai/auth */
  authBase: string;
  appSlug: string;
  /** The app's SSO secret minted on the platform (APP_SSO_SECRET). */
  appSecret: string;
  /** This app's public origin, e.g. https://apiclient.{org}.kapable.run */
  publicUrl: string;
  /** base64, 32 bytes — signs both the SSO state and the session cookie. */
  masterKey: string;
  cookieName?: string;
}

export const KAPABLE_SSO_COOKIE = "ffwd_kapable_session";

/** An AuthFn that also implements the SSO start/callback routes. */
export type KapableSessionAuthFn = AuthFn & { ssoCapable: true };

async function ssoHmacKey(masterKey: Uint8Array): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", masterKey as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("apiclient-sso-v1"),
      info: encoder.encode("hmac-sha256"),
    },
    raw,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

/** state = base64url({n: nonce, d: dest, e: expiry}).hex-hmac — forged states fail the MAC. */
export async function signSsoState(masterKey: Uint8Array, nonce: string, dest: string): Promise<string> {
  const payload = {
    n: nonce,
    d: dest,
    e: Math.floor(Date.now() / 1000) + SSO_STATE_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = await ssoHmacKey(masterKey);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body) as BufferSource);
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySsoState(
  masterKey: Uint8Array,
  state: string | null | undefined
): Promise<{ nonce: string; dest: string } | null> {
  if (!state) return null;
  const i = state.lastIndexOf(".");
  if (i < 1) return null;
  const body = state.slice(0, i);
  const key = await ssoHmacKey(masterKey);
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(body) as BufferSource);
  const given = Buffer.from(state.slice(i + 1), "base64url");
  const want = Buffer.from(new Uint8Array(expected));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      n?: unknown;
      d?: unknown;
      e?: unknown;
    };
    const exp = Number(p.e);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
    return { nonce: String(p.n ?? ""), dest: typeof p.d === "string" ? p.d : "/" };
  } catch {
    return null;
  }
}

async function kapableTokenKey(masterKey: Uint8Array): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", masterKey as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("apiclient-kapable-session-v1"),
      info: encoder.encode("hmac-sha256"),
    },
    raw,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

export async function mintKapableSessionToken(
  masterKey: Uint8Array,
  principal: string,
  ttlSeconds: number
): Promise<string> {
  const key = await kapableTokenKey(masterKey);
  const payload = `kv2.${Math.floor(Date.now() / 1000) + ttlSeconds}.${Buffer.from(principal).toString("base64url")}`;
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload) as BufferSource);
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyKapableSessionToken(
  masterKey: Uint8Array,
  token: string | undefined | null
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "kv2") return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const key = await kapableTokenKey(masterKey);
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${parts[0]}.${parts[1]}.${parts[2]}`) as BufferSource
  );
  const given = Buffer.from(parts[3], "base64url");
  const want = Buffer.from(new Uint8Array(expected));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return Buffer.from(parts[2], "base64url").toString("utf8");
}

function cookieFromRequest(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function kapableSessionCookie(token: string, ttlSeconds: number, secure: boolean, cookieName = KAPABLE_SSO_COOKIE): string {
  return `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor(ttlSeconds))}${secure ? "; Secure" : ""}`;
}

function ssoError(code: string, message: string): Response {
  return Response.json({ error: { code, message, details: {} } }, { status: 401 });
}

/**
 * The provided auth. On a signed-in request it returns {ok:true, principal}
 * where principal is the member's email (or member id). On the two SSO routes
 * it returns the 303/401 response itself. Anywhere else it fails without a
 * response so `anyOf` can fall through to another auth (e.g. accessKeyAuth).
 */
export function kapableSessionAuth(opts: KapableSessionAuthOptions): KapableSessionAuthFn {
  const masterKey = Uint8Array.from(Buffer.from(opts.masterKey, "base64"));
  if (masterKey.length !== 32) {
    throw new Error(
      `masterKey must decode to exactly 32 bytes (got ${masterKey.length}): generate one with \`openssl rand -base64 32\`.`
    );
  }
  const authBase = opts.authBase.replace(/\/+$/, "");
  const callbackUrl = `${opts.publicUrl.replace(/\/+$/, "")}/auth/sso/callback`;
  const cookieName = opts.cookieName ?? KAPABLE_SSO_COOKIE;
  const secure = opts.publicUrl.startsWith("https://");

  // Replay refusal: a state whose nonce was already exchanged is refused. The
  // set is bounded so a flood cannot grow it without end.
  const usedNonces = new Set<string>();
  const nonceOrder: string[] = [];
  function claimNonce(nonce: string): boolean {
    if (!nonce || usedNonces.has(nonce)) return false;
    usedNonces.add(nonce);
    nonceOrder.push(nonce);
    if (nonceOrder.length > 10_000) {
      const drop = nonceOrder.shift();
      if (drop) usedNonces.delete(drop);
    }
    return true;
  }

  const auth = (async (req: Request): Promise<AuthResult> => {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/auth/sso/start")) {
      const dest = safeDest(url.searchParams.get("dest") ?? "/");
      // Already carrying a valid Kapable session: no dance needed.
      if (await verifyKapableSessionToken(masterKey, cookieFromRequest(req, cookieName))) {
        return { ok: false, response: new Response(null, { status: 303, headers: { location: dest } }) };
      }
      const state = await signSsoState(masterKey, crypto.randomUUID(), dest);
      const startUrl =
        `${authBase}/sso/start?app=${encodeURIComponent(opts.appSlug)}` +
        `&return_to=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
      return { ok: false, response: new Response(null, { status: 303, headers: { location: startUrl } }) };
    }

    if (url.pathname.endsWith("/auth/sso/callback")) {
      const ssoToken = url.searchParams.get("sso_token");
      const verdict = await verifySsoState(masterKey, url.searchParams.get("state"));
      if (!verdict) {
        return {
          ok: false,
          response: ssoError(
            "bad_state",
            "That sign-in link is not valid (it was forged, or it is older than 10 minutes). Open the API client again from your Kapable desktop."
          ),
        };
      }
      if (!claimNonce(verdict.nonce)) {
        return {
          ok: false,
          response: ssoError(
            "replayed_state",
            "That sign-in link was already used. Open the API client again from your Kapable desktop to get a fresh one."
          ),
        };
      }
      let exchange: KapableExchange;
      try {
        exchange = await kapableExchange(authBase, ssoToken, opts.appSecret);
      } catch (err: any) {
        return { ok: false, response: ssoError("exchange_failed", String(err?.message ?? err)) };
      }
      const principal = exchange.email || exchange.member_id;
      const token = await mintKapableSessionToken(masterKey, principal, exchange.session_ttl_seconds);
      return {
        ok: false,
        response: new Response(null, {
          status: 303,
          headers: {
            location: safeDest(verdict.dest),
            "set-cookie": kapableSessionCookie(token, exchange.session_ttl_seconds, secure, cookieName),
          },
        }),
      };
    }

    const who = await verifyKapableSessionToken(masterKey, cookieFromRequest(req, cookieName));
    if (who) return { ok: true, principal: who };
    return { ok: false };
  }) as KapableSessionAuthFn;

  auth.ssoCapable = true;
  return auth;
}

/** Trade the single-use token for an identity. The message names the fix. */
export async function kapableExchange(authBase: string, ssoToken: string | null, appSecret: string): Promise<KapableExchange> {
  const res = await fetch(`${authBase.replace(/\/+$/, "")}/sso/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sso_token: ssoToken, app_secret: appSecret }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        "Kapable did not accept the sign-in handoff (the link was already used or took longer than 30 seconds). Open the API client again from your Kapable desktop."
      );
    }
    throw new Error(`Kapable sign-in handoff failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as KapableExchange;
}
