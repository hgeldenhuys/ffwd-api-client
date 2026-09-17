import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The persistence boundary for the app. v1 is backed by bun:sqlite in a
 * single file; a later build adds a durable adapter. Keep this interface
 * limited to what the app actually calls.
 */

export type Scope = "collection" | "environment";

export interface SecretRow {
  scope: Scope;
  scopeId: string;
  name: string;
  has_value: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface CollectionRow {
  id: string;
  name: string;
  json: string;
  updated_at: string;
}

export interface EnvironmentRow {
  id: string;
  name: string;
  json: string;
  updated_at: string;
}

export interface HistoryRow {
  id: string;
  at: string;
  request_json: string;
  environment_id: string | null;
  collection_id: string | null;
  item_path: string | null;
  status: number | null;
  error: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
}

export interface Store {
  // collections
  listCollections(): CollectionRow[];
  getCollection(id: string): CollectionRow | null;
  createCollection(name: string, json: string): CollectionRow;
  updateCollection(id: string, name: string, json: string): CollectionRow | null;
  deleteCollection(id: string): boolean;
  // environments
  listEnvironments(): EnvironmentRow[];
  getEnvironment(id: string): EnvironmentRow | null;
  createEnvironment(name: string, json: string): EnvironmentRow;
  updateEnvironment(id: string, name: string, json: string): EnvironmentRow | null;
  deleteEnvironment(id: string): boolean;
  // secrets (ciphertext only ever crosses this interface)
  listSecrets(scope?: Scope, scopeId?: string): SecretRow[];
  getSecret(scope: Scope, scopeId: string, name: string): { ciphertext: Uint8Array; nonce: Uint8Array } | null;
  setSecret(scope: Scope, scopeId: string, name: string, ciphertext: Uint8Array, nonce: Uint8Array): void;
  deleteSecret(scope: Scope, scopeId: string, name: string): boolean;
  touchSecret(scope: Scope, scopeId: string, name: string): void;
  // history
  addHistory(row: Omit<HistoryRow, "id">): HistoryRow;
  listHistory(limit: number): HistoryRow[];
  getHistory(id: string): HistoryRow | null;
}

function uuid(): string {
  return crypto.randomUUID();
}

export class SqliteStore implements Store {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS environments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secrets (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        nonce BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        PRIMARY KEY (scope, scope_id, name)
      );
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        request_json TEXT NOT NULL,
        environment_id TEXT,
        collection_id TEXT,
        item_path TEXT,
        status INTEGER,
        error TEXT,
        duration_ms INTEGER,
        size_bytes INTEGER
      );
    `);
  }

  listCollections(): CollectionRow[] {
    return this.db
      .query("SELECT id, name, json, updated_at FROM collections ORDER BY updated_at DESC")
      .all() as CollectionRow[];
  }
  getCollection(id: string): CollectionRow | null {
    return (
      (this.db
        .query("SELECT id, name, json, updated_at FROM collections WHERE id = ?")
        .get(id) as CollectionRow | null) ?? null
    );
  }
  createCollection(name: string, json: string): CollectionRow {
    const row: CollectionRow = { id: uuid(), name, json, updated_at: new Date().toISOString() };
    this.db
      .query("INSERT INTO collections (id, name, json, updated_at) VALUES (?, ?, ?, ?)")
      .run(row.id, row.name, row.json, row.updated_at);
    return row;
  }
  updateCollection(id: string, name: string, json: string): CollectionRow | null {
    const updated_at = new Date().toISOString();
    const r = this.db
      .query("UPDATE collections SET name = ?, json = ?, updated_at = ? WHERE id = ?")
      .run(name, json, updated_at, id);
    if (r.changes === 0) return null;
    return this.getCollection(id);
  }
  deleteCollection(id: string): boolean {
    return this.db.query("DELETE FROM collections WHERE id = ?").run(id).changes > 0;
  }

  listEnvironments(): EnvironmentRow[] {
    return this.db
      .query("SELECT id, name, json, updated_at FROM environments ORDER BY updated_at DESC")
      .all() as EnvironmentRow[];
  }
  getEnvironment(id: string): EnvironmentRow | null {
    return (
      (this.db
        .query("SELECT id, name, json, updated_at FROM environments WHERE id = ?")
        .get(id) as EnvironmentRow | null) ?? null
    );
  }
  createEnvironment(name: string, json: string): EnvironmentRow {
    const row: EnvironmentRow = { id: uuid(), name, json, updated_at: new Date().toISOString() };
    this.db
      .query("INSERT INTO environments (id, name, json, updated_at) VALUES (?, ?, ?, ?)")
      .run(row.id, row.name, row.json, row.updated_at);
    return row;
  }
  updateEnvironment(id: string, name: string, json: string): EnvironmentRow | null {
    const updated_at = new Date().toISOString();
    const r = this.db
      .query("UPDATE environments SET name = ?, json = ?, updated_at = ? WHERE id = ?")
      .run(name, json, updated_at, id);
    if (r.changes === 0) return null;
    return this.getEnvironment(id);
  }
  deleteEnvironment(id: string): boolean {
    return this.db.query("DELETE FROM environments WHERE id = ?").run(id).changes > 0;
  }

  listSecrets(scope?: Scope, scopeId?: string): SecretRow[] {
    const rows = this.db
      .query(
        "SELECT scope, scope_id, name, length(ciphertext) as _len, created_at, updated_at, last_used_at FROM secrets ORDER BY name"
      )
      .all() as (Omit<SecretRow, "scopeId"> & { scope_id: string; _len: number })[];
    return rows
      .filter(
        (r) =>
          (scope === undefined || r.scope === scope) &&
          (scopeId === undefined || r.scope_id === scopeId)
      )
      .map(({ _len, scope_id, ...r }) => ({ ...r, scopeId: scope_id, has_value: _len > 0 }));
  }
  getSecret(scope: Scope, scopeId: string, name: string) {
    const row = this.db
      .query("SELECT ciphertext, nonce FROM secrets WHERE scope = ? AND scope_id = ? AND name = ?")
      .get(scope, scopeId, name) as { ciphertext: Uint8Array; nonce: Uint8Array } | null;
    return row ?? null;
  }
  setSecret(scope: Scope, scopeId: string, name: string, ciphertext: Uint8Array, nonce: Uint8Array): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO secrets (scope, scope_id, name, ciphertext, nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce, updated_at = excluded.updated_at`
      )
      .run(scope, scopeId, name, ciphertext, nonce, now, now);
  }
  deleteSecret(scope: Scope, scopeId: string, name: string): boolean {
    return (
      this.db
        .query("DELETE FROM secrets WHERE scope = ? AND scope_id = ? AND name = ?")
        .run(scope, scopeId, name).changes > 0
    );
  }
  touchSecret(scope: Scope, scopeId: string, name: string): void {
    this.db
      .query("UPDATE secrets SET last_used_at = ? WHERE scope = ? AND scope_id = ? AND name = ?")
      .run(new Date().toISOString(), scope, scopeId, name);
  }

  addHistory(row: Omit<HistoryRow, "id">): HistoryRow {
    const full: HistoryRow = { ...row, id: uuid() };
    this.db
      .query(
        `INSERT INTO history (id, at, request_json, environment_id, collection_id, item_path, status, error, duration_ms, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        full.id,
        full.at,
        full.request_json,
        full.environment_id,
        full.collection_id,
        full.item_path,
        full.status,
        full.error,
        full.duration_ms,
        full.size_bytes
      );
    // keep only the last 200
    this.db
      .query(
        `DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY at DESC LIMIT 200)`
      )
      .run();
    return full;
  }
  listHistory(limit: number): HistoryRow[] {
    return this.db
      .query(
        "SELECT * FROM history ORDER BY at DESC LIMIT ?"
      )
      .all(Math.min(limit, 200)) as HistoryRow[];
  }
  getHistory(id: string): HistoryRow | null {
    return (this.db.query("SELECT * FROM history WHERE id = ?").get(id) as HistoryRow | null) ?? null;
  }
}

let store: Store | null = null;

export function getStore(): Store {
  if (!store) {
    store = storeFromEnv();
  }
  return store;
}

/**
 * The host's one-line store choice: this core package only knows SQLite, so
 * the choice is always SqliteStore — data is durable on this machine only.
 * Logs one line saying so. Hosts that want a durable store across deploys
 * implement `Store` themselves (the root README's Hosts section points at a
 * worked example) and pass it instead.
 */
export function storeFromEnv(opts?: { sqlitePath?: string }): Store {
  const dataDir = process.env.DATA_DIR ?? "./data";
  const sqlitePath = opts?.sqlitePath ?? join(dataDir, "ffwd.sqlite");
  console.log("using SqliteStore (the core package only knows SQLite): data is durable on this machine only. Provide a Store implementation for storage that survives a redeploy.");
  return new SqliteStore(sqlitePath);
}
