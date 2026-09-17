import { spawn, type Subprocess } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_ACCESS_KEY = "test-access-key-0123456789";
export const TEST_MASTER_KEY = Buffer.from(new Uint8Array(32).map((_, i) => (i * 7 + 11) % 256)).toString("base64");

export function freePort(): number {
  // bind port 0, read the assigned port, close
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "ffwd-test-"));
}

export interface ServerHandle {
  proc: Subprocess;
  port: number;
  stop: () => void;
}

export async function ensureBuild() {
  const exists = await Bun.file("./build/server/index.js").exists();
  if (!exists) {
    const proc = spawn(["bun", "run", "build"], { stdout: "pipe", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`bun run build failed with exit ${code}`);
  }
}

export async function startServer(opts: {
  port?: number;
  allowPrivate?: boolean;
  env?: Record<string, string | undefined>;
}): Promise<ServerHandle> {
  await ensureBuild();
  const port = opts.port ?? freePort();
  const dataDir = tempDataDir();
  const env: Record<string, string> = {
    APP_ACCESS_KEY: TEST_ACCESS_KEY,
    SECRETS_MASTER_KEY: TEST_MASTER_KEY,
    DATA_DIR: dataDir,
    PORT: String(port),
    NODE_ENV: "test",
    ...(opts.env as any),
  };
  if (opts.allowPrivate) env.ALLOW_PRIVATE_TARGETS = "1";
  else delete env.ALLOW_PRIVATE_TARGETS;
  const proc = spawn([process.execPath, "./server.ts"], { env, stdout: "pipe", stderr: "pipe" });
  // wait until it answers
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sign-in`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      await res.body?.cancel();
      break;
    } catch {
      if (Date.now() > deadline) {
        const err = await new Response(proc.stderr).text();
        proc.kill();
        throw new Error(`server did not start on :${port}\n${err}`);
      }
      await Bun.sleep(200);
    }
  }
  return {
    proc,
    port,
    stop: () => proc.kill(),
  };
}

export async function signIn(port: number, key = TEST_ACCESS_KEY): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (res.status !== 204) throw new Error(`sign-in failed with ${res.status}`);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  return cookie;
}

export function apiFetch(port: number, cookie: string, path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), cookie } as Record<string, string>,
  });
}
