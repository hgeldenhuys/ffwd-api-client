import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The Hono example host rendered a BLANK page on 2026-09-16: the dist bundle called
// React's development JSX runtime (`jsxDEV` from `react/jsx-dev-runtime`), which a
// production React build does not export. A curl of the page answered 200 the whole time.
// This test reads the built output, so run `bun run build` first; it fails loudly if dist
// is missing rather than passing by absence.
test("dist bundle uses the production JSX runtime", () => {
  const dist = join(import.meta.dir, "dist");
  expect(existsSync(dist)).toBe(true);
  const js = readdirSync(dist).filter((f) => f.endsWith(".js"));
  expect(js.length).toBeGreaterThan(0);
  for (const f of js) {
    const src = readFileSync(join(dist, f), "utf8");
    expect(src.includes("react/jsx-dev-runtime")).toBe(false);
    expect(src.includes("jsxDEV")).toBe(false);
  }
});
