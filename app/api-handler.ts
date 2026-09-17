import { accessKeyAuth, createApiClientHandler, getEnv, type AuthFn } from "@ffwd/api-client-server";
import { getSharedStore } from "./store";

/**
 * The reference host's ONE handler instance, built once. The auth is the
 * shared access key; the core package ships no SSO.
 */

let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;
let auth: AuthFn | null = null;

export function hostAuth(): AuthFn {
  if (auth) return auth;
  const { accessKey, masterKey } = getEnv();
  console.log("[auth] using the shared access key gate.");
  auth = accessKeyAuth({
    key: accessKey,
    masterKey: Buffer.from(masterKey).toString("base64"),
  });
  return auth;
}

export function getApiClientHandler(): Promise<(req: Request) => Promise<Response>> {
  if (!handlerPromise) {
    const { masterKey } = getEnv();
    handlerPromise = (async () =>
      createApiClientHandler({
        store: await getSharedStore(),
        masterKey: Buffer.from(masterKey).toString("base64"),
        basePath: "/api/ffwd",
        auth: hostAuth(),
      }))();
  }
  return handlerPromise;
}
