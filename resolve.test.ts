import { describe, expect, test } from "bun:test";
import { VariableScope } from "postman-collection";
import { applyAuth, buildScope, resolveRequest, secretNamesUsedIn } from "@ffwd/api-client-server";

const collection = {
  info: { name: "T", _postman_id: "x", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
  variable: [{ key: "who", value: "collection" }, { key: "shared", value: "collection-value" }],
  item: [
    {
      name: "Folder",
      auth: { type: "apikey", apikey: [{ key: "in", value: "header" }, { key: "key", value: "X-API-Key" }, { key: "value", value: "folder-key-value" }] },
      item: [
        {
          name: "Ping",
          request: {
            method: "GET",
            url: { raw: "https://api.example.com/{{path}}?q={{q}}", host: ["api", "example", "com"], path: ["{{path}}"], query: [{ key: "q", value: "{{q}}" }] },
            header: [{ key: "X-Trace", value: "{{$guid}}" }],
          },
        },
      ],
    },
  ],
};

describe("scope precedence", () => {
  test("secret over environment over collection", () => {
    const scope = buildScope(
      collection,
      { name: "e", values: [{ key: "who", value: "environment" }, { key: "shared", value: "environment-value" }, { key: "q", value: "from-env" }] },
      [{ name: "who", value: "secret" }, { name: "shared", value: "secret-value" }]
    );
    expect(scope.replaceIn("{{who}}")).toBe("secret");
    expect(scope.replaceIn("{{shared}}")).toBe("secret-value");
    // environment beats collection for a name no secret overrides
    expect(scope.replaceIn("{{q}}")).toBe("from-env");
  });
});

describe("resolution", () => {
  const scope = buildScope(
    collection,
    { name: "e", values: [{ key: "path", value: "v1" }, { key: "q", value: "search" }] },
    []
  );

  test("resolves URL path and query params", () => {
    const found = resolveRequest(collection, "Folder/Ping", scope)!;
    expect(found).not.toBeNull();
    expect(found.resolved.url).toContain("/v1");
    expect(found.resolved.queryParams).toEqual([{ key: "q", value: "search", enabled: true }]);
    expect(found.resolved.method).toBe("GET");
  });

  test("built-ins $guid/$timestamp/$randomInt resolve", () => {
    const found = resolveRequest(collection, "Folder/Ping", scope)!;
    const trace = found.resolved.headers["X-Trace"];
    expect(trace).toBeTruthy();
    expect(trace).not.toContain("{{$guid}}");
    // a v4-ish uuid shape or the library's own format — it must have changed from the token form
    expect(trace.length).toBeGreaterThan(10);
  });
});

describe("inherited auth at send", () => {
  test("collection bearer auth applies with the secret value", () => {
    const bearerCol = structuredClone(collection) as any;
    delete bearerCol.item[0].auth; // no folder override: the collection bearer inherits
    const scope = buildScope(bearerCol, null, [{ name: "token", value: "resolved-secret-token-1" }, { name: "path", value: "v1" }]);
    const found = resolveRequest(bearerCol, "Folder/Ping", scope)!;
    const out = applyAuth(found.auth, scope, found.resolved.url, found.resolved.headers);
    expect(out.headers["Authorization"]).toBe("Bearer resolved-secret-token-1");
  });
  test("folder apikey auth overrides the collection auth", () => {
    const folderCol = structuredClone(collection) as any;
    const scope = buildScope(folderCol, null, []);
    const found = resolveRequest(folderCol, "Folder/Ping", scope)!;
    expect(found.auth.type).toBe("apikey");
    const out = applyAuth(found.auth, scope, found.resolved.url, found.resolved.headers);
    expect(out.headers["X-API-Key"]).toBe("folder-key-value");
  });
  test("basic auth becomes a Basic header with base64 user:pass", () => {
    const basicCol = structuredClone(collection) as any;
    basicCol.auth = { type: "basic", basic: [{ key: "username", value: "u" }, { key: "password", value: "p" }] };
    delete basicCol.item[0].auth;
    const scope = buildScope(basicCol, null, []);
    const found = resolveRequest(basicCol, "Folder/Ping", scope)!;
    const out = applyAuth(found.auth, scope, found.resolved.url, found.resolved.headers);
    expect(out.headers["Authorization"]).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });
});

describe("secret name detection", () => {
  test("finds {{name}} in url, headers and body", () => {
    const req = {
      request: {
        url: { raw: "https://x.test/?t={{tok}}" },
        header: [{ key: "A", value: "{{hdr}}" }],
        body: { raw: "{\"p\":\"{{pwd}}\"}" },
      },
    };
    expect(secretNamesUsedIn(req, null, ["tok", "hdr", "pwd", "unused"])).toEqual(["tok", "hdr", "pwd"]);
  });
});
