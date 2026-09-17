// A tiny SSO-capable host for the live verification script: the core handler
// with anyOf(kapableSessionAuth, accessKeyAuth) from this package.
import { Hono } from "hono";
import {
  accessKeyAuth,
  anyOf,
  createApiClientHandler,
  constantTimeEqual,
  mintSessionToken,
  sessionCookie,
  SqliteStore,
} from "@ffwd/api-client-server";
import { kapableSessionAuth } from "../src/index";

const ACCESS_KEY = process.env.APP_ACCESS_KEY!;
const MASTER_KEY = process.env.SECRETS_MASTER_KEY!;

const auth = anyOf([
  kapableSessionAuth({
    authBase: process.env.KAPABLE_AUTH_URL!,
    appSlug: process.env.KAPABLE_APP_SLUG!,
    appSecret: process.env.APP_SSO_SECRET!,
    publicUrl: process.env.PUBLIC_URL!,
    masterKey: MASTER_KEY,
  }),
  accessKeyAuth({ key: ACCESS_KEY, masterKey: MASTER_KEY }),
]);

const handler = createApiClientHandler({
  store: new SqliteStore("./data-verify-sso/ffwd.sqlite"),
  masterKey: MASTER_KEY,
  basePath: "/api/ffwd",
  auth,
});

const app = new Hono();
app.all("/api/ffwd/*", (c) => handler(c.req.raw));
app.all("/auth/sso/*", (c) => handler(c.req.raw));
app.post("/session", async (c) => {
  const body: any = await c.req.json().catch(() => ({}));
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key || !constantTimeEqual(key, ACCESS_KEY)) {
    return c.json({ error: { code: "bad_key", message: "no" } }, 401);
  }
  const token = await mintSessionToken(Buffer.from(MASTER_KEY, "base64"));
  return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(token) } });
});
app.get("/sign-in", (c) =>
  c.html(`<html><body><h1>Sign in</h1><a href="/auth/sso/start?dest=%2F">Sign in with Kapable</a>
  <form><label for="k">Access key</label><input id="k" /></form></body></html>`)
);
app.get("/", (c) => c.html("<html><body>app</body></html>"));

const port = Number(process.env.PORT ?? 4600);
Bun.serve({ port, fetch: app.fetch });
console.log("[auth] using Sign in with Kapable (SSO env set) with the access key as a fallback.");
