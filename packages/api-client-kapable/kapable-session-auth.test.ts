/**
 * Build 5 — kapableSessionAuth (Sign in with Kapable) tests.
 * The platform's exchange endpoint is faked in-process with Bun.serve: no
 * network call here reaches the real platform.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  accessKeyAuth,
  anyOf,
  createApiClientHandler,
  safeDest,
} from "@ffwd/api-client-server";
import {
  kapableSessionAuth,
  kapableSessionCookie,
  signSsoState,
  verifySsoState,
  KAPABLE_SSO_COOKIE,
} from "./src/index";
import { TEST_ACCESS_KEY, TEST_MASTER_KEY } from "../../test/helpers";

const APP_SSO_SECRET = "fake-app-sso-secret-0123456789abcdef";
const GOOD_TOKEN = "sso-good-token-0123456789abcdef";
const IDENTITY = {
  member_id: "mem_123",
  org_id: "org_456",
  email: "herman@example.com",
  name: "Herman",
  claims: { is_platform_staff: false, is_org_member: true, role: "owner" },
  session_ttl_seconds: 3600,
};

let fakeAuth: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof Bun.serve>;
let appBase: string;
let authBase: string;

beforeAll(() => {
  // ---- the fake exchange endpoint (stands in for {org}.kapable.ai/auth) ----
  fakeAuth = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/sso/exchange" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        if (body?.sso_token === GOOD_TOKEN && body?.app_secret === APP_SSO_SECRET) {
          return Response.json(IDENTITY);
        }
        return Response.json({ error: { code: "invalid_or_expired" } }, { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  authBase = `http://127.0.0.1:${fakeAuth.port}`;

  // ---- the app under test: the real handler with anyOf(kapable, accessKey) ----
  const auth = anyOf([
    kapableSessionAuth({
      authBase,
      appSlug: "ffwd",
      appSecret: APP_SSO_SECRET,
      publicUrl: "http://app.test",
      masterKey: TEST_MASTER_KEY,
    }),
    accessKeyAuth({ key: TEST_ACCESS_KEY, masterKey: TEST_MASTER_KEY }),
  ]);
  const handler = createApiClientHandler({
    store: {
      listCollections: () => [],
      listEnvironments: () => [],
      listHistory: () => [],
      listSecrets: () => [],
    } as any,
    masterKey: TEST_MASTER_KEY,
    basePath: "/api/ffwd",
    auth,
  });
  app = Bun.serve({ port: 0, fetch: handler });
  appBase = `http://127.0.0.1:${app.port}`;
});

afterAll(() => {
  app?.stop(true);
  fakeAuth?.stop(true);
});

/** Start the SSO dance and return the platform start URL it bounces to. */
async function startSso(dest?: string): Promise<Response> {
  const res = await fetch(`${appBase}/api/ffwd/auth/sso/start${dest ? `?dest=${encodeURIComponent(dest)}` : ""}`, {
    redirect: "manual",
  });
  return res;
}

/** Pull the signed state out of a start bounce. */
function stateFrom(location: string): string {
  return new URL(location).searchParams.get("state")!;
}

async function callback(params: string): Promise<Response> {
  return fetch(`${appBase}/auth/sso/callback?${params}`, { redirect: "manual" });
}

describe("sso state", () => {
  test("sign then verify returns the nonce and destination", async () => {
    const master = Uint8Array.from(Buffer.from(TEST_MASTER_KEY, "base64"));
    const state = await signSsoState(master, "nonce-1", "/collections");
    const v = await verifySsoState(master, state);
    expect(v).toEqual({ nonce: "nonce-1", dest: "/collections" });
  });

  test("a tampered body is refused", async () => {
    const master = Uint8Array.from(Buffer.from(TEST_MASTER_KEY, "base64"));
    const state = await signSsoState(master, "nonce-2", "/");
    const i = state.lastIndexOf(".");
    const forged = `${state.slice(0, i).replace(/.$/, "X")}${state.slice(i)}`;
    expect(await verifySsoState(master, forged)).toBeNull();
  });

  test("a state signed with a different key is refused", async () => {
    const other = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
    const master = Uint8Array.from(Buffer.from(TEST_MASTER_KEY, "base64"));
    const state = await signSsoState(Uint8Array.from(Buffer.from(other, "base64")), "nonce-3", "/");
    expect(await verifySsoState(master, state)).toBeNull();
  });

  test("garbage states are refused", async () => {
    const master = Uint8Array.from(Buffer.from(TEST_MASTER_KEY, "base64"));
    expect(await verifySsoState(master, null)).toBeNull();
    expect(await verifySsoState(master, "")).toBeNull();
    expect(await verifySsoState(master, "no-dots-here")).toBeNull();
    expect(await verifySsoState(master, "notbase64.notbase64")).toBeNull();
  });
});

