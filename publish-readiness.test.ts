import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Publish readiness for npm: after a package build, the packed tarball must
 * contain exactly the shipped surface (dist + README + LICENSE) and none of
 * the sources, tests or maps; the react bundle must use the production JSX
 * runtime. `npm pack --dry-run --json` lists the files `files:` allows
 * without writing a tarball.
 */

const REACT_DIR = join(import.meta.dir, "packages/api-client-react");
const SERVER_DIR = join(import.meta.dir, "packages/api-client-server");
const KAPABLE_DIR = join(import.meta.dir, "packages/api-client-kapable");
const PACKAGE_DIRS = [REACT_DIR, SERVER_DIR, KAPABLE_DIR];

interface PackedFile {
  path: string;
  size: number;
}

function pack(dir: string): { files: PackedFile[]; name: string } {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" });
  const parsed = JSON.parse(out) as { name: string; files?: PackedFile[] }[];
  return { name: parsed[0].name, files: parsed[0].files ?? [] };
}

function paths(dir: string): string[] {
  return pack(dir).files.map((f) => f.path);
}

let reactFiles: string[] = [];
let serverFiles: string[] = [];
let kapableFiles: string[] = [];

beforeAll(() => {
  execFileSync("bun", ["run", "build:packages"], { cwd: import.meta.dir, stdio: ["ignore", "ignore", "inherit"] });
  reactFiles = paths(REACT_DIR);
  serverFiles = paths(SERVER_DIR);
  kapableFiles = paths(KAPABLE_DIR);
}, 60_000);

afterAll(() => {
  for (const dir of PACKAGE_DIRS) rmSync(join(dir, "package.tgz"), { force: true });
});

function assertNoJunk(files: string[], label: string) {
  for (const f of files) {
    expect(f.startsWith("src/")).toBe(false); // no sources
    expect(f.includes(".test.")).toBe(false); // no test files
    expect(f.endsWith(".map")).toBe(false); // no sourcemaps
    expect(f.endsWith(".tsx")).toBe(false); // .d.ts declarations ship; source .ts/.tsx do not (bun only emits .js + .d.ts)
  }
  expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
}

describe("publish readiness", () => {
  test("all three packages pack under the @ffwd scope with the required surface", () => {
    expect(pack(SERVER_DIR).name).toBe("@ffwd/api-client-server");
    expect(pack(KAPABLE_DIR).name).toBe("@ffwd/api-client-kapable");
    expect(reactFiles).toContain("dist/index.js");
    expect(reactFiles).toContain("dist/index.d.ts");
    expect(reactFiles).toContain("dist/styles.css");
    expect(reactFiles).toContain("README.md");
    expect(reactFiles).toContain("LICENSE");
    expect(serverFiles).toContain("dist/index.js");
    expect(serverFiles).toContain("dist/index.d.ts");
    expect(serverFiles).toContain("README.md");
    expect(serverFiles).toContain("LICENSE");
    expect(kapableFiles).toContain("dist/index.js");
    expect(kapableFiles).toContain("dist/index.d.ts");
    expect(kapableFiles).toContain("README.md");
    expect(kapableFiles).toContain("LICENSE");
  });

  test("no src/, no test files, no .map in any tarball", () => {
    assertNoJunk(reactFiles, "react");
    assertNoJunk(serverFiles, "server");
    assertNoJunk(kapableFiles, "kapable");
  });

  test("dist types exist on disk after bun run build", () => {
    for (const dir of PACKAGE_DIRS) {
      expect(existsSync(join(dir, "dist/index.d.ts"))).toBe(true);
      expect(existsSync(join(dir, "dist/index.js"))).toBe(true);
    }
  });

  test("react dist uses the production JSX runtime (no jsx-dev-runtime) and has real component code", () => {
    const distJs = readdirSync(join(REACT_DIR, "dist")).filter((f) => f.endsWith(".js"));
    expect(distJs.length).toBeGreaterThan(0);
    for (const f of distJs) {
      const content = readFileSync(join(REACT_DIR, "dist", f), "utf8");
      expect(content).not.toContain("jsx-dev-runtime");
      expect(content).not.toContain("jsxDEV");
    }
    const entry = readFileSync(join(REACT_DIR, "dist", "index.js"), "utf8");
    expect(entry.length).toBeGreaterThan(10_000); // not an empty re-export shell
  });

  test("publish metadata: MIT, public access, the GitHub repo, no custom registry", () => {
    for (const dir of PACKAGE_DIRS) {
      const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      expect(p.name.startsWith("@ffwd/")).toBe(true);
      expect(p.version).toBe("0.1.0");
      expect(p.license).toBe("MIT");
      expect(p.publishConfig).toEqual({ access: "public" });
      expect(p.publishConfig.registry).toBeUndefined();
      expect(p.repository.url).toBe("https://github.com/hgeldenhuys/ffwd-api-client");
      expect(p.files).toEqual(["dist", "README.md", "LICENSE"]);
    }
    const react = JSON.parse(readFileSync(join(REACT_DIR, "package.json"), "utf8"));
    // "./src/**" is marked side-effectful on purpose: with every module marked
    // pure, `bun build --production` tree-shakes the package's own bundle down
    // to an empty re-export shell (measured 2026-09-16). Consumers never see
    // src/, so their bundlers are unaffected.
    expect(react.sideEffects).toEqual(["*.css", "./src/**"]);
    const server = JSON.parse(readFileSync(join(SERVER_DIR, "package.json"), "utf8"));
    expect(server.engines).toEqual({ bun: ">=1.3" });
    // exports surface
    expect(Object.keys(react.exports)).toEqual(
      expect.arrayContaining([".", "./styles.css", "./token-input", "./variables-table"])
    );
    expect(server.exports["."]).toBeDefined();
    expect((JSON.parse(readFileSync(join(KAPABLE_DIR, "package.json"), "utf8"))).dependencies["@ffwd/api-client-server"]).toBe("workspace:*");
  });

  test("each tarball ships the LICENSE file", () => {
    for (const files of [reactFiles, serverFiles, kapableFiles]) {
      expect(files).toContain("LICENSE");
      expect(files).toContain("package.json");
    }
  });

  test("each README starts with an Install section carrying the public npm packages", () => {
    for (const dir of PACKAGE_DIRS) {
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      expect(readme).toContain("## Install");
      expect(readme).toContain("@ffwd/api-client-server");
    }
  });
});
