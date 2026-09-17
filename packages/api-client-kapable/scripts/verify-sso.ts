// Live done-when driver: fake exchange endpoint + the SSO host from this
// package (scripts/sso-host.ts) with the SSO env set. Prints one line per
// step. Run: bun packages/api-client-kapable/scripts/verify-sso.ts
const GOOD_TOKEN = "live-good-token-0123456789abcdef";
const SECRET = "live-app-sso-secret";

const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === "/auth/sso/exchange" && req.method === "POST") {
      const body: any = await req.json().catch(() => ({}));
      if (body?.sso_token === GOOD_TOKEN && body?.app_secret === SECRET) {
        return Response.json({
          member_id: "mem_live", org_id: "org_live", email: "herman@example.com", name: "Herman",
          claims: { is_platform_staff: false, is_org_member: true, role: "owner" },
          session_ttl_seconds: 7200,
        });
      }
      return Response.json({ error: { code: "invalid" } }, { status: 401 });
    }
    return new Response("no", { status: 404 });
  },
});

const port = 3313;
// A previous crashed run leaves a zombie on this port: clear it first.
const lsof = Bun.spawnSync(["lsof", "-nP", "-iTCP:3313", "-sTCP:LISTEN", "-t"]);
const zombiePids = lsof.stdout.toString().trim().split("\n").filter(Boolean);
for (const pid of zombiePids) {
  try { process.kill(Number(pid)); } catch {}
}
if (zombiePids.length) await Bun.sleep(500);

const proc = Bun.spawn([process.execPath, import.meta.dir + "/sso-host.ts"], {
  env: {
    PATH: process.env.PATH,
    APP_ACCESS_KEY: "live-access-key-0123456789",
    SECRETS_MASTER_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
    KAPABLE_AUTH_URL: `http://127.0.0.1:${fake.port}/auth`,
    KAPABLE_APP_SLUG: "apiclient",
    APP_SSO_SECRET: SECRET,
    PUBLIC_URL: "http://localhost:3313",
    PORT: String(port),
    NODE_ENV: "test",
  },
  stdout: "pipe",
  stderr: "pipe",
});
const bootLog: string[] = [];
void (async () => { for await (const c of proc.stdout as any) bootLog.push(c.toString()); })();
void (async () => { for await (const c of proc.stderr as any) bootLog.push(c.toString()); })();

const base = `http://127.0.0.1:${port}`;
const steps: string[] = [];
try {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/sign-in`, { signal: AbortSignal.timeout(1000) }); await r.body?.cancel(); break; }
    catch { await Bun.sleep(200); }
  }

  const home = await fetch(`${base}/`, { redirect: "manual" });
  steps.push(`GET / (unauthenticated)     -> ${home.status} location=${home.headers.get("location")}`);
  const signInPage = await (await fetch(`${base}/sign-in`)).text();
  steps.push(`GET /sign-in                 -> SSO button present: ${signInPage.includes("Sign in with Kapable")}, access-key form present: ${signInPage.includes("Access key")}`);
  const start = await fetch(`${base}/auth/sso/start?dest=%2F`, { redirect: "manual" });
  const loc = start.headers.get("location")!;
  const startUrl = new URL(loc);
  const state = startUrl.searchParams.get("state")!;
  steps.push(`GET /auth/sso/start          -> ${start.status} to ${startUrl.host}${startUrl.pathname} app=${startUrl.searchParams.get("app")} return_to=${startUrl.searchParams.get("return_to")}`);
  // the platform would bounce back to the callback with the token + state
  const callback = await fetch(`${base}/auth/sso/callback?sso_token=${encodeURIComponent(GOOD_TOKEN)}&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  const setCookie = callback.headers.get("set-cookie");
  steps.push(`GET /auth/sso/callback       -> ${callback.status} location=${callback.headers.get("location")} cookie=${setCookie?.split(";")[0].split("=")[0]}=… Max-Age=${/Max-Age=(\d+)/.exec(setCookie ?? "")?.[1]} HttpOnly=${setCookie?.includes("HttpOnly")}`);
  const cookie = setCookie!.split(";")[0];
  const authedHome = await fetch(`${base}/`, { redirect: "manual", headers: { cookie } });
  const authedBody = await authedHome.text();
  steps.push(`GET / (with SSO cookie)      -> ${authedHome.status} signed in (page served: ${authedBody.length > 500})`);
  const stateApi = await fetch(`${base}/api/ffwd/state`, { headers: { cookie } });
  steps.push(`GET /api/ffwd/state     -> ${stateApi.status} ${await stateApi.text()}`);
  const badCb = await fetch(`${base}/auth/sso/callback?sso_token=replayed&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  steps.push(`replayed callback            -> ${badCb.status} ${(await badCb.json()).error.code}`);
  const unauthApi = await fetch(`${base}/api/ffwd/state`);
  const unauthData = await unauthApi.json();
  steps.push(`unauthenticated API 401      -> details.sign_in_url=${unauthData.error.details.sign_in_url}`);
} finally {
  proc.kill();
  fake.stop(true);
  console.log(steps.join("\n"));
  console.log("--- server boot log ---");
  console.log(bootLog.join("").split("\n").filter((l) => l.includes("[auth]")).join("\n"));
}
export {};
