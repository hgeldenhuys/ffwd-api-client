import { beforeAll, describe, expect, test } from "bun:test";
import { importCollection, importEnvironment } from "@ffwd/api-client-server";

const collectionFixtureJson: any = await Bun.file("./fixtures/sample.postman_collection.json").json();
const collectionFixture = () => structuredClone(collectionFixtureJson);
const envFixtureJson: any = await Bun.file("./fixtures/sample.postman_environment.json").json();
const envFixture = () => structuredClone(envFixtureJson);

describe("collection import", () => {
  test("folder-level apikey literal moves to a collection-scope secret and is replaced", () => {
    const col = collectionFixture();
    const { json, report, secrets } = importCollection(col, "sample");
    expect(secrets).toHaveLength(1);
    expect(secrets[0].name).toBe("sample_misc_apikey");
    expect(secrets[0].value).toBe("literal-folder-apikey-value-42");
    const folder = json.item.find((i: any) => i.name === "Misc");
    const param = folder.auth.apikey.find((p: any) => p.key === "value");
    expect(param.value).toBe("{{sample_misc_apikey}}");
    expect(report.movedSecrets[0].scope).toBe("collection");
  });
  test("literal values in auth-looking HEADERS are only warned about", () => {
    const col = collectionFixture();
    const { json, report, secrets } = importCollection(col, "sample");
    expect(secrets).toHaveLength(1); // only the folder auth literal moved
    const req = json.item.find((i: any) => i.name === "Misc").item.find((r: any) => r.name === "Literal header");
    expect(req.request.header.find((h: any) => h.key === "X-API-Key").value).toBe("literal-header-value-xyz"); // untouched
    expect(report.warnings.some((w: string) => w.includes("X-API-Key") && w.includes("Literal header"))).toBe(true);
  });
  test("already-variable auth values ({{token}}) are left alone", () => {
    const col = collectionFixture();
    const { report, secrets } = importCollection(col, "sample");
    expect(secrets.every((s: any) => s.name !== "token")).toBe(true);
    expect(report.movedSecrets).toHaveLength(1);
  });
});

describe("environment import", () => {
  test("type:secret entries move to the store and the JSON keeps a blank value", () => {
    const env = envFixture();
    env.values.find((v: any) => v.key === "password").value = "injected-secret-value-99";
    const { json, secrets } = importEnvironment(env);
    expect(secrets).toEqual([{ name: "password", value: "injected-secret-value-99" }]);
    const row = json.values.find((v: any) => v.key === "password");
    expect(row.value).toBe("");
    expect(row.type).toBe("secret");
    const plain = json.values.find((v: any) => v.key === "baseUrl");
    expect(plain.value).toBe("http://localhost:3000"); // untouched
  });
});

describe("export round trip", () => {
  test("import → stored JSON → export deep-equals the fixture except moved/blanked secrets", () => {
    const col = collectionFixture();
    const imported = importCollection(col, "sample");
    const exported = imported.json; // what /api/export serves (stored JSON)
    const expected = collectionFixture();
    // apply exactly the transformations import is allowed to make:
    const folder = expected.item.find((i: any) => i.name === "Misc");
    folder.auth.apikey.find((p: any) => p.key === "value").value = "{{sample_misc_apikey}}";
    expect(exported).toEqual(expected);
    expect(JSON.stringify(exported)).not.toContain("literal-folder-apikey-value-42");
  });
  test("exported environment carries no secret value", () => {
    const env = envFixture();
    env.values.find((v: any) => v.key === "password").value = "injected-secret-value-99";
    const imported = importEnvironment(env);
    expect(JSON.stringify(imported.json)).not.toContain("injected-secret-value-99");
    const expected = envFixture();
    expected.values.find((v: any) => v.key === "password").value = ""; // import blanked it
    expect(imported.json).toEqual(expected);
  });
});
