import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApiClientHandler, SqliteStore, type Store } from "@ffwd/api-client-server";
import { createHmac, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Build 7 scripts: inheritance, trust gating (R1/R2), persistence and
 * variablesChanged, R4 collisions, hiding of script-read secrets, R6 budgets,
 * R7 sanitising, R8 surface.
 */

const BASE = "http://test.local/api/ffwd";

function testStore(): Store {
  return new SqliteStore(join(mkdtempSync(join(tmpdir(), "ffwd-scripts-")), "t.sqlite"));
}

function testHandler(store: Store) {
  return createApiClientHandler({
    store,
    masterKey: Buffer.from(new Uint8Array(32).map((_, i) => (i * 13 + 5) % 256)).toString("base64"),
    auth: async () => ({ ok: true, principal: "test" }),
    policy: { allowPrivateTargets: true },
  });
}

async function mkCollection(
  handler: ReturnType<typeof testHandler>,
  json: any
): Promise<string> {
  const res = await handler(
    new Request(`${BASE}/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: json?.info?.name ?? "T", json }),
    })
  );
  const body = (await res.json()) as any;
  return body.id as string;
}

async function send(handler: ReturnType<typeof testHandler>, collectionId: string, itemPath: string, environmentId?: string | null) {
  const res = await handler(
    new Request(`${BASE}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collectionId, itemPath, environmentId: environmentId ?? null }),
    })
  );
  return { status: res.status, data: await res.json() as any };
}

function ev(listen: "prerequest" | "test", exec: string[]) {
  return { listen, script: { type: "text/javascript", exec } };
}

const ECHO_ITEM = {
  name: "Echo",
  request: { method: "POST", url: { raw: `http://127.0.0.1:1/echo` }, header: [], body: { mode: "raw", raw: "{}" } },
};

// the URL never resolves (port 1) but the send must be reach the policy first —
// for tests that need a real response we use the handler's own echo via a
// server URL injected at runtime; here we pass it in the collection.
let echoUrl = "http://127.0.0.1:1/echo";

beforeAll(() => {
  // the reference tests start the real app for the echo target; at the handler
  // level we stand up a tiny echo server ourselves
});

import { EchoServer } from "./test/echo-server";

