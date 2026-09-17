import { describe, expect, test } from "bun:test";
import { hideBody, hideHeaders, hideSecrets, HIDE_MARK } from "@ffwd/api-client-server";

const SECRETS = [
  { name: "token", value: "super-secret-token-value" },
  { name: "apik", value: "another-secret-api-key" },
];

describe("hiding: encoded forms", () => {
  const value = "super-secret-token-value";
  const forms: [string, string][] = [
    ["raw", value],
    ["url-encoded", encodeURIComponent(value)],
    ["json-string-escaped", JSON.stringify(value).slice(1, -1)],
    ["base64", Buffer.from(value).toString("base64")],
    ["base64url", Buffer.from(value).toString("base64url")],
    ["hex-lower", Buffer.from(value).toString("hex")],
    ["hex-upper", Buffer.from(value).toString("hex").toUpperCase()],
    ["unicode-escaped", Array.from(value).map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("")],
  ];
  for (const [label, form] of forms) {
    test(`hides the ${label} form`, () => {
      const input = `before ${form} after`;
      const out = hideSecrets(input, SECRETS);
      expect(out.text).not.toContain(form);
      expect(out.text).toContain(`${HIDE_MARK}{{token}}`);
    });
  }
});

describe("hiding: response surfaces", () => {
  test("set-cookie", () => {
    const { headers } = hideHeaders(
      { "set-cookie": `sid=super-secret-token-value; Path=/; HttpOnly` },
      SECRETS
    );
    expect(headers["set-cookie"]).not.toContain("super-secret-token-value");
    expect(headers["set-cookie"]).toContain(`${HIDE_MARK}{{token}}`);
  });
  test("Location header", () => {
    const { headers } = hideHeaders(
      { location: "https://example.com/cb?tok=super-secret-token-value" },
      SECRETS
    );
    expect(headers.location).not.toContain("super-secret-token-value");
  });
  test("error messages that embed the resolved URL", () => {
    const out = hideSecrets(
      "fetch failed: unable to connect to https://example.com/aaa?tok=super-secret-token-value",
      SECRETS
    );
    expect(out.text).not.toContain("super-secret-token-value");
    expect(out.text).toContain(`${HIDE_MARK}{{token}}`);
  });
  test("base64 of the value inside a basic header", () => {
    const basic = "Basic " + Buffer.from("user:super-secret-token-value").toString("base64");
    const out = hideSecrets(basic, SECRETS);
    expect(out.text).not.toContain("super-secret-token-value");
  });
});

describe("hiding: warnings and binary", () => {
  test("a short secret substitutes but warns it cannot be hidden reliably", () => {
    const out = hideSecrets("x=abc12 y", [{ name: "tiny", value: "abc12" }]);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.warnings[0]).toMatch(/shorter than 8/);
  });
  test("a long secret produces no warning", () => {
    const out = hideSecrets("plain", SECRETS);
    expect(out.warnings).toHaveLength(0);
  });
  test("binary body is returned as base64 with hidden:false and a reason", () => {
    const out = hideBody(Buffer.from([0, 1, 2, 159]).toString("binary") /* pretend */, false, "application/octet-stream", SECRETS);
    expect(out.hidden).toBe(false);
    expect(out.body).toBeNull();
    expect(out.base64).not.toBeNull();
    expect(out.notHiddenReason).toMatch(/not text/i);
  });
});
