/**
 * KapableDataStore — a durable `Store` for hosts that run on the platform,
 * where a deploy replaces the container and its SQLite file.
 *
 * SQLite stays the local read model (page loads never touch the network);
 * every write ALSO goes through to the platform's data service (Danou's CRM
 * write-through pattern, `danou-youtube-crm/src/store.ts`), and on boot the
 * local model is restored from the platform. A failed platform write never
 * breaks a request: it is logged once (kind, ref, HTTP status), the local
 * write still succeeds, and the row is marked dirty so the next boot or the
 * 60 s retry pushes it.
 *
 * A secret row's platform body is the ciphertext + nonce + metadata exactly
 * as SQLite stores it (base64 over the wire) — the platform never sees a
 * secret value and the master key never leaves the process.
 *
 * A restore never overwrites a local row that is newer than the platform
 * copy (the reference pattern's `store_local` stamp: every local write
 * stamps its time, and the restore refuses anything older).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore, type CollectionRow, type EnvironmentRow, type HistoryRow, type Scope, type SecretRow, type Store } from "@ffwd/api-client-server";

export type DataKind = "collection" | "environment" | "secret" | "history" | "workspace";

export interface KapableDataStoreOptions {
  sqlitePath: string;
  orgKey: string;
  apiBase?: string; // default https://api.kapable.ai
  table?: string; // default apiclient_store
  /** Retry interval for dirty rows, ms (default 60_000; 0 disables the timer — tests drive syncDirty directly). */
  retryMs?: number;
}

interface IdRow {
  kind: string;
  ref: string;
  row_id: string;
}

