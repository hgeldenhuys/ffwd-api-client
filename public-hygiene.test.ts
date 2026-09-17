import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Public-repo hygiene: the word "Kapable" (any case) must not appear anywhere
 * in shipped source except the adapter package itself (@ffwd/api-client-kapable,
 * which is ABOUT the platform) and one pointer sentence in the root README's
 * "Hosts" section. docs/ is not shipped and is gitignored.
 */

const ROOT = import.meta.dir;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "docs",
  ".git",
  ".react-router",
  "data",
]);
const ALLOWED_PREFIXES = [
  "packages/api-client-kapable/", // the adapter package itself
];
// bun.lock is a generated install graph, and publish-readiness.test.ts must
// name all three packages to assert their metadata — both carry the adapter's
// own package name by construction, not by accident.
const ALLOWED_FILES = new Set(["bun.lock", "publish-readiness.test.ts"]);
const THIS_FILE = relative(ROOT, import.meta.url.replace("file://", ""));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const rel = relative(ROOT, join(dir, entry));
    if (SKIP_DIRS.has(entry)) continue;
    if (ALLOWED_PREFIXES.some((p) => (rel + sep).startsWith(p))) continue;
    if (rel === THIS_FILE) continue; // this test names the paths it excludes
    if (ALLOWED_FILES.has(rel)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  return sample.includes(0);
}

describe("public hygiene", () => {
  test('the word "Kapable" appears nowhere outside the adapter package (except the root README pointer)', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const bytes = readFileSync(file);
      if (looksBinary(bytes)) continue;
      const text = new TextDecoder().decode(bytes);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/kapable/i.test(lines[i])) continue;
        // the root README's Hosts section may carry exactly one pointer line,
        // and only when it names the adapter package
        if (file === join(ROOT, "README.md") && lines[i].includes("@ffwd/api-client-kapable")) continue;
        offenders.push(`${relative(ROOT, file)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the root README's Hosts section actually points at the adapter package", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const hosts = readme.split(/^## /m).find((s) => s.startsWith("Hosts"));
    expect(hosts).toBeTruthy();
    expect(hosts!).toContain("@ffwd/api-client-kapable");
  });
});