describe("destination sanitising", () => {
  test("only path-relative destinations survive", () => {
    expect(safeDest("/collections?x=1")).toBe("/collections?x=1");
    expect(safeDest("https://evil.example")).toBe("/");
    expect(safeDest("//evil.example")).toBe("/");
    expect(safeDest("/\\evil.example")).toBe("/");
    expect(safeDest("relative")).toBe("/");
    expect(safeDest("/auth/sso/callback")).toBe("/");
    expect(safeDest("/auth/sso/start")).toBe("/");
  });
});

describe("the start route", () => {
  test("303s to the platform's SSO start with app, return_to and state", async () => {
    const res = await startSso("/collections");
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    const u = new URL(location);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe(`${authBase}/sso/start`);
    expect(u.searchParams.get("app")).toBe("ffwd");
    expect(u.searchParams.get("return_to")).toBe("http://app.test/auth/sso/callback");
    const state = u.searchParams.get("state")!;
    expect(state).toMatch(/\./);
    const v = await verifySsoState(Uint8Array.from(Buffer.from(TEST_MASTER_KEY, "base64")), state);
    expect(v?.dest).toBe("/collections");
  });

  test("a start for an already-signed-in caller bounces to the destination", async () => {
    const start = await startSso("/collections");
    const state = stateFrom(start.headers.get("location")!);
    const cb = await callback(`sso_token=${encodeURIComponent(GOOD_TOKEN)}&state=${encodeURIComponent(state)}`);
    const kapableCookie = cb.headers.get("set-cookie")!.split(";")[0];
    const res = await fetch(`${appBase}/api/ffwd/auth/sso/start?dest=%2Fcollections`, {
      redirect: "manual",
      headers: { cookie: kapableCookie },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/collections");
  });
});

describe("the callback route", () => {
  test("a good token exchanges, sets the session cookie and 303s to the destination", async () => {
    const start = await startSso("/collections");
    const state = stateFrom(start.headers.get("location")!);
    const res = await callback(`sso_token=${encodeURIComponent(GOOD_TOKEN)}&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/collections");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${KAPABLE_SSO_COOKIE}=kv2\\.`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=3600/); // TTL from the exchange
    // http publicUrl → no Secure flag (a Secure cookie on plain http is dropped silently)
    expect(cookie).not.toMatch(/Secure/);
    // the cookie signs the caller in
    const authed = await fetch(`${appBase}/api/ffwd/state`, {
      headers: { cookie: cookie.split(";")[0] },
    });
    expect(authed.status).toBe(200);
    const who = await fetch(`${appBase}/api/ffwd/history`, {
      headers: { cookie: cookie.split(";")[0] },
    });
    expect(who.status).toBe(200);
  });

  test("a bad token answers 401 with a line a person can act on", async () => {
    const start = await startSso("/");
    const state = stateFrom(start.headers.get("location")!);
    const res = await callback(`sso_token=stolen-or-expired-token&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe("exchange_failed");
    expect(data.error.message).toMatch(/Kapable did not accept the sign-in handoff/);
    expect(data.error.message).toMatch(/Open the API client again/);
  });

  test("a forged state is refused", async () => {
    const res = await callback(`sso_token=${encodeURIComponent(GOOD_TOKEN)}&state=forged.000`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe("bad_state");
  });

  test("a replayed state is refused (the nonce is single-use)", async () => {
    const start = await startSso("/");
    const state = stateFrom(start.headers.get("location")!);
    const first = await callback(`sso_token=${encodeURIComponent(GOOD_TOKEN)}&state=${encodeURIComponent(state)}`);
    expect(first.status).toBe(303);
    const replay = await callback(`sso_token=${encodeURIComponent(GOOD_TOKEN)}&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(401);
    const data = await replay.json();
    expect(data.error.code).toBe("replayed_state");
  });

  test("Secure is set on an https publicUrl", () => {
    expect(kapableSessionCookie("kv2.1.a.b", 60, true)).toMatch(/; Secure$/);
  });
});

describe("the handler advertises a sign-in url on 401", () => {
  test("an unauthenticated API call carries details.sign_in_url", async () => {
    const res = await fetch(`${appBase}/api/ffwd/state`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.details.sign_in_url).toMatch(
      /^\/api\/ffwd\/auth\/sso\/start\?dest=%2Fapi%2Fffwd%2Fstate$/
    );
  });
});

describe("anyOf order", () => {
  test("the first auth that accepts wins (access key still works as fallback)", async () => {
    const viaKey = await fetch(`${appBase}/api/ffwd/state`, {
      headers: { "x-echo-key": TEST_ACCESS_KEY },
    });
    expect(viaKey.status).toBe(200);
    const none = await fetch(`${appBase}/api/ffwd/state`);
    expect(none.status).toBe(401);
  });

  test("the SSO routes are answered even when a later auth is in the chain", async () => {
    // anyOf lists accessKeyAuth second; the start route must still reach the
    // kapable auth and bounce to the platform, not answer the access-key 401.
    const res = await startSso("/");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/sso/start");
  });
});
