/**
 * Access gate: POST /api/session with APP_ACCESS_KEY (constant-time compare)
 * sets an HttpOnly, SameSite=Lax cookie holding an HMAC-signed token whose
 * key is derived from the master key. 7-day expiry.
 */

const encoder = new TextEncoder();

async function hmacKey(masterKey: Uint8Array): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", masterKey as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("ffwd-session-v1"),
      info: encoder.encode("hmac-sha256"),
    },
    raw,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ea = encoder.encode(a);
  const eb = encoder.encode(b);
  const len = Math.max(ea.length, eb.length);
  const pa = new Uint8Array(len);
  const pb = new Uint8Array(len);
  pa.set(ea);
  pb.set(eb);
  return crypto.timingSafeEqual(pa, pb) && ea.length === eb.length;
}

export const SESSION_COOKIE = "ffwd_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function mintSessionToken(masterKey: Uint8Array): Promise<string> {
  const key = await hmacKey(masterKey);
  const payload = `v1.${Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS}`;
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload) as BufferSource);
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
  masterKey: Uint8Array,
  token: string | undefined | null
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const key = await hmacKey(masterKey);
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${parts[0]}.${parts[1]}`) as BufferSource
  );
  const given = Buffer.from(parts[2], "base64url");
  const want = Buffer.from(new Uint8Array(expected));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function sessionFromRequest(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

export function unauthorized(): Response {
  return Response.json(
    {
      error: {
        code: "unauthorized",
        message: "Sign in with the access key first.",
        details: { how: "POST /api/session {key}" },
      },
    },
    { status: 401 }
  );
}

/** What a host-provided auth function returns for one request. */
export type AuthResult = { ok: true; principal: string } | { ok: false; response?: Response };

/** A host decides who may call the handler. */
export type AuthFn = (req: Request) => Promise<AuthResult>;

/**
 * The build-1 access-key gate as ONE provided auth: a valid session cookie,
 * or an `x-echo-key` header carrying the access key (so a SEND proxied through
 * this handler can authenticate to a mounted /_echo without a cookie — the
 * proxy never forwards cookies). `masterKey` is base64, 32 bytes.
 */
export function accessKeyAuth(opts: { key: string; masterKey: string }): AuthFn {
  const masterKey = Uint8Array.from(Buffer.from(opts.masterKey, "base64"));
  return async (req: Request): Promise<AuthResult> => {
    const echoKey = req.headers.get("x-echo-key");
    if (echoKey && constantTimeEqual(echoKey, opts.key)) {
      return { ok: true, principal: "echo-key" };
    }
    const token = sessionFromRequest(req);
    if (await verifySessionToken(masterKey, token)) {
      return { ok: true, principal: "access-key" };
    }
    return { ok: false, response: unauthorized() };
  };
}

/** Only path-relative destinations, never back into the SSO loop. */
export function safeDest(d: string): string {
  if (!d.startsWith("/") || d.startsWith("//") || d.startsWith("/\\")) return "/";
  return d.startsWith("/auth/sso/") ? "/" : d;
}

/**
 * Combine provided auths: the first that accepts the request wins. A failure
 * that carries a response ends the chain (that auth decided); a silent failure
 * falls through to the next. Accepts the auths as arguments or as one array:
 * `anyOf(a, b)` / `anyOf([a, b])`.
 */
export function anyOf(...authArgs: (AuthFn | AuthFn[])[]): AuthFn {
  const auths = authArgs.length === 1 && Array.isArray(authArgs[0]) ? authArgs[0] : (authArgs as AuthFn[]);
  const combined = async (req: Request): Promise<AuthResult> => {
    let silent: AuthResult | null = null;
    for (const auth of auths) {
      const v = await auth(req);
      if (v.ok) return v;
      if (v.response) return v;
      silent = silent ?? v;
    }
    return silent ?? { ok: false };
  };
  // The handler advertises sign_in_url when the chain can sign a caller in.
  if (auths.some((a) => (a as { ssoCapable?: unknown }).ssoCapable === true)) {
    (combined as { ssoCapable?: boolean }).ssoCapable = true;
  }
  return combined as AuthFn;
}
