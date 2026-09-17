import { storeFromEnv, type Store } from "@ffwd/api-client-server";

/**
 * The reference host's ONE store instance, chosen once at boot via the core
 * package's `storeFromEnv()` (SQLite, local-durable only). A Store that
 * survives a redeploy is an adapter package away — see the root README's
 * Hosts section.
 */
let promise: Promise<Store> | null = null;

export function getSharedStore(): Promise<Store> {
  if (!promise) {
    promise = Promise.resolve(storeFromEnv());
  }
  return promise;
}
