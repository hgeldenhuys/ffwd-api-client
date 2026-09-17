import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createApiClientHandler, SqliteStore, accessKeyAuth, type Store } from "@ffwd/api-client-server";

/**
 * Build 2 mountability proof: the same handler mounts three ways —
 * (1) a React Router 7 resource route, (2) Bun.serve, (3) Hono.
 */

const TEST_KEY = "mount-test-access-key-0123456789";
const TEST_MASTER = Buffer.from(new Uint8Array(32).map((_, i) => (i * 7 + 11) % 256)).toString("base64");

// (1) needs the reference app's env for getEnv(); set BEFORE the dynamic import
process.env.APP_ACCESS_KEY = TEST_KEY;
process.env.SECRETS_MASTER_KEY = TEST_MASTER;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "ffwd-mount-"));
process.env.NODE_ENV = "test";

const { loader, action } = await import("./app/routes/api.$");

function makeStore(): Store {
  return new SqliteStore(join(mkdtempSync(join(tmpdir(), "ffwd-mount-store-")), "t.sqlite"));
}

const alwaysOk = async () => ({ ok: true, principal: "test" });

function makeHandler() {
  return createApiClientHandler({
    store: makeStore(),
    masterKey: TEST_MASTER,
    basePath: "/api/ffwd",
    auth: alwaysOk,
  });
}

describe("mount 1: React Router 7 resource route (loader/action = ({request}) => handler(request))", () => {
  test("loader carries a signed-in request straight to the handler", async () => {
    // mint a valid session cookie the same way the app's /api/session does
    const { mintSessionToken, getEnv: _e } = await import("@ffwd/api-client-server");
    const master = Uint8Array.from(Buffer.from(TEST_MASTER, "base64"));
    const token = await mintSessionToken(master);
    const req = new Request("http://test.local/api/ffwd/collections", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `ffwd_session=${token}` },
      body: JSON.stringify({ name: "From the RR7 resource route" }),
    });
    // @ts-expect-error — the route module types request via React Router's args
    const res = await action({ request: req, params: {}, context: {} });
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row.name).toBe("From the RR7 resource route");
    expect(typeof loader).toBe("function");
  });
});

describe("mount 2: Bun.serve({ fetch: handler })", () => {
  const handler = makeHandler();
  const server = Bun.serve({ port: 0, fetch: handler });
  afterAll(() => server.stop(true));

  test("creates and reads through the mounted handler", async () => {
    const base = `http://127.0.0.1:${server.port}/api/ffwd`;
    const created = await fetch(`${base}/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bun.serve mount" }),
    });
    expect(created.status).toBe(201);
    const state = await (await fetch(`${base}/state`)).json();
    expect(state.collections.some((c: any) => c.name === "Bun.serve mount")).toBe(true);
  });

  test("the host's auth decides: a rejected request answers 401", async () => {
    const refusing = createApiClientHandler({
      store: makeStore(),
      masterKey: TEST_MASTER,
      auth: accessKeyAuth({ key: "some-other-key", masterKey: TEST_MASTER }),
    });
    const s2 = Bun.serve({ port: 0, fetch: refusing });
    try {
      const res = await fetch(`http://127.0.0.1:${s2.port}/api/ffwd/state`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
    } finally {
      s2.stop(true);
    }
  });
});

describe("mount 3: Hono app.all(\"/api/ffwd/*\", c => handler(c.req.raw))", () => {
  const handler = makeHandler();
  const app = new Hono();
  app.all("/api/ffwd/*", (c) => handler(c.req.raw));
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  afterAll(() => server.stop(true));

  test("creates through the Hono-mounted handler", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/ffwd/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Hono mount" }),
    });
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row.name).toBe("Hono mount");
  });

  test("paths outside basePath are refused", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/other/state`);
    expect(res.status).toBe(404);
  });
});
