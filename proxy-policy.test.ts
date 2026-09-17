import { describe, expect, test } from "bun:test";
import {
  PolicyError,
  checkUrlShape,
  hopRequest,
  isDeniedIp,
  isDottedQuad,
  nextRedirectUrl,
  parseIp,
  refuseNonCanonicalIpLiteral,
} from "@ffwd/api-client-server";
import { assertNotProductionOverride } from "@ffwd/api-client-server";

function denied(ip: string): boolean {
  return isDeniedIp(ip);
}

describe("deny ranges", () => {
  const deniedV4 = [
    "0.0.0.0", "0.1.2.3", "127.0.0.1", "127.255.0.9", "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "100.127.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  ];
  for (const ip of deniedV4) {
    test(`denies ${ip}`, () => expect(denied(ip)).toBe(true));
  }
  const allowedV4 = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "9.9.9.9"];
  for (const ip of allowedV4) {
    test(`allows ${ip}`, () => expect(denied(ip)).toBe(false));
  }

  const deniedV6 = ["::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"];
  for (const ip of deniedV6) {
    test(`denies ${ip}`, () => expect(denied(ip)).toBe(true));
  }
  const allowedV6 = ["2606:4700::1111", "2001:db8::1"];
  for (const ip of allowedV6) {
    test(`allows ${ip}`, () => expect(denied(ip)).toBe(false));
  }
});

describe("ip literal refusals", () => {
  test("dotted quads are fine", () => {
    expect(isDottedQuad("127.0.0.1")).toBe(true);
    expect(isDottedQuad("8.8.8.8")).toBe(true);
  });
  test("refuses decimal", () => {
    expect(refuseNonCanonicalIpLiteral("2130706433")).toMatch(/decimal/);
  });
  test("refuses hex", () => {
    expect(refuseNonCanonicalIpLiteral("0x7f000001")).toMatch(/hex or octal/);
  });
  test("refuses shortened", () => {
    expect(refuseNonCanonicalIpLiteral("127.1")).toMatch(/shortened/);
  });
  test("refuses octal", () => {
    expect(refuseNonCanonicalIpLiteral("0177.0.0.1")).toMatch(/octal/);
  });
  test("hostnames and dotted quads pass", () => {
    expect(refuseNonCanonicalIpLiteral("example.com")).toBeNull();
    expect(refuseNonCanonicalIpLiteral("127.0.0.1")).toBeNull();
  });
  test("checkUrlShape refuses schemes other than http/https", () => {
    expect(() => checkUrlShape("ftp://example.com")).toThrow(PolicyError);
    expect(() => checkUrlShape("file:///etc/passwd")).toThrow(PolicyError);
  });
});

describe("parseIp", () => {
  test("parses v4, v6 and v4-mapped", () => {
    expect(parseIp("1.2.3.4")?.family).toBe(4);
    expect(parseIp("::1")?.family).toBe(6);
    expect(parseIp("::ffff:127.0.0.1")?.family).toBe(6);
    expect(parseIp("not-an-ip")).toBeNull();
  });
});

// The dev override is tested at the env level: with NODE_ENV=production the
// override must be refused (logged and ignored).
describe("ALLOW_PRIVATE_TARGETS", () => {
  test("accepted outside production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const prevOverride = process.env.ALLOW_PRIVATE_TARGETS;
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    expect(assertNotProductionOverride().ok).toBe(true);
    process.env.NODE_ENV = prev;
    if (prevOverride === undefined) delete process.env.ALLOW_PRIVATE_TARGETS;
    else process.env.ALLOW_PRIVATE_TARGETS = prevOverride;
  });
  test("refused in production", () => {
    const prev = process.env.NODE_ENV;
    const prevOverride = process.env.ALLOW_PRIVATE_TARGETS;
    process.env.NODE_ENV = "production";
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    const r = assertNotProductionOverride();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ALLOW_PRIVATE_TARGETS/);
    process.env.NODE_ENV = prev;
    if (prevOverride === undefined) delete process.env.ALLOW_PRIVATE_TARGETS;
    else process.env.ALLOW_PRIVATE_TARGETS = prevOverride;
  });
});

