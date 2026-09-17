import { describe, expect, test } from "bun:test";
import {
  createQueryUrlState,
  decodeItemPath,
  encodeItemPath,
  parseUrlState,
  reactRouterUrlState,
  sameUrlSelection,
  searchParamsToQueryString,
  serializeUrlState,
} from "@ffwd/api-client-react";

// happy-dom provides window/history for the adapter tests.
import { Window } from "happy-dom";
const win = new Window({ url: "https://host.example/app" });
// happy-dom's Window exposes these; bind the adapter's globals by installing them.
(globalThis as any).window = win;
(globalThis as any).history = win.history;
(globalThis as any).location = win.location;
(globalThis as any).addEventListener = win.addEventListener.bind(win);
(globalThis as any).removeEventListener = win.removeEventListener.bind(win);

describe("url grammar round trip", () => {
  test("a plain selection round-trips", () => {
    const sel = {
      collectionId: "abc-123",
      itemPath: "Auth'd/Get me",
      environmentId: "env-9",
      sidebar: "collections" as const,
      tab: "body" as const,
    };
    const params = serializeUrlState(sel);
    expect(params.get("c")).toBe("abc-123");
    expect(params.get("side")).toBe("collections");
    expect(params.get("tab")).toBe("body");
    const parsed = parseUrlState(params);
    expect(parsed.collectionId).toBe("abc-123");
    expect(parsed.itemPath).toBe("Auth'd/Get me");
    expect(parsed.environmentId).toBe("env-9");
    expect(sameUrlSelection(parsed, sel)).toBe(true);
  });

  test("names with / ? & and unicode survive the round trip", () => {
    const path = "weird/name?x=1&y=2/über滞 in 日本";
    const params = serializeUrlState({ collectionId: "c1", itemPath: path });
    const s = params.toString();
    // the raw special characters never appear unencoded in the serialised form
    expect(s).not.toContain("&y=2");
    expect(s).not.toContain("?x=1");
    const parsed = parseUrlState(new URLSearchParams(s));
    expect(parsed.itemPath).toBe(path);
  });

  test("escape only % and / per segment; the rest is the query layer's job", () => {
    expect(encodeItemPath("Auth'd/Get me")).toBe("Auth'd/Get me");
    expect(encodeItemPath("folder/a/b")).toBe("folder/a/b"); // joiners literal
    expect(encodeItemPath("a%b/x")).toBe("a%25b/x"); // % escaped; / is the joiner
    expect(encodeItemPath("folder/a?b&c/über滞")).toBe("folder/a?b&c/über滞");
    expect(decodeItemPath("a%25b/x")).toBe("a%b/x");
    expect(decodeItemPath("f/na%2Fme")).toBe("f/na/me");
  });

  test("the serialised query string is single-encoded: no %25, readable r", () => {
    const sel = { collectionId: "c1", itemPath: "Auth'd/Get me" };
    const q = searchParamsToQueryString(serializeUrlState(sel));
    expect(q).toBe("c=c1&r=Auth'd/Get%20me");
    expect(q).not.toContain("%25");
    // and it parses back
    const parsed = parseUrlState(new URLSearchParams(q));
    expect(parsed.itemPath).toBe("Auth'd/Get me");
    expect(parsed.collectionId).toBe("c1");
  });

  test("full cycle: serialize → query string → URL → parse, names with / ? & % unicode spaces", () => {
    const paths = [
      "Auth'd/Get me",
      "folder/Get me",
      "weird/name?x=1&y=2/über滞 in 日本",
      "a%b/c",
    ];
    for (const p of paths) {
      const q = searchParamsToQueryString(serializeUrlState({ itemPath: p }));
      const parsed = parseUrlState(new URLSearchParams(q));
      expect(parsed.itemPath).toBe(p);
    }
  });

  test("build-3 double-encoded URLs still parse (legacy rule)", () => {
    // old style: each segment encodeURIComponent'd, then URLSearchParams-encoded again
    expect(parseUrlState(new URLSearchParams("r=Get%2520me")).itemPath).toBe("Get me");
    expect(
      parseUrlState(new URLSearchParams("r=Misc%2FUrlencoded%2520login")).itemPath
    ).toBe("Misc/Urlencoded login");
    expect(
      parseUrlState(new URLSearchParams("r=Auth%27d%2FGet%2520me")).itemPath
    ).toBe("Auth'd/Get me");
  });

  test("empty params parse to an empty selection; unknown side/tab dropped", () => {
    const parsed = parseUrlState(new URLSearchParams(""));
    expect(parsed.collectionId).toBeUndefined();
    expect(parsed.itemPath).toBeUndefined();
    const junk = parseUrlState(new URLSearchParams("side=nonsense&tab=zzz"));
    expect(junk.sidebar).toBeUndefined();
    expect(junk.tab).toBeUndefined();
  });

  test("unknown ids degrade per the brief (collection cleared, request cleared, env cleared)", () => {
    // This mirrors the degrading rule in ApiClient.applyFromUrl at the parse level:
    // the component compares against loaded collections; unknown values must parse
    // as present-but-unmatched, which the component then clears.
    const params = new URLSearchParams("c=ghost&r=nope/deep&e=ghost-env&side=history");
    const parsed = parseUrlState(params);
    expect(parsed.collectionId).toBe("ghost");
    expect(parsed.itemPath).toBe("nope/deep");
    expect(parsed.environmentId).toBe("ghost-env");
    expect(parsed.sidebar).toBe("history"); // valid parts survive
  });
});

describe("query adapter (history integration)", () => {
  test("write push then popstate restores the previous selection", async () => {
    const adapter = createQueryUrlState();
    win.history.replaceState(null, "", "/app?c=one&r=first");
    const second = new URLSearchParams("c=one&r=second");
    adapter.write(second, "push");
    expect(adapter.read().get("r")).toBe("second");

    let fired = 0;
    const unsub = adapter.subscribe(() => { fired++; });
    win.history.back();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(1);
    const after = adapter.read();
    expect(after.get("r")).toBe("first");
    unsub();
  });

  test("tab changes replace and do not grow history", async () => {
    const adapter = createQueryUrlState();
    win.history.replaceState(null, "", "/app?c=one&r=a&tab=params");
    const before = win.history.length;
    adapter.write(new URLSearchParams("c=one&r=a&tab=body"), "replace");
    expect(adapter.read().get("tab")).toBe("body");
    expect(win.history.length).toBe(before);
  });
});

describe("reactRouterUrlState adapter", () => {
  test("writes through the host's setSearchParams with the right replace flag", () => {
    let sp: URLSearchParams | string = new URLSearchParams("c=one");
    const calls: { params: URLSearchParams | string; opts: any }[] = [];
    const setSp = (next: URLSearchParams | string, opts?: any) => { calls.push({ params: next, opts }); sp = next; };
    const adapter = reactRouterUrlState(new URLSearchParams(sp), setSp);
    adapter.write(new URLSearchParams("c=one&r=Auth'd/Get me"), "replace");
    adapter.write(new URLSearchParams("c=two"), "push");
    expect(calls[0].opts).toEqual({ replace: true });
    expect(calls[1].opts).toEqual({ replace: false });
    // r is written single-encoded (a string init, not URLSearchParams.toString())
    expect(calls[0].params).toContain("Auth'd/Get%20me");
    // a host recreates the adapter each render with the new searchParams
    const refreshed = reactRouterUrlState(new URLSearchParams(sp), setSp);
    expect(refreshed.read().get("c")).toBe("two");
  });
});
