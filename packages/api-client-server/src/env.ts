/**
 * Startup environment validation. Imported by server.ts before anything runs,
 * so a missing variable stops the server with a message that names the
 * variable and the exact command that fixes it.
 */

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

let cached: { accessKey: string; masterKey: Uint8Array } | null = null;

// Read NODE_ENV through an alias: bundlers statically replace the literal
// `process.env.NODE_ENV` member expression, which would freeze this check to
// whatever the build machine's value was.
const env: Record<string, string | undefined> = process.env;

/** Validated environment; throws (does not exit) when imported outside the server entry. */
export function getEnv(): { accessKey: string; masterKey: Uint8Array } {
  if (cached) return cached;
  const accessKey = process.env.APP_ACCESS_KEY;
  if (!accessKey || accessKey.length < 8) {
    throw new Error(
      "APP_ACCESS_KEY is not set: this app guards stored secrets, so it refuses to start without an access key. Set it first, e.g. `export APP_ACCESS_KEY=\"$(openssl rand -base64 24)\"`."
    );
  }
  const masterB64 = process.env.SECRETS_MASTER_KEY;
  if (!masterB64) {
    throw new Error(
      "SECRETS_MASTER_KEY is not set: secret values are encrypted at rest with this key, so the server refuses to start without it. Generate one with `openssl rand -base64 32`, then `export SECRETS_MASTER_KEY=\"<the output>\"`."
    );
  }
  let master: Uint8Array;
  try {
    master = Uint8Array.from(Buffer.from(masterB64, "base64"));
  } catch {
    throw new Error(
      "SECRETS_MASTER_KEY is not valid base64: the key must be 32 bytes, base64-encoded. Generate a fresh one with `openssl rand -base64 32`."
    );
  }
  if (master.length !== 32) {
    throw new Error(
      `SECRETS_MASTER_KEY must decode to exactly 32 bytes (got ${master.length}): regenerate it with \`openssl rand -base64 32\`.`
    );
  }
  cached = { accessKey, masterKey: master };
  return cached;
}

export function loadEnv() {
  return getEnv();
}

export function assertNotProductionOverride(): { ok: boolean; message?: string } {
  if (process.env.ALLOW_PRIVATE_TARGETS === "1") {
    if (env.NODE_ENV === "production") {
      return {
        ok: false,
        message:
          "ALLOW_PRIVATE_TARGETS=1 is ignored: private targets are not allowed in production. The variable is refused when NODE_ENV=production.",
      };
    }
    console.warn(
      "[proxy-policy] ALLOW_PRIVATE_TARGETS=1 — private/loopback targets are allowed because NODE_ENV is not production. Do not use this outside local development."
    );
  }
  return { ok: true };
}
