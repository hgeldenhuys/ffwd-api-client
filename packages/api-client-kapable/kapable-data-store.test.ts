import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "@ffwd/api-client-server";
import { KapableDataStore, storeFromEnv, type KapableDataStoreOptions } from "./src/index";

// ---- the in-process fake platform data service (the four routes the store uses) ----

interface FakeRow {
  id: string;
  kind: string;
  ref: string;
  body: any;
}

function startFake() {
  const rows: FakeRow[] = [];
  const tables = new Map<string, any>();
  let failNextWrites = 0;
  const log: { method: string; path: string }[] = [];
  let nextId = 1;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      log.push({ method: req.method, path: url.pathname });
      if (req.method === "POST" && url.pathname === "/v1/tables") {
        const spec = (await req.json()) as { name: string; columns: any };
        if (tables.has(spec.name)) return new Response("already exists", { status: 409 });
        tables.set(spec.name, spec);
        return Response.json({ ok: true }, { status: 201 });
      }
      const m = url.pathname.match(/^\/v1\/([^/]+)(?:\/([^/]+))?$/);
      if (!m) return new Response("nope", { status: 404 });
      const [, table, id] = m;
      if (table !== "ffwd_store") return new Response("no table", { status: 404 });
      if (req.method === "POST") {
        if (failNextWrites > 0) {
          failNextWrites--;
          return new Response("boom", { status: 500 });
        }
        const b = (await req.json()) as { kind: string; ref: string; body: any };
        const row: FakeRow = { id: `row-${nextId++}`, kind: b.kind, ref: b.ref, body: b.body };
        rows.push(row);
        return Response.json({ id: row.id }, { status: 201 });
      }
      if (req.method === "PATCH" && id) {
        if (failNextWrites > 0) {
          failNextWrites--;
          return new Response("boom", { status: 500 });
        }
        const row = rows.find((r) => r.id === id);
        if (!row) return new Response("not found", { status: 404 });
        const b = (await req.json()) as { body: any };
        row.body = b.body;
        return Response.json({ id: row.id });
      }
      if (req.method === "DELETE" && id) {
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) return new Response("not found", { status: 404 });
        rows.splice(i, 1);
        return new Response(null, { status: 204 });
      }
      if (req.method === "GET") {
        const kind = url.searchParams.get("kind");
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const data = rows.filter((r) => (kind ? r.kind === kind : true)).slice(offset, offset + limit);
        return Response.json({ data });
      }
      return new Response("method", { status: 405 });
    },
  });

  return {
    server,
    rows,
    tables,
    log,
    failNext: (n = 1) => {
      failNextWrites = n;
    },
    stop: () => server.stop(true),
  };
}

// ---- harness ----

const TMP = join(import.meta.dir, ".tmp-kapable-data-store-test");

function makeStore(fake: ReturnType<typeof startFake>, sqlitePath: string): KapableDataStore {
  const opts: KapableDataStoreOptions = {
    sqlitePath,
    orgKey: "test-org-key",
    apiBase: `http://localhost:${fake.server.port}`,
    table: "ffwd_store",
    retryMs: 0, // tests drive syncDirty directly
  };
  return new KapableDataStore(opts);
}

