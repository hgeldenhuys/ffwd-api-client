import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { apiFetch, freePort, signIn, startServer, type ServerHandle } from "./test/helpers";

let server: ServerHandle;
let cookie: string;
const SECRET_VALUE = "injected-secret-token-424242";

beforeAll(async () => {
  server = await startServer({ allowPrivate: true });
  cookie = await signIn(server.port);
});

afterAll(() => {
  server?.stop();
});

async function importFixture(kind: "collection" | "environment", file: string, mutate?: (json: any) => void): Promise<any> {
  const json = JSON.parse(await Bun.file(file).text());
  mutate?.(json);
  const res = await apiFetch(server.port, cookie, "/api/ffwd/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, json }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe("send integration (allow-private, echo target)", () => {
  let collectionId: string;
  let environmentId: string;

  test("import collection and environment", async () => {
    const col = await importFixture("collection", "./fixtures/sample.postman_collection.json");
    expect(col.id).toBeTruthy();
    expect(col.moved.length).toBe(1);
    collectionId = col.id;
    const env = await importFixture("environment", "./fixtures/sample.postman_environment.json", (json) => {
      const token = json.values.find((v: any) => v.key === "token");
      token.value = SECRET_VALUE; // simulate a real environment carrying a secret
      // send to THIS app's echo, not the fixture's default :3000
      json.values.find((v: any) => v.key === "baseUrl").value = `http://127.0.0.1:${server.port}/api/ffwd`;
    });
    environmentId = env.id;
  });

  test("set the token secret via PUT, then send to the app's own echo and see it hidden", async () => {
    const put = await apiFetch(server.port, cookie, `/api/ffwd/secrets/environment/${environmentId}/token`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: SECRET_VALUE }),
    });
    expect(put.status).toBe(204);

    // the send targets this app's own /api/_echo (loopback allowed by the override);
    // x-echo-key authenticates the upstream hop like a real API key would.
    const res = await apiFetch(server.port, cookie, "/api/ffwd/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collectionId, environmentId, itemPath: "Auth'd/Get me" }),
    });
    const data = await res.json();
    expect(data.error).toBeUndefined();

    // resolved preview hides the secret but resolves ordinary variables
    expect(data.resolvedRequestHidden.url).not.toContain("{{baseUrl}}");
    expect(data.resolvedRequestHidden.url).not.toContain(SECRET_VALUE);
    expect(data.resolvedRequestHidden.headers["Authorization"]).toBe(`Bearer ••••••{{token}}`);

    // the echo saw the real bearer token; the response carries it hidden
    expect(data.status).toBe(200);
    expect(data.body).not.toContain(SECRET_VALUE);
    // the echo body reflects the header it received, but the hiding pass has
    // already replaced every occurrence — the browser can never see the value.
    const echoed = JSON.parse(data.body);
    expect(echoed.headers["authorization"]).toBe(`Bearer ••••••{{token}}`);
    expect(JSON.stringify(data).includes(SECRET_VALUE)).toBe(false);
  });

  test("a raw secret sent in a header is hidden in the response too", async () => {
    const res = await apiFetch(server.port, cookie, "/api/ffwd/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collectionId, environmentId, itemPath: "Auth'd/Post raw" }),
    });
    const data = await res.json();
    expect(data.error).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(SECRET_VALUE);
  });

  test("history stores the unresolved request and environment id", async () => {
    const hist = await (await apiFetch(server.port, cookie, "/api/ffwd/history?limit=200")).json();
    expect(hist.length).toBeGreaterThanOrEqual(2);
    for (const row of hist) {
      expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);
      // history row: request = {collectionId, itemPath, request: <item node>, name};
      // the unresolved HTTP request sits at request.request.request
      const raw = row.request?.request?.request?.url;
      expect(typeof raw === "string" ? raw : raw?.raw).toContain("{{baseUrl}}"); // unresolved
    }
  });

  test("export contains no secret value", async () => {
    const envJson = await (await apiFetch(server.port, cookie, `/api/ffwd/export/environment/${environmentId}`)).text();
    expect(envJson).not.toContain(SECRET_VALUE);
    const colJson = await (await apiFetch(server.port, cookie, `/api/ffwd/export/collection/${collectionId}`)).text();
    expect(colJson).not.toContain("literal-folder-apikey-value-42");
  });
});

describe("proxy policy on the live send path", () => {
  test("without the override, a loopback target is denied", async () => {
    const strict = await startServer({ allowPrivate: false });
    try {
      const c = await signIn(strict.port);
      const colImport = await (await apiFetch(strict.port, c, "/api/ffwd/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "collection", json: JSON.parse(await Bun.file("./fixtures/sample.postman_collection.json").text()) }),
      })).json();
      const envImport = await (await apiFetch(strict.port, c, "/api/ffwd/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "environment",
          json: {
            name: "local",
            values: [{ key: "baseUrl", value: `http://127.0.0.1:${strict.port}/api/ffwd`, enabled: true }],
          },
        }),
      })).json();
      const res = await apiFetch(strict.port, c, "/api/ffwd/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collectionId: colImport.id, environmentId: envImport.id, itemPath: "Auth'd/Get me" }),
      });
      const data = await res.json();
      expect(data.error?.code).toBe("private_target");
      expect(data.error.message).toMatch(/ALLOW_PRIVATE_TARGETS/);
    } finally {
      strict.stop();
    }
  });

  test("a decimal IP literal is refused by the send path", async () => {
    const col = await (await apiFetch(server.port, cookie, "/api/ffwd/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "collection",
        json: {
          info: { name: "lit", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
          item: [{ name: "Dec", request: { method: "GET", url: { raw: "http://2130706433/" } } }],
        },
      }),
    })).json();
    const res = await apiFetch(server.port, cookie, "/api/ffwd/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collectionId: col.id, itemPath: "Dec" }),
    });
    const data = await res.json();
    expect(data.error?.code).toBe("ip_literal");
    expect(data.error.message).toMatch(/decimal/);
  });
});

describe("IP pinning support probe", () => {
  test("probe records whether Bun can pin the IP with a separate TLS name", async () => {
    // proven against https://example.com per the brief; the answer is reported,
    // never guessed. This test documents the fact; offline it reports "no".
    const { pinnedFetchSupport } = await import("@ffwd/api-client-server");
    const answer = await pinnedFetchSupport();
    expect(["yes", "no"]).toContain(answer);
    console.log(`[send.integration] IP pinning support: ${answer}`);
  });
});
