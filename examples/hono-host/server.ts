// A minimal ffwd API client host: Hono serves the handler + the built UI.
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import {
  accessKeyAuth,
  constantTimeEqual,
  createApiClientHandler,
  mintSessionToken,
  sessionCookie,
  storeFromEnv,
} from "@ffwd/api-client-server";

const ACCESS_KEY = process.env.APP_ACCESS_KEY!;
const MASTER_KEY = process.env.SECRETS_MASTER_KEY!;

if (!ACCESS_KEY || ACCESS_KEY.length < 8) {
  console.error("APP_ACCESS_KEY is not set: this host guards stored secrets, so it refuses to start. Set it first, e.g. `export APP_ACCESS_KEY=\"$(openssl rand -base64 24)\"`.");
  process.exit(1);
}
if (!MASTER_KEY) {
  console.error("SECRETS_MASTER_KEY is not set: secret values are encrypted at rest with this key. Generate one with `openssl rand -base64 32`.");
  process.exit(1);
}

// Durable store choice: the core storeFromEnv() only knows SQLite (the
// choice and its reason are logged).
const store = storeFromEnv({ sqlitePath: "./data/ffwd.sqlite" });

const handler = createApiClientHandler({
  store,
  masterKey: MASTER_KEY,
  basePath: "/api/ffwd",
  auth: accessKeyAuth({ key: ACCESS_KEY, masterKey: MASTER_KEY }),
});

const app = new Hono();
app.all("/api/ffwd/*", (c) => handler(c.req.raw));
// sign-in: the UI posts the access key here and gets the session cookie
app.post("/session", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "bad_json", message: 'The request body must be JSON with a "key" field.' } }, 400);
  }
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key || !constantTimeEqual(key, ACCESS_KEY)) {
    return c.json({ error: { code: "bad_key", message: "That access key is not correct: check it and try again." } }, 401);
  }
  const token = await mintSessionToken(Buffer.from(MASTER_KEY, "base64"));
  return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(token) } });
});
app.use("/assets/*", serveStatic({ root: "./dist/static" }));
app.get("/", serveStatic({ root: "./dist/static", rewriteRequestPath: () => "/index.html" }));

const port = Number(process.env.PORT ?? 4600);
Bun.serve({ port, fetch: app.fetch });
console.log(`hono-host listening on http://localhost:${port}`);