describe("redirects", () => {
  const from = new URL("http://a.example/start");
  test("recognises redirect statuses", () => {
    for (const s of [301, 302, 303, 307, 308]) {
      expect(nextRedirectUrl(from, s, "https://b.example/next", 0)).not.toBeNull();
    }
    expect(nextRedirectUrl(from, 200, "https://b.example/next", 0)).toBeNull();
  });
  test("caps the hop budget", () => {
    expect(() => nextRedirectUrl(from, 302, "http://a.example/x", 5)).toThrow(/redirect/);
  });
  test("requires a Location header", () => {
    expect(() => nextRedirectUrl(from, 302, null, 0)).toThrow(/Location/);
  });

  test("strips Authorization and Cookie on a cross-origin hop", () => {
    const to = new URL("http://b.example/next");
    const headers = new Headers({
      authorization: "Bearer sekrit",
      cookie: "session=x",
      "content-type": "application/json",
      "x-custom": "keep",
    });
    const hop = hopRequest(headers, from, to, 302, "POST");
    expect(hop.headers.get("authorization")).toBeNull();
    expect(hop.headers.get("cookie")).toBeNull();
    expect(hop.headers.get("content-type")).toBe("application/json");
    expect(hop.headers.get("x-custom")).toBe("keep");
  });

  test("keeps Authorization on a same-origin hop", () => {
    const to = new URL("http://a.example/next");
    const headers = new Headers({ authorization: "Bearer sekrit", cookie: "app=own" });
    const hop = hopRequest(headers, from, to, 307, "POST");
    expect(hop.headers.get("authorization")).toBe("Bearer sekrit");
  });

  test("never carries any Cookie (the app session never rides along)", () => {
    const to = new URL("http://a.example/next");
    const headers = new Headers({ cookie: "ffwd_session=abc" });
    const hop = hopRequest(headers, from, to, 307, "GET");
    expect(hop.headers.get("cookie")).toBeNull();
  });

  test("303 turns POST into GET and drops the body", () => {
    const to = new URL("http://a.example/next");
    const hop = hopRequest(new Headers(), from, to, 303, "POST");
    expect(hop.method).toBe("GET");
    expect(hop.dropBody).toBe(true);
  });
  test("307 keeps the method", () => {
    const hop = hopRequest(new Headers(), from, new URL("http://a.example/next"), 307, "POST");
    expect(hop.method).toBe("POST");
  });
});

// Build 5: the production refusal must hold on the BUILT server. Boots it with
// NODE_ENV=production AND ALLOW_PRIVATE_TARGETS=1 set, signs in with the access
// key, and sends at a loopback target: the override must be ignored and the
// send refused by the policy.
describe("ALLOW_PRIVATE_TARGETS on the built server (NODE_ENV=production)", () => {
  test("a loopback send is refused even with the override set", async () => {
    const { ensureBuild, freePort, tempDataDir, TEST_ACCESS_KEY, TEST_MASTER_KEY } = await import("./test/helpers");
    await ensureBuild();
    const port = freePort();
    const proc = Bun.spawn([process.execPath, "./server.ts"], {
      env: {
        PATH: process.env.PATH,
        APP_ACCESS_KEY: TEST_ACCESS_KEY,
        SECRETS_MASTER_KEY: TEST_MASTER_KEY,
        NODE_ENV: "production",
        ALLOW_PRIVATE_TARGETS: "1",
        DATA_DIR: tempDataDir(),
        PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          const probe = await fetch(`http://127.0.0.1:${port}/api/session`, { method: "HEAD", signal: AbortSignal.timeout(2000) });
          await probe.body?.cancel();
          break;
        } catch {
          if (Date.now() > deadline) {
            const err = await new Response(proc.stderr).text();
            throw new Error(`server did not start on :${port}\n${err}`);
          }
          await Bun.sleep(200);
        }
      }

      const signIn = await fetch(`http://127.0.0.1:${port}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: TEST_ACCESS_KEY }),
      });
      expect(signIn.status).toBe(204);
      const cookie = signIn.headers.get("set-cookie")!.split(";")[0];

      const col = await (
        await fetch(`http://127.0.0.1:${port}/api/ffwd/import`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            kind: "collection",
            json: {
              info: { name: "loopback", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
              item: [{ name: "Local", request: { method: "GET", url: { raw: "http://127.0.0.1:9/" } } }],
            },
          }),
        })
      ).json();
      const res = await fetch(`http://127.0.0.1:${port}/api/ffwd/send`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ collectionId: col.id, itemPath: "Local" }),
      });
      const data = await res.json();
      expect(data.error?.code).toBe("private_target");
      expect(String(data.error?.message)).toMatch(/ALLOW_PRIVATE_TARGETS|private/i);
    } finally {
      proc.kill();
    }
  }, 60_000);
});