function seal(value: string): { ciphertext: Uint8Array; nonce: Uint8Array } {
  // stand-in for the real AES-GCM seal: the store only carries opaque bytes
  const enc = new TextEncoder();
  return { ciphertext: enc.encode(`CIPHER(${value})`), nonce: enc.encode("nonce123456") };
}

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("KapableDataStore", () => {
  test("boot against an empty fake creates the table", async () => {
    mkdirSync(TMP, { recursive: true });
    const fake = startFake();
    try {
      const store = makeStore(fake, join(TMP, "boot", "a.sqlite"));
      await store.ready;
      expect(fake.tables.has("ffwd_store")).toBe(true);
      const cols = fake.tables.get("ffwd_store").columns;
      expect(cols).toEqual([
        { name: "kind", col_type: "text", indexed: true },
        { name: "ref", col_type: "text", indexed: true },
        { name: "body", col_type: "json", nullable: true },
      ]);
      expect(fake.log[0]).toEqual({ method: "POST", path: "/v1/tables" });
    } finally {
      fake.stop();
    }
  });

  test("writes go through: collection, environment, secret, history → four inserts, right kinds, no plaintext secret", async () => {
    const fake = startFake();
    try {
      const store = makeStore(fake, join(TMP, "write", "a.sqlite"));
      await store.ready;
      const rowsBefore = fake.rows.length;
      const col = store.createCollection("My Collection", JSON.stringify({ info: { name: "My Collection" } }));
      const env = store.createEnvironment("prod", JSON.stringify({ name: "prod", values: [] }));
      const { ciphertext, nonce } = seal("super-secret-value-123");
      store.setSecret("collection", col.id, "token", ciphertext, nonce);
      store.addHistory({
        at: new Date().toISOString(),
        request_json: JSON.stringify({ method: "GET", url: "https://x.example" }),
        environment_id: env.id,
        collection_id: col.id,
        item_path: "Get me",
        status: 200,
        error: null,
        duration_ms: 12,
        size_bytes: 34,
      });
      await store.flush();

      expect(fake.rows.length - rowsBefore).toBe(4);
      const kinds = fake.rows.slice(rowsBefore).map((r) => r.kind).sort();
      expect(kinds).toEqual(["collection", "environment", "history", "secret"]);
      const secretRow = fake.rows.slice(rowsBefore).find((r) => r.kind === "secret")!;
      expect(secretRow.ref).toBe(`collection:${col.id}:token`);
      expect(JSON.stringify(secretRow.body)).not.toContain("super-secret-value-123");
      expect(secretRow.body.ciphertext).toBe(Buffer.from(ciphertext).toString("base64"));
      expect(secretRow.body.nonce).toBe(Buffer.from(nonce).toString("base64"));
    } finally {
      fake.stop();
    }
  });

  test("restart with an empty SQLite restores everything from the platform", async () => {
    const fake = startFake();
    try {
      const dir = join(TMP, "restart");
      const first = makeStore(fake, join(dir, "a.sqlite"));
      await first.ready;
      const col = first.createCollection("Restorable", JSON.stringify({ info: { name: "Restorable" }, item: [{ name: "Get me" }] }));
      const env = first.createEnvironment("staging", JSON.stringify({ name: "staging", values: [{ key: "a", value: "1" }] }));
      const { ciphertext, nonce } = seal("another-secret-4567");
      first.setSecret("environment", env.id, "apiKey", ciphertext, nonce);
      first.addHistory({
        at: new Date().toISOString(),
        request_json: JSON.stringify({ method: "POST", url: "https://y.example" }),
        environment_id: env.id,
        collection_id: col.id,
        item_path: "Post it",
        status: 201,
        error: null,
        duration_ms: 5,
        size_bytes: 6,
      });
      await first.flush();
      first.close();

      // a redeploy: brand-new container, EMPTY sqlite, same platform data
      const second = makeStore(fake, join(dir, "b.sqlite"));
      await second.ready;

      const cols = second.listCollections();
      expect(cols.map((c) => c.name)).toEqual(["Restorable"]);
      expect(JSON.parse(cols[0].json).item[0].name).toBe("Get me");
      const envs = second.listEnvironments();
      expect(envs.map((e) => e.name)).toEqual(["staging"]);
      const secret = second.getSecret("environment", envs[0].id, "apiKey")!;
      expect(Buffer.from(secret.ciphertext).toString()).toBe(`CIPHER(another-secret-4567)`);
      expect(Buffer.from(secret.nonce).toString()).toBe("nonce123456");
      const hist = second.listHistory(200);
      expect(hist).toHaveLength(1);
      expect(hist[0].item_path).toBe("Post it");
      second.close();
    } finally {
      fake.stop();
    }
  });

  test("a failed platform write keeps the local write and the dirty row; the retry pushes it", async () => {
    const fake = startFake();
    try {
      const store = makeStore(fake, join(TMP, "dirty", "a.sqlite"));
      await store.ready;
      fake.failNext(1);
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (m: string) => warns.push(String(m));
      const col = store.createCollection("Offline write", JSON.stringify({ info: { name: "Offline write" } }));
      await store.flush();
      console.warn = origWarn;

      // local write succeeded even though the platform said 500
      expect(store.listCollections().map((c) => c.name)).toEqual(["Offline write"]);
      // the failure was logged once, naming kind, ref and status
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("kind=collection");
      expect(warns[0]).toContain(`ref=${col.id}`);
      expect(warns[0]).toContain("status=500");

      // platform does not have it yet
      expect(fake.rows.filter((r) => r.kind === "collection")).toHaveLength(0);

      // retry pushes it and clears the dirty mark
      await store.syncDirty();
      expect(fake.rows.filter((r) => r.kind === "collection")).toHaveLength(1);
      expect(store["dirty"].size).toBe(0);
      await store.syncDirty(); // no further writes
      expect(fake.rows.filter((r) => r.kind === "collection")).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a restore never overwrites a local row that is newer than the platform copy", async () => {
    const fake = startFake();
    try {
      const dir = join(TMP, "newer");
      const path = join(dir, "a.sqlite");
      const first = makeStore(fake, path);
      await first.ready;
      const col = first.createCollection("v1 name", JSON.stringify({ info: { name: "v1 name" } }));
      await first.flush();
      first.close();

      // the update FAILS on the platform (deploy blip): local is now newer
      fake.failNext(1);
      const quiet = console.warn;
      console.warn = () => {};
      const second = makeStore(fake, path);
      await second.ready;
      second.updateCollection(col.id, "v2 name", JSON.stringify({ info: { name: "v2 name" } }));
      await second.flush();
      console.warn = quiet;
      second.close();
      expect(fake.rows.find((r) => r.kind === "collection")!.body.name).toBe("v1 name");

      // reboot: the platform still has v1; the restore must keep local v2
      const third = makeStore(fake, path);
      await third.ready;
      expect(third.listCollections()[0].name).toBe("v2 name");
      // and the dirty row gets pushed by the boot sync
      expect(fake.rows.find((r) => r.kind === "collection")!.body.name).toBe("v2 name");
      third.close();
    } finally {
      fake.stop();
    }
  });

  test("history is capped at 200 on the platform too", async () => {
    const fake = startFake();
    try {
      const store = makeStore(fake, join(TMP, "cap", "a.sqlite"));
      await store.ready;
      for (let i = 0; i < 205; i++) {
        store.addHistory({
          at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          request_json: JSON.stringify({ i }),
          environment_id: null,
          collection_id: null,
          item_path: `r${i}`,
          status: 200,
          error: null,
          duration_ms: 1,
          size_bytes: 1,
        });
      }
      await store.flush();
      // local cap
      expect(store.listHistory(500)).toHaveLength(200);
      // platform cap: the 5 oldest are gone
      const remote = fake.rows.filter((r) => r.kind === "history");
      expect(remote).toHaveLength(200);
      expect(remote.map((r) => r.body.item_path)).not.toContain("r0");
      expect(remote.map((r) => r.body.item_path)).toContain("r204");
    } finally {
      fake.stop();
    }
  });

  test("storeFromEnv logs which store it chose and why", () => {
    const orig = process.env.KAPABLE_ORG_KEY;
    try {
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (m: string) => lines.push(String(m));
      delete process.env.KAPABLE_ORG_KEY;
      const s1 = storeFromEnv({ sqlitePath: join(TMP, "env1", "a.sqlite") });
      console.log = origLog;
      expect(lines[0]).toContain("using SqliteStore");
      expect(lines[0]).toContain("KAPABLE_ORG_KEY is not set");

      lines.length = 0;
      console.log = (m: string) => lines.push(String(m));
      process.env.KAPABLE_ORG_KEY = "env-test-key";
      const s2 = storeFromEnv({ sqlitePath: join(TMP, "env2", "a.sqlite") });
      console.log = origLog;
      expect(lines[0]).toContain("using KapableDataStore");
      expect(lines[0]).toContain("KAPABLE_ORG_KEY is set");
      expect(s2).toBeInstanceOf(KapableDataStore);
    } finally {
      if (orig === undefined) delete process.env.KAPABLE_ORG_KEY;
      else process.env.KAPABLE_ORG_KEY = orig;
    }
  });
});
