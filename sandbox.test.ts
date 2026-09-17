import { afterAll, describe, expect, test } from "bun:test";
import { scriptSandbox, MEMORY_LIMIT_BYTES } from "@ffwd/api-client-server";

/**
 * The QuickJS sandbox itself: bridge round trip, budgets, host-global
 * containment, console caps, and handle hygiene (a leaked handle aborts the
 * whole WASM heap at runtime dispose — 500 throwing scripts must leave the
 * worker alive, not dead).
 */

function job(overrides: { state?: any; scripts: { name: string; code: string }[]; memoryLimitBytes?: number; timeLimitMs?: number }): Promise<any> {
  const state = {
    trusted: true,
    requestName: "A",
    eventName: "prerequest",
    collectionId: "c1",
    environmentId: null,
    envName: null,
    request: { method: "GET", url: "http://example.test/", headers: [], body: null, bodyMode: null, authType: null },
    vars: { collection: { alpha: "1" }, environment: null },
    plainNames: { collection: ["alpha"], environment: null },
    secrets: [{ name: "token", scope: "collection", value: "tok-secret-value-9" }],
    secretNamesAll: ["token"],
    response: null,
    writesAlready: 0,
  };
  return scriptSandbox().run({
    stateJson: JSON.stringify(overrides.state ?? state),
    scripts: overrides.scripts,
    memoryLimitBytes: overrides.memoryLimitBytes ?? MEMORY_LIMIT_BYTES,
    timeLimitMs: overrides.timeLimitMs ?? 2000,
  }) as Promise<any>;
}

afterAll(() => {
  scriptSandbox().dispose();
});

describe("sandbox", () => {
  test("bridge round trip: pm reads state, changes come back", async () => {
    const out = await job({
      scripts: [
        {
          name: "request",
          code: `
            console.log("alpha is", pm.collectionVariables.get("alpha"));
            pm.collectionVariables.set("beta", "2");
            pm.variables.set("local", "lv");
          `,
        },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.result.console).toEqual(["alpha is 1"]);
    expect(out.result.varOps).toEqual([{ kind: "var", scope: "collection", name: "beta", value: "2" }]);
  });

  test("an infinite loop is stopped by the interrupt handler", async () => {
    const out = await job({ scripts: [{ name: "request", code: `while(true){}` }], timeLimitMs: 300 });
    expect(out.ok).toBe(true);
    expect(out.error?.message).toMatch(/timed out/);
  });

  test("a memory bomb throws at the 64 MB cap", async () => {
    const out = await job({ scripts: [{ name: "request", code: `var a='x'; while(true) a=a+a;` }], timeLimitMs: 10_000 });
    expect(out.ok).toBe(true);
    expect(out.error?.message).toMatch(/out of memory|memory cap/);
  });

  test("host globals are absent inside the sandbox", async () => {
    const out = await job({
      scripts: [
        {
          name: "request",
          code: `console.log([typeof fetch, typeof Bun, typeof process, typeof require("crypto-js") !== "undefined"].join(","));`,
        },
      ],
    });
    expect(out.result.console[0]).toBe("undefined,undefined,undefined,true");
    // and require of anything else throws the named error
    const blocked = await job({ scripts: [{ name: "request", code: `require("fs");` }] });
    expect(blocked.error.message).toBe("module fs is not available in ffwd scripts");
  });

  test("console is capped: 200 lines, 64 KB, truncated marker", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 260; i++) lines.push(`console.log("line ${i}");`);
    const out = await job({ scripts: [{ name: "request", code: lines.join("\n") }] });
    expect(out.result.console.length).toBeLessThanOrEqual(201); // 200 lines + possible truncation note
    expect(out.result.truncated).toBe(true);

    const big: string[] = [];
    for (let i = 0; i < 40; i++) big.push(`console.log("${"x".repeat(4000)}");`);
    const out2 = await job({ scripts: [{ name: "request", code: big.join("\n") }] });
    const total = out2.result.console.reduce((n: number, l: string) => n + l.length, 0);
    expect(total).toBeLessThanOrEqual(64 * 1024);
    expect(out2.result.truncated).toBe(true);
  });

  test("handle hygiene: 500 throwing scripts leave the worker alive (no leak abort)", async () => {
    for (let round = 0; round < 10; round++) {
      const jobs: Promise<any>[] = [];
      for (let i = 0; i < 50; i++) {
        jobs.push(
          job({
            scripts: [
              { name: "request", code: `throw new Error("boom ${round}-${i}");` },
              { name: "request", code: `var x = { deep: { deeper: [1,2,3] } }; console.log(x); pm.variables.set("a", "b");` },
            ],
            timeLimitMs: 5000,
          })
        );
      }
      const results = await Promise.all(jobs);
      for (const r of results) {
        expect(r.ok).toBe(true);
        expect(r.error?.message ?? "").toContain("boom");
      }
    }
    // one more job proves the worker was not killed by a leak abort
    const alive = await job({ scripts: [{ name: "request", code: `console.log("alive");` }] });
    expect(alive.result.console).toEqual(["alive"]);
  });

  test("a function value and a cyclic object console.log safely", async () => {
    const out = await job({
      scripts: [
        {
          name: "request",
          code: `
            var cyc = {}; cyc.self = cyc;
            console.log(function named() {}, cyc);
          `,
        },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.result.console.length).toBe(1);
  });
});