export class KapableDataStore implements Store {
  readonly local: SqliteStore;
  readonly ready: Promise<void>;
  private db: Database; // same file as `local`: sync bookkeeping + restore upserts
  private apiBase: string;
  private table: string;
  private key: string;
  private inflight = new Set<Promise<unknown>>();
  private loggedFailing = new Set<string>(); // (kind,ref) currently failing — log once per failure episode
  private dirty = new Map<string, { kind: DataKind; ref: string; op: "put" | "delete" }>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: KapableDataStoreOptions) {
    if (!opts.orgKey) throw new Error("KapableDataStore needs an org API key (orgKey / KAPABLE_ORG_KEY): set it to the org key minted in kapable-auth.");
    this.apiBase = (opts.apiBase ?? "https://api.kapable.ai").replace(/\/$/, "");
    this.table = opts.table ?? "ffwd_store";
    this.key = opts.orgKey;
    mkdirSync(join(opts.sqlitePath, ".."), { recursive: true });
    this.local = new SqliteStore(opts.sqlitePath);
    this.db = new Database(opts.sqlitePath, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_ids (kind TEXT NOT NULL, ref TEXT NOT NULL, row_id TEXT NOT NULL, PRIMARY KEY (kind, ref));
      CREATE TABLE IF NOT EXISTS store_local (kind TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (kind, ref));
      CREATE TABLE IF NOT EXISTS store_dirty (kind TEXT NOT NULL, ref TEXT NOT NULL, op TEXT NOT NULL DEFAULT 'put', PRIMARY KEY (kind, ref));
    `);
    for (const r of this.db.query("SELECT kind, ref, op FROM store_dirty").all() as { kind: DataKind; ref: string; op: "put" | "delete" }[]) {
      this.dirty.set(`${r.kind}:${r.ref}`, r);
    }
    if (opts.retryMs !== 0) {
      this.retryTimer = setInterval(() => void this.syncDirty(), opts.retryMs ?? 60_000);
      this.retryTimer.unref?.();
    }
    this.ready = this.boot();
  }

  private async boot(): Promise<void> {
    try {
      await this.ensureTable();
      await this.restore();
      await this.syncDirty();
    } catch (e) {
      console.warn(`[kapable-data] boot restore failed (${e instanceof Error ? e.message : String(e)}): serving local data, will retry on next boot.`);
    }
  }

  // ---- platform calls ----

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async ensureTable(): Promise<void> {
    const res = await this.call("POST", "/v1/tables", {
      name: this.table,
      workspace_scoped: false,
      columns: [
        { name: "kind", col_type: "text", indexed: true },
        { name: "ref", col_type: "text", indexed: true },
        { name: "body", col_type: "json", nullable: true },
      ],
    });
    // 409 / "already exists" is the normal path after the first boot.
    if (!res.ok && res.status !== 409) {
      const t = await res.text();
      if (!t.includes("already exists")) throw new Error(`could not create table ${this.table} (HTTP ${res.status}): ${t.slice(0, 200)}`);
    }
  }

  /** Track a write so `flush()` can await it; never lets a rejection escape. */
  private track(p: Promise<unknown>): void {
    const wrapped = p.catch(() => {});
    this.inflight.add(wrapped);
    void wrapped.finally(() => this.inflight.delete(wrapped));
  }

  private remoteId(kind: DataKind, ref: string): string | undefined {
    return (this.db.query("SELECT row_id FROM store_ids WHERE kind=? AND ref=?").get(kind, ref) as IdRow | null)?.row_id;
  }

  private stampLocal(kind: DataKind, ref: string, at: string): void {
    this.db
      .query("INSERT INTO store_local (kind,ref,at) VALUES (?,?,?) ON CONFLICT(kind,ref) DO UPDATE SET at=excluded.at")
      .run(kind, ref, at);
  }

  private localIsNewer(kind: DataKind, ref: string, remoteAt: string | undefined): boolean {
    if (!remoteAt) return false;
    const l = this.db.query("SELECT at FROM store_local WHERE kind=? AND ref=?").get(kind, ref) as { at: string } | null;
    return Boolean(l && l.at > remoteAt);
  }

  /**
   * Push one row. Never throws. On failure: log once per episode (the
   * message names the kind, the ref and the HTTP status), mark dirty.
   */
  private async push(kind: DataKind, ref: string, body: () => unknown): Promise<void> {
    const tag = `${kind}:${ref}`;
    try {
      const known = this.remoteId(kind, ref);
      const payload = body();
      if (known) {
        const res = await this.call("PATCH", `/v1/${this.table}/${known}`, { body: payload });
        if (res.ok) return this.clearFailing(kind, ref);
        if (res.status !== 404) return this.fail(tag, kind, ref, res.status);
        this.db.query("DELETE FROM store_ids WHERE kind=? AND ref=?").run(kind, ref); // platform lost it: re-insert below
      }
      const res = await this.call("POST", `/v1/${this.table}`, { kind, ref, body: payload });
      if (!res.ok) return this.fail(tag, kind, ref, res.status);
      const row = (await res.json()) as { id?: string };
      if (row.id) {
        this.db
          .query("INSERT INTO store_ids (kind,ref,row_id) VALUES (?,?,?) ON CONFLICT(kind,ref) DO UPDATE SET row_id=excluded.row_id")
          .run(kind, ref, row.id);
      }
      this.clearFailing(kind, ref);
    } catch (e) {
      this.fail(tag, kind, ref, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  private fail(tag: string, kind: DataKind, ref: string, status?: number, message?: string): void {
    this.markDirty(tag, kind, ref, "put");
    if (this.loggedFailing.has(tag)) return; // logged once per failure episode
    this.loggedFailing.add(tag);
    console.warn(
      `[kapable-data] platform write failed (kind=${kind} ref=${ref}${status ? ` status=${status}` : ""}${message ? `: ${message}` : ""}) — kept locally, marked dirty, will retry.`
    );
  }

  private clearFailing(kind: DataKind, ref: string): void {
    const tag = `${kind}:${ref}`;
    this.loggedFailing.delete(tag);
    if (this.dirty.has(tag)) {
      this.dirty.delete(tag);
      this.db.query("DELETE FROM store_dirty WHERE kind=? AND ref=?").run(kind, ref);
    }
  }

  private markDirty(tag: string, kind: DataKind, ref: string, op: "put" | "delete"): void {
    this.dirty.set(tag, { kind, ref, op });
    this.db
      .query("INSERT INTO store_dirty (kind,ref,op) VALUES (?,?,?) ON CONFLICT(kind,ref) DO UPDATE SET op=excluded.op")
      .run(kind, ref, op);
  }

  /** Push every dirty row; resolves when the queue is drained (or every push failed). */
  async syncDirty(): Promise<number> {
    const entries = [...this.dirty.values()];
    await Promise.all(
      entries.map(({ kind, ref, op }) =>
        op === "delete" ? this.pushDelete(kind, ref) : this.push(kind, ref, () => this.bodyFor(kind, ref))
      )
    );
    return entries.length;
  }

  /** Await all in-flight write-throughs (test determinism / graceful shutdown). */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private async pushDelete(kind: DataKind, ref: string): Promise<void> {
    const tag = `${kind}:${ref}`;
    try {
      const known = this.remoteId(kind, ref);
      if (known) {
        const res = await this.call("DELETE", `/v1/${this.table}/${known}`);
        if (!res.ok && res.status !== 404) return this.failDelete(tag, kind, ref, res.status);
        this.db.query("DELETE FROM store_ids WHERE kind=? AND ref=?").run(kind, ref);
      }
      this.clearFailing(kind, ref);
    } catch (e) {
      this.failDelete(tag, kind, ref, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  private failDelete(tag: string, kind: DataKind, ref: string, status?: number, message?: string): void {
    this.markDirty(tag, kind, ref, "delete");
    if (this.loggedFailing.has(tag)) return;
    this.loggedFailing.add(tag);
    console.warn(`[kapable-data] platform delete failed (kind=${kind} ref=${ref}${status ? ` status=${status}` : ""}${message ? `: ${message}` : ""}) — row will come back on restore until the retry succeeds.`);
  }

  /** The platform body for a (kind, ref), rebuilt from the local SQLite row. */
  private bodyFor(kind: DataKind, ref: string): unknown {
    const at = new Date().toISOString();
    if (kind === "collection") {
      const r = this.local.getCollection(ref);
      return r ? { name: r.name, json: r.json, at: r.updated_at } : null;
    }
    if (kind === "environment") {
      const r = this.local.getEnvironment(ref);
      return r ? { name: r.name, json: r.json, at: r.updated_at } : null;
    }
    if (kind === "secret") {
      const [scope, scopeId, ...rest] = ref.split(":") as [Scope, string, string[]];
      const name = rest.join(":");
      const meta = this.local.listSecrets(scope, scopeId).find((s) => s.name === name);
      const raw = this.local.getSecret(scope, scopeId, name);
      if (!meta || !raw) return null;
      return {
        scope,
        scopeId,
        name,
        ciphertext: Buffer.from(raw.ciphertext).toString("base64"),
        nonce: Buffer.from(raw.nonce).toString("base64"),
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        last_used_at: meta.last_used_at,
        at: meta.updated_at,
      };
    }
    if (kind === "history") {
      const r = this.local.getHistory(ref);
      return r ? { ...r, at: r.at } : null;
    }
    return null;
  }

  private writeThrough(kind: DataKind, ref: string, at: string): Promise<void> {
    this.stampLocal(kind, ref, at);
    const p = this.push(kind, ref, () => this.bodyFor(kind, ref));
    this.track(p);
    return p;
  }

  private deleteThrough(kind: DataKind, ref: string): void {
    this.track(this.pushDelete(kind, ref));
  }

  // ---- restore ----

  private async fetchAll(): Promise<{ id: string; kind: DataKind; ref: string; body: any }[]> {
    const out: { id: string; kind: DataKind; ref: string; body: any }[] = [];
    for (let offset = 0; offset < 20_000; offset += 200) {
      const res = await this.call("GET", `/v1/${this.table}?limit=200&offset=${offset}`);
      if (res.status === 404) return out; // table not made yet: nothing saved
      if (!res.ok) throw new Error(`reading saved data failed (HTTP ${res.status})`);
      const d = (await res.json()) as { data?: { id: string; kind: DataKind; ref: string; body: any }[] };
      const batch = d.data ?? [];
      out.push(...batch);
      if (batch.length < 200) break;
    }
    return out;
  }

  private async restore(): Promise<{ applied: number; skipped: number }> {
    const rows = await this.fetchAll();
    let applied = 0;
    let skipped = 0;
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      this.db
        .query("INSERT INTO store_ids (kind,ref,row_id) VALUES (?,?,?) ON CONFLICT(kind,ref) DO UPDATE SET row_id=excluded.row_id")
        .run(r.kind, r.ref, r.id);
      const at = r.body?.at;
      if (this.localIsNewer(r.kind, r.ref, at)) {
        skipped++;
        continue;
      }
      if (this.applyRow(r.kind, r.ref, r.body)) applied++;
      else skipped++;
    }
    return { applied, skipped };
  }

  /** Write one platform row into the local SQLite model. */
  private applyRow(kind: DataKind, ref: string, body: any): boolean {
    if (!body || typeof body !== "object") return false;
    if (kind === "collection") {
      this.db
        .query("INSERT INTO collections (id,name,json,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, json=excluded.json, updated_at=excluded.updated_at")
        .run(ref, String(body.name ?? "Collection"), String(body.json ?? "{}"), String(body.at ?? new Date().toISOString()));
      return true;
    }
    if (kind === "environment") {
      this.db
        .query("INSERT INTO environments (id,name,json,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, json=excluded.json, updated_at=excluded.updated_at")
        .run(ref, String(body.name ?? "Environment"), String(body.json ?? "{}"), String(body.at ?? new Date().toISOString()));
      return true;
    }
    if (kind === "secret") {
      this.db
        .query(
          `INSERT INTO secrets (scope, scope_id, name, ciphertext, nonce, created_at, updated_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, scope_id, name) DO UPDATE SET ciphertext=excluded.ciphertext, nonce=excluded.nonce, updated_at=excluded.updated_at, last_used_at=excluded.last_used_at`
        )
        .run(
          String(body.scope),
          String(body.scopeId),
          String(body.name),
          Buffer.from(String(body.ciphertext ?? ""), "base64"),
          Buffer.from(String(body.nonce ?? ""), "base64"),
          String(body.created_at ?? body.at ?? new Date().toISOString()),
          String(body.updated_at ?? body.at ?? new Date().toISOString()),
          body.last_used_at ?? null
        );
      return true;
    }
    if (kind === "history") {
      this.db
        .query(
          `INSERT OR REPLACE INTO history (id, at, request_json, environment_id, collection_id, item_path, status, error, duration_ms, size_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ref,
          String(body.at ?? new Date().toISOString()),
          String(body.request_json ?? "{}"),
          body.environment_id ?? null,
          body.collection_id ?? null,
          body.item_path ?? null,
          body.status ?? null,
          body.error ?? null,
          body.duration_ms ?? null,
          body.size_bytes ?? null
        );
      return true;
    }
    return false; // "workspace" rows have no local table yet (v1 has exactly one workspace)
  }

  /** Cap the platform's history at 200, deleting the oldest. Converges: re-checks after every delete round, so concurrent inserts cannot leave extras behind. */
  private async pruneRemoteHistory(): Promise<void> {
    try {
      for (let round = 0; round < 10; round++) {
        const rows: { id: string; body: { at?: string } }[] = [];
        for (let offset = 0; offset < 20_000; offset += 200) {
          const res = await this.call("GET", `/v1/${this.table}?kind=history&limit=200&offset=${offset}`);
          if (!res.ok) return;
          const batch = ((await res.json()) as { data?: { id: string; body: { at?: string } }[] }).data ?? [];
          rows.push(...batch);
          if (batch.length < 200) break;
        }
        rows.sort((a, b) => (a.body?.at ?? "").localeCompare(b.body?.at ?? ""));
        const extras = rows.slice(0, Math.max(0, rows.length - 200));
        if (extras.length === 0) return;
        for (const r of extras) {
          await this.call("DELETE", `/v1/${this.table}/${r.id}`);
          this.db.query("DELETE FROM store_ids WHERE kind='history' AND ref=?").run(r.id);
        }
      }
    } catch {
      // pruning is best-effort; the local cap is what the app relies on
    }
  }

  // ---- Store implementation: local write first, then write-through ----

  listCollections(): CollectionRow[] { return this.local.listCollections(); }
  getCollection(id: string) { return this.local.getCollection(id); }
  createCollection(name: string, json: string): CollectionRow {
    const row = this.local.createCollection(name, json);
    this.writeThrough("collection", row.id, row.updated_at);
    return row;
  }
  updateCollection(id: string, name: string, json: string) {
    const row = this.local.updateCollection(id, name, json);
    if (row) this.writeThrough("collection", id, row.updated_at);
    return row;
  }
  deleteCollection(id: string): boolean {
    const ok = this.local.deleteCollection(id);
    if (ok) this.deleteThrough("collection", id);
    return ok;
  }

  listEnvironments(): EnvironmentRow[] { return this.local.listEnvironments(); }
  getEnvironment(id: string) { return this.local.getEnvironment(id); }
  createEnvironment(name: string, json: string): EnvironmentRow {
    const row = this.local.createEnvironment(name, json);
    this.writeThrough("environment", row.id, row.updated_at);
    return row;
  }
  updateEnvironment(id: string, name: string, json: string) {
    const row = this.local.updateEnvironment(id, name, json);
    if (row) this.writeThrough("environment", id, row.updated_at);
    return row;
  }
  deleteEnvironment(id: string): boolean {
    const ok = this.local.deleteEnvironment(id);
    if (ok) this.deleteThrough("environment", id);
    return ok;
  }

  listSecrets(scope?: Scope, scopeId?: string): SecretRow[] { return this.local.listSecrets(scope, scopeId); }
  getSecret(scope: Scope, scopeId: string, name: string) { return this.local.getSecret(scope, scopeId, name); }
  setSecret(scope: Scope, scopeId: string, name: string, ciphertext: Uint8Array, nonce: Uint8Array): void {
    this.local.setSecret(scope, scopeId, name, ciphertext, nonce);
    const meta = this.local.listSecrets(scope, scopeId).find((s) => s.name === name);
    this.writeThrough("secret", `${scope}:${scopeId}:${name}`, meta?.updated_at ?? new Date().toISOString());
  }
  deleteSecret(scope: Scope, scopeId: string, name: string): boolean {
    const ok = this.local.deleteSecret(scope, scopeId, name);
    if (ok) this.deleteThrough("secret", `${scope}:${scopeId}:${name}`);
    return ok;
  }
  touchSecret(scope: Scope, scopeId: string, name: string): void {
    this.local.touchSecret(scope, scopeId, name);
    // last_used_at is metadata; push it but never let it fail a request
    this.track(this.push("secret", `${scope}:${scopeId}:${name}`, () => this.bodyFor("secret", `${scope}:${scopeId}:${name}`)));
  }

  addHistory(row: Omit<HistoryRow, "id">): HistoryRow {
    const full = this.local.addHistory(row);
    const p = this.writeThrough("history", full.id, full.at);
    // prune only after this row's own push resolved, so the last prune always
    // sees every row and the platform cap converges to exactly 200
    this.track(p.then(() => this.pruneRemoteHistory()));
    return full;
  }
  listHistory(limit: number): HistoryRow[] { return this.local.listHistory(limit); }
  getHistory(id: string) { return this.local.getHistory(id); }

  close(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }
}