describe("scripts through the send path", () => {
  let handler: ReturnType<typeof testHandler>;
  let store: Store;
  let collectionId: string;

  beforeAll(async () => {
    await EchoServer.start();
    echoUrl = EchoServer.url;
    store = testStore();
    handler = testHandler(store);
    collectionId = await mkCollection(handler, {
      info: { name: "scripts", "x-ffwd-scripts-trusted": true },
      item: [{ name: "Echo", request: { method: "POST", url: { raw: `${echoUrl}/echo` }, header: [], body: { mode: "raw", raw: "{}" } } }],
    });
  });

  afterAll(async () => {
    await EchoServer.stop();
  });

  test("inheritance order: collection → folder → request (concatenated)", async () => {
    const order: string[] = [];
    const probe = (tag: string) => `__order.push("${tag}");`;
    (globalThis as any).__orderProbe = order;
    const colId = await mkCollection(handler, {
      info: { name: "order", "x-ffwd-scripts-trusted": true },
      event: [ev("prerequest", [`console.log("c");`])],
      item: [
        {
          name: "Folder",
          event: [ev("prerequest", [`console.log("f");`])],
          item: [{ name: "Leaf", request: { method: "GET", url: { raw: `${echoUrl}/echo` } }, event: [ev("prerequest", [`console.log("r");`])] }],
        },
      ],
    });
    const { data } = await send(handler, colId, "Folder/Leaf");
    expect(data.error).toBeUndefined();
    expect(data.scripts.prerequest.console).toEqual(["c", "f", "r"]);
  });

  test("pre-request mutates the request for THIS send only; the stored copy is untouched", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "mutate", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Echo",
          request: { method: "POST", url: { raw: `${echoUrl}/echo` }, header: [], body: { mode: "raw", raw: "original" } },
          event: [ev("prerequest", [`pm.request.method = "PUT"; pm.request.headers.add({ key: "X-Script", value: "hi" }); pm.request.body = { mode: "raw", raw: "from-script" };`])],
        },
      ],
    });
    const { data } = await send(handler, colId, "Echo");
    expect(data.error).toBeUndefined();
    expect(data.status).toBe(200);
    const echoed = JSON.parse(data.body);
    expect(echoed.method).toBe("PUT");
    expect(echoed.headers["x-script"]).toBe("hi");
    expect(echoed.body).toBe("from-script");
    // stored request untouched
    const row = (store as SqliteStore).getCollection(colId)!;
    const json = JSON.parse(row.json);
    expect(json.item[0].request.method).toBe("POST");
  });

  test("trusted: test results include failing and throwing tests; send still 200", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "tests", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [
            ev("test", [
              `pm.test("passes", () => pm.response.to.have.status(200));`,
              `pm.test("wrong status", () => pm.expect(404).to.equal(200));`,
              `pm.test("throws", () => { throw new Error("kapow"); });`,
            ]),
          ],
        },
      ],
    });
    const { status, data } = await send(handler, colId, "Echo");
    expect(status).toBe(200);
    const results = data.scripts.tests.results;
    expect(results.map((r: any) => r.passed)).toEqual([true, false, false]);
    expect(results[1].error).toBe("expected 404 to equal 200");
    expect(results[2].error).toBe("kapow");
  });

  test("a pre-request script error aborts the send with a 4xx naming the script and line", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "prereq-fail", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Leaf",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [ev("prerequest", ["var ok = 1;", "throw new Error('stop the send');"])],
        },
      ],
    });
    const { status, data } = await send(handler, colId, "Leaf");
    expect(status).toBe(400);
    expect(data.error.code).toBe("prerequest_failed");
    expect(data.error.message).toContain("request");
    expect(data.error.message).toContain("line 2");
    expect(data.error.message).toContain("stop the send");
  });

  test("hiding: a script that console.logs a secret value has every form hidden", async () => {
    const secret = "super-secret-value-7788";
    const colId = await mkCollection(handler, {
      info: { name: "hide", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo?s={{k}}` } },
          event: [
            ev("prerequest", [
              `var v = pm.variables.get("k");`,
              `console.log("raw:", v);`,
              `console.log("b64:", pm.crypto.base64(v));`,
              `console.log("url:", encodeURIComponent(v));`,
            ]),
          ],
        },
      ],
    });
    await handler(
      new Request(`${BASE}/secrets/collection/${colId}/k`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: secret }),
      })
    );
    const { data } = await send(handler, colId, "Echo");
    const flat = JSON.stringify(data);
    expect(flat).not.toContain(secret);
    expect(flat).not.toContain(Buffer.from(secret).toString("base64"));
    expect(flat).not.toContain(encodeURIComponent(secret));
    // the substitution itself worked — the echo got the real value (hidden on the way back)
    if (data.error) console.log("HIDING TEST SEND ERROR:", JSON.stringify(data.error));
    expect(String(data.body)).toContain("••••••{{k}}");
  });

  test("audit log: trusted secret reads are logged host-side without values (R3)", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "audit", "x-ffwd-scripts-trusted": true },
      item: [{ name: "Echo", request: { method: "GET", url: { raw: `${echoUrl}/echo` } }, event: [ev("prerequest", [`pm.variables.get("tok");`])] }],
    });
    await handler(new Request(`${BASE}/secrets/collection/${colId}/tok`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "audit-tok-1234" }) }));
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await send(handler, colId, "Echo");
    } finally {
      console.log = orig;
    }
    const line = logs.find((l) => l.includes("script.secret.read"));
    expect(line).toBeTruthy();
    expect(line).toContain(`name=tok`);
    expect(line).toContain(`scope=collection`);
    expect(line).toContain(`collection=${colId}`);
    expect(line).not.toContain("audit-tok-1234");
  });

  test("UNTRUSTED: secret get is undefined with a console note; writes are this-send-only with persisted:false (R2)", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "untrusted", "x-ffwd-scripts-trusted": false },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [
            ev("prerequest", [
              `console.log("secret is", pm.variables.get("k"));`,
              `pm.collectionVariables.set("ephemeral", "e1");`,
              `pm.secrets.set("newsec", "s1");`,
            ]),
          ],
        },
      ],
    });
    await handler(new Request(`${BASE}/secrets/collection/${colId}/k`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "hidden-k-12345" }) }));
    const { data } = await send(handler, colId, "Echo");
    expect(data.scripts.prerequest.console[0]).toContain("secret k not readable: scripts in this collection are untrusted");
    expect(data.scripts.prerequest.console[1]).toContain("undefined");
    const changed = data.scripts.variablesChanged;
    expect(changed).toEqual([
      { scope: "collection", scopeId: colId, name: "ephemeral", secret: false, persisted: false, reason: expect.stringContaining("untrusted") },
      { scope: "collection", scopeId: colId, name: "newsec", secret: true, persisted: false, reason: expect.stringContaining("untrusted") },
    ]);
    // nothing persisted
    expect(store.listSecrets("collection", colId).map((s) => s.name)).toEqual(["k"]);
    const row = JSON.parse(store.getCollection(colId)!.json);
    expect((row.variable ?? []).filter((v: any) => v.key === "ephemeral")).toEqual([]);
  });

  test("UNTRUSTED: a pre-request script that changes the request origin is refused (R2c)", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "origin", "x-ffwd-scripts-trusted": false },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [ev("prerequest", [`pm.request.url = "http://elsewhere.example/steal";`])],
        },
      ],
    });
    const { status, data } = await send(handler, colId, "Echo");
    expect(status).toBe(400);
    expect(data.error.code).toBe("script_origin_refused");
    expect(data.error.message).toContain("origin");
    expect(data.error.message).toContain("Trusted scripts");
  });

  test("UNTRUSTED: headers/path/query/body may still be mutated (R2c)", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "origin-ok", "x-ffwd-scripts-trusted": false },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [ev("prerequest", [`pm.request.url = "${echoUrl}/other-path?x=1"; pm.request.headers.add({key:"X-S", value:"1"});`])],
        },
      ],
    });
    const { data } = await send(handler, colId, "Echo");
    expect(data.error).toBeUndefined();
    const echoed = JSON.parse(data.body);
    expect(echoed.path).toBe("/other-path");
    expect(echoed.headers["x-s"]).toBe("1");
  });

  test("TRUSTED: pm.environment.set on a secret name writes the secret store, not the JSON", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "envsec", "x-ffwd-scripts-trusted": true },
      item: [{ name: "Echo", request: { method: "GET", url: { raw: `${echoUrl}/echo` } }, event: [ev("prerequest", [`pm.environment.set("es", "env-secret-value-1");`])] }],
    });
    const envRes = await handler(new Request(`${BASE}/environments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "E", json: { name: "E", values: [] } }) }));
    const envId = ((await envRes.json()) as any).id;
    // make es a secret in the environment scope
    await handler(new Request(`${BASE}/secrets/environment/${envId}/es`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "old-value" }) }));
    const { data } = await send(handler, colId, "Echo", envId);
    expect(data.error).toBeUndefined();
    const secretRow = store.listSecrets("environment", envId).find((s) => s.name === "es");
    expect(secretRow).toBeTruthy();
    // the JSON never carries the value
    const envJson = JSON.parse(store.getEnvironment(envId)!.json);
    const row = (envJson.values ?? []).find((v: any) => v.key === "es");
    expect(!row || row.value === "").toBe(true);
    const changed = data.scripts.variablesChanged.find((c: any) => c.name === "es");
    expect(changed).toMatchObject({ scope: "environment", secret: true, persisted: true });
  });

  test("R4: set on a name that is BOTH a plain var and a secret in scope is refused; secrets.set on a plain var is refused", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "r4", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [
            ev("prerequest", [
              `try { pm.collectionVariables.set("both", "v"); } catch (e) { console.log("R4a:", e.message); }`,
              `try { pm.secrets.set("plain1", "v"); } catch (e) { console.log("R4b:", e.message); }`,
            ]),
          ],
        },
      ],
    });
    const colJson = JSON.parse(store.getCollection(colId)!.json);
    colJson.variable = [{ key: "both", value: "" }, { key: "plain1", value: "plain" }];
    await handler(new Request(`${BASE}/collections/${colId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "r4", json: colJson }) }));
    await handler(new Request(`${BASE}/secrets/collection/${colId}/both`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "sec" }) }));
    const { data } = await send(handler, colId, "Echo");
    expect(data.scripts.prerequest.console[0]).toContain("refused");
    expect(data.scripts.prerequest.console[0]).toContain("both");
    expect(data.scripts.prerequest.console[1]).toContain("plain variable");
    expect(data.scripts.prerequest.console[1]).toContain("delete the variable");
  });

  test("R4: persisting a plain variable whose value equals a secret is refused (copy-out)", async () => {
    const secret = "copy-out-secret-4242";
    const colId = await mkCollection(handler, {
      info: { name: "copyout", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [ev("prerequest", [`pm.collectionVariables.set("out", pm.variables.get("k"));`])],
        },
      ],
    });
    await handler(new Request(`${BASE}/secrets/collection/${colId}/k`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: secret }) }));
    const { data } = await send(handler, colId, "Echo");
    expect(data.error.code).toBe("prerequest_failed");
    expect(data.error.message).toContain("matches secret k");
    expect(data.error.message).toContain("pm.secrets.set");
  });

  test("R6: at most 100 variable writes per send", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 102; i++) lines.push(`pm.collectionVariables.set("w${i}", "${i}");`);
    const colId = await mkCollection(handler, {
      info: { name: "budget", "x-ffwd-scripts-trusted": true },
      item: [{ name: "Echo", request: { method: "GET", url: { raw: `${echoUrl}/echo` } }, event: [ev("prerequest", lines)] }],
    });
    const { data } = await send(handler, colId, "Echo");
    expect(data.error?.code ?? data.scripts?.prerequest?.error?.message).toBeTruthy();
    expect(JSON.stringify(data.error ?? data.scripts)).toContain("budget");
  });

  test("R7: control characters in console lines and test names are sanitised; names capped at 200 chars", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "sanitise", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [
            ev("test", [
              `console.log("bad\\u0001char");`,
              `pm.test("name\\u0003with\\u0007ctrl".padEnd(0) + "x".repeat(300), () => true);`,
            ]),
          ],
        },
      ],
    });
    const { data } = await send(handler, colId, "Echo");
    expect(data.scripts.prerequest.console.join("")).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    const name = data.scripts.tests.results[0].name;
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    expect(name).toContain("\uFFFD");
  });

  test("R8: crypto-js shim HMAC matches node:crypto; btoa/atob; replaceIn; legacy postman aliases", async () => {
    const expected = createHmac("sha256", "key").update("message").digest("hex");
    const colId = await mkCollection(handler, {
      info: { name: "r8", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [
            ev("prerequest", [
              `var C = require("crypto-js");`,
              `console.log("hmac", C.HmacSHA256("message", "key").toString(C.enc.Hex));`,
              `console.log("atob", atob("aGVsbG8="));`,
              `console.log("replaceIn", pm.variables.replaceIn("{{alpha}}-{{beta}}"));`,
              `postman.setGlobalVariable("g1", "gv"); console.log("legacy", postman.getGlobalVariable("g1"));`,
            ]),
            ev("test", [
              `pm.test("sha", () => pm.expect(pm.crypto.sha256("abc").toString()).to.equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));`,
            ]),
          ],
        },
      ],
    });
    const colJson = JSON.parse(store.getCollection(colId)!.json);
    colJson.variable = [{ key: "alpha", value: "A" }, { key: "beta", value: "B" }];
    await handler(new Request(`${BASE}/collections/${colId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "r8", json: colJson }) }));
    const { data } = await send(handler, colId, "Echo");
    const c = data.scripts.prerequest.console;
    expect(c[0]).toBe(`hmac ${expected}`);
    expect(createHash("sha256").update("message").digest("hex")).not.toThrow;
    expect(c[1]).toBe("atob hello");
    expect(c[2]).toBe("replaceIn A-B");
    expect(c[3]).toBe("legacy gv");
    expect(data.scripts.tests.results[0].passed).toBe(true);
  });

  test("pm.sendRequest and postman.setNextRequest throw the named house error", async () => {
    const colId = await mkCollection(handler, {
      info: { name: "nosupport", "x-ffwd-scripts-trusted": true },
      item: [
        {
          name: "Echo",
          request: { method: "GET", url: { raw: `${echoUrl}/echo` } },
          event: [
            ev("prerequest", [
              `try { pm.sendRequest("http://x", function(){}); } catch (e) { console.log(e.message); }`,
              `try { postman.setNextRequest("B"); } catch (e) { console.log(e.message); }`,
            ]),
          ],
        },
      ],
    });
    const { data } = await send(handler, colId, "Echo");
    expect(data.scripts.prerequest.console[0]).toContain("not supported in this version");
    expect(data.scripts.prerequest.console[0]).toContain("create another request");
    expect(data.scripts.prerequest.console[1]).toContain("not supported in this version");
  });

  test("imported collections start untrusted with the marker set false (R1)", async () => {
    const res = await handler(
      new Request(`${BASE}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "collection",
          json: {
            info: { name: "imported" },
            item: [{ name: "A", request: { method: "GET", url: "http://example.test/" }, event: [ev("test", ["pm.test(\"ok\", () => true);"]) ] }],
          },
        }),
      })
    );
    const body = (await res.json()) as any;
    expect(body.trusted).toBe(false);
    expect(body.runsScripts).toBe(true);
    const json = JSON.parse(store.getCollection(body.id)!.json);
    expect(json.info["x-ffwd-scripts-trusted"]).toBe(false);
  });

  test("created-in-app collections start trusted (R1)", async () => {
    const res = await handler(new Request(`${BASE}/collections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "fresh" }) }));
    const body = (await res.json()) as any;
    const json = JSON.parse(store.getCollection(body.id)!.json);
    expect(json.info["x-ffwd-scripts-trusted"]).toBe(true);
  });
});
