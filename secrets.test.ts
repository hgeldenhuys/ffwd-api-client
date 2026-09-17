import { beforeEach, describe, expect, test } from "bun:test";
import { sealSecret, openSecret } from "@ffwd/api-client-server";

// 32 test-only bytes, base64
const MASTER = Uint8Array.from(Buffer.from("KjUlM2Y3YThkMmMxZTBiNDk2YTdmM2U4ZDBjNWExYjI=", "base64"));
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => i);

describe("secret encryption at rest", () => {
  test("round trip", async () => {
    const sealed = await sealSecret(MASTER, "collection", "col-1", "token", "hunter2-hunter2");
    const opened = await openSecret(MASTER, "collection", "col-1", "token", sealed);
    expect(opened).toBe("hunter2-hunter2");
  });
  test("ciphertext differs from plaintext and nonce is random per write", async () => {
    const a = await sealSecret(MASTER, "collection", "col-1", "token", "hunter2-hunter2");
    const b = await sealSecret(MASTER, "collection", "col-1", "token", "hunter2-hunter2");
    expect(Buffer.from(a.ciphertext).toString("hex")).not.toBe("hunter2-hunter2");
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
  });
  test("wrong key fails", async () => {
    const sealed = await sealSecret(MASTER, "collection", "col-1", "token", "hunter2-hunter2");
    await expect(openSecret(OTHER, "collection", "col-1", "token", sealed)).rejects.toThrow();
  });
  test("wrong AAD (name/scope) fails", async () => {
    const sealed = await sealSecret(MASTER, "collection", "col-1", "token", "hunter2-hunter2");
    await expect(openSecret(MASTER, "collection", "col-1", "other", sealed)).rejects.toThrow();
    await expect(openSecret(MASTER, "environment", "col-1", "token", sealed)).rejects.toThrow();
  });
});

// ---- route contract: no route ever returns a secret value -------------------
// Build 2: the routes moved INTO createApiClientHandler, so the contract is
// asserted behaviourally against the handler (plus the same source greps).

import { createApiClientHandler, SqliteStore } from "@ffwd/api-client-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function testHandler() {
  return createApiClientHandler({
    store: new SqliteStore(join(mkdtempSync(join(tmpdir(), "ffwd-contract-")), "t.sqlite")),
    masterKey: Buffer.from(new Uint8Array(32).map((_, i) => (i * 13 + 5) % 256)).toString("base64"),
    auth: async () => ({ ok: true, principal: "test" }),
  });
}

const BASE = "http://test.local/api/ffwd";

describe("secret route contract", () => {
  test("the value-setting route answers NOTHING on GET (there is no loader to read a value)", async () => {
    const handler = testHandler();
    const res = await handler(new Request(`${BASE}/secrets/collection/col-1/token`, { method: "GET" }));
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(405); // PUT and DELETE are the only methods on this route
  });

  test("the list route returns metadata only — enumerating every field it serialises", async () => {
    const handler = testHandler();
    await handler(new Request(`${BASE}/secrets/collection/col-1/token`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "hunter2-hunter2" }),
    }));
    const res = await handler(new Request(`${BASE}/secrets`, { method: "GET" }));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    const allowed = new Set(["name", "scope", "scopeId", "has_value", "updated_at", "last_used_at"]);
    for (const field of Object.keys(rows[0])) {
      expect(allowed.has(field)).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toContain("hunter2-hunter2");
  });

  test("grep the whole server package: no route serialises a plaintext value", () => {
    const proc = Bun.spawnSync([
      "grep",
      "-rn",
      "value: sealed\\|plaintext\\|return Response.json(sealed",
      "packages/api-client-server/src/",
    ]);
    // exit code 1 = no matches, which is what we want
    expect(proc.exitCode).toBe(1);
  });
});
