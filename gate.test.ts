import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { apiFetch, signIn, startServer, TEST_ACCESS_KEY, type ServerHandle } from "./test/helpers";

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ allowPrivate: true });
});

afterAll(() => server?.stop());

describe("startup env validation", () => {
  test("refuses to start without APP_ACCESS_KEY, naming the variable and the command", async () => {
    const proc = Bun.spawn([process.execPath, "./server.ts"], {
      env: {
        PATH: process.env.PATH,
        SECRETS_MASTER_KEY: "KjUlM2Y3YThkMmMxZTBiNDk2YTdmM2U4ZDBjNWExYjI=",
        PORT: String(1), // never reached
        DATA_DIR: "./data-test-missing-access",
      },
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).not.toBe(0);
    const err = await new Response(proc.stderr).text();
    expect(err).toMatch(/APP_ACCESS_KEY/);
    expect(err).toMatch(/openssl/);
  });

  test("refuses to start without SECRETS_MASTER_KEY, naming the variable and openssl rand -base64 32", async () => {
    const proc = Bun.spawn([process.execPath, "./server.ts"], {
      env: {
        PATH: process.env.PATH,
        APP_ACCESS_KEY: TEST_ACCESS_KEY,
        PORT: String(1),
        DATA_DIR: "./data-test-missing-master",
      },
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).not.toBe(0);
    const err = await new Response(proc.stderr).text();
    expect(err).toMatch(/SECRETS_MASTER_KEY/);
    expect(err).toMatch(/openssl rand -base64 32/);
  });

  test("refuses a master key that is not 32 bytes", async () => {
    const proc = Bun.spawn([process.execPath, "./server.ts"], {
      env: {
        PATH: process.env.PATH,
        APP_ACCESS_KEY: TEST_ACCESS_KEY,
        SECRETS_MASTER_KEY: Buffer.from("too-short").toString("base64"),
        PORT: String(1),
        DATA_DIR: "./data-test-short-master",
      },
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).not.toBe(0);
    const err = await new Response(proc.stderr).text();
    expect(err).toMatch(/32 bytes/);
  });
});

describe("access gate", () => {
  test("no cookie: pages redirect to the sign-in page", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sign-in");
  });

  test("no cookie: /api/* answers 401 with the house error shape", async () => {
    const res = await apiFetch(server.port, "", "/api/ffwd/state");
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe("unauthorized");
    expect(data.error.message).toMatch(/Sign in with the access key/);
    expect(data.error.details.how).toBe("POST /api/session {key}");
  });

  test("wrong key answers 401", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "wrong-key-entirely" }),
    });
    expect(res.status).toBe(401);
  });

  test("right key sets the session cookie (HttpOnly, SameSite=Lax, 7 days)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: TEST_ACCESS_KEY }),
    });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Max-Age=604800/);
  });

  test("a tampered token is rejected", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/ffwd/state`, {
      headers: { cookie: "ffwd_session=v1.9999999999.forged" },
    });
    expect(res.status).toBe(401);
  });
});
