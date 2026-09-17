/**
 * @ffwd/api-client-kapable — the Kapable-platform adapter for the ffwd API
 * client: a durable Store with write-through to the platform's data service,
 * and "Sign in with Kapable" SSO auth. Everything here is specific to hosting
 * on Kapable; the core packages carry none of it.
 */
export {
  KapableDataStore,
  type DataKind,
  type KapableDataStoreOptions,
} from "./kapable-data-store";

export {
  kapableSessionAuth,
  kapableExchange,
  kapableSessionCookie,
  signSsoState,
  verifySsoState,
  mintKapableSessionToken,
  verifyKapableSessionToken,
  KAPABLE_SSO_COOKIE,
  type KapableExchange,
  type KapableSessionAuthFn,
  type KapableSessionAuthOptions,
} from "./kapable-session-auth";

import { join } from "node:path";
import {
  accessKeyAuth,
  anyOf,
  SqliteStore,
  type AuthFn,
  type Store,
} from "@ffwd/api-client-server";
import { KapableDataStore } from "./kapable-data-store";
import { kapableSessionAuth } from "./kapable-session-auth";

/**
 * The host's store choice, Kapable flavour: KapableDataStore (durable across
 * deploys, write-through to the platform's data service) when KAPABLE_ORG_KEY
 * is set, SqliteStore (local-durable only) otherwise. Logs exactly one line
 * saying which it chose and why.
 */
export function storeFromEnv(opts?: { sqlitePath?: string }): Store {
  const orgKey = process.env.KAPABLE_ORG_KEY;
  const dataDir = process.env.DATA_DIR ?? "./data";
  const sqlitePath = opts?.sqlitePath ?? join(dataDir, "ffwd.sqlite");
  if (orgKey) {
    const apiBase = process.env.KAPABLE_API_BASE ?? "https://api.kapable.ai";
    const table = process.env.KAPABLE_TABLE ?? "ffwd_store";
    console.log(`using KapableDataStore (KAPABLE_ORG_KEY is set): writes go through to ${apiBase} table ${table}; data survives redeploys.`);
    return new KapableDataStore({ sqlitePath, orgKey, apiBase, table });
  }
  console.log("using SqliteStore (KAPABLE_ORG_KEY is not set): data is durable on this machine only and does not survive a platform redeploy. Set KAPABLE_ORG_KEY to enable the durable store.");
  return new SqliteStore(sqlitePath);
}

/**
 * The host's auth choice, Kapable flavour: kapableSessionAuth (Sign in with
 * Kapable, with the access key as a fallback through anyOf) when the four SSO
 * variables are all set, accessKeyAuth alone otherwise.
 */
export function authFromEnv(opts: { masterKey: string; key?: string }): AuthFn {
  const { KAPABLE_AUTH_URL, KAPABLE_APP_SLUG, APP_SSO_SECRET, PUBLIC_URL } = process.env;
  const key = opts.key ?? process.env.APP_ACCESS_KEY ?? "";
  const keyAuth = accessKeyAuth({ key, masterKey: opts.masterKey });
  if (KAPABLE_AUTH_URL && KAPABLE_APP_SLUG && APP_SSO_SECRET && PUBLIC_URL) {
    console.log(
      "[auth] using Sign in with Kapable (SSO env set: KAPABLE_AUTH_URL, KAPABLE_APP_SLUG, APP_SSO_SECRET, PUBLIC_URL); the access key still works as a fallback."
    );
    return anyOf([
      kapableSessionAuth({
        authBase: KAPABLE_AUTH_URL,
        appSlug: KAPABLE_APP_SLUG,
        appSecret: APP_SSO_SECRET,
        publicUrl: PUBLIC_URL,
        masterKey: opts.masterKey,
      }),
      keyAuth,
    ]);
  }
  return keyAuth;
}
