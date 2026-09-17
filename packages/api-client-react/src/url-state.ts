/**
 * URL state for the ApiClient: which collection, request, environment and
 * tabs are open lives in the query string, so reloading restores the view and
 * Back/Forward move between previously opened requests.
 *
 * Grammar (all parameters optional; absent means "none"):
 *   c=<collectionId>
 *   r=<request path within the collection, "/"-joined>
 *   e=<environmentId>
 *   side=collections|envs|history
 *   tab=params|headers|body|auth|vars
 *
 * Selection identity is the item path (names), because Postman v2.1 items
 * need not carry ids. Secret values never appear here (the browser never has
 * them) and draft edits never appear here (the URL holds selection only).
 *
 * The `r` grammar is escaped in ONE layer: the item-path segments are joined
 * with a literal `/`; a literal `/` INSIDE a name is escaped as `%2F` and a
 * literal `%` as `%25` (only those two). The query layer encodes the rest
 * exactly once (space as `%20`, `?`/`&`/unicode as `%XX`), so an address bar
 * reads `r=Auth'd/Get%20me` — build 3 double-encoded every segment and read
 * `r=Auth%27d%2FGet%2520me`. Parsing splits on `/` first, then unescapes
 * `%2F`/`%25` per segment.
 *
 * Legacy URLs (build 3 style, every segment fully encodeURIComponent'd and
 * then URL-encoded again by URLSearchParams) still parse: after the normal
 * unescape, a segment that STILL contains percent-escapes is decoded once
 * more. Rule: a segment is treated as legacy double-encoded when it contains
 * a `%` followed by two hex digits after the normal unescape. A modern name
 * that literally contains the text `%20` (etc.) is indistinguishable from
 * this and decodes one step too far — the accepted trade-off, same class as
 * build 3's in-name-slash ambiguity.
 */

export type SidebarTab = "collections" | "envs" | "history";
export type EditorTab = "params" | "headers" | "body" | "auth" | "vars" | "prerequest" | "tests";

export interface UrlSelection {
  collectionId?: string;
  itemPath?: string;
  environmentId?: string;
  sidebar?: SidebarTab;
  tab?: EditorTab;
}

export type UrlWriteMode = "push" | "replace";

export interface UrlStateAdapter {
  read(): URLSearchParams;
  write(next: URLSearchParams, mode: UrlWriteMode): void;
  subscribe(cb: () => void): () => void;
}

const SIDEBAR_VALUES = new Set(["collections", "envs", "history"]);
const TAB_VALUES = new Set(["params", "headers", "body", "auth", "vars", "prerequest", "tests"]);

/**
 * Escape an item path for the `r` parameter: each segment has only `%` and
 * `/` escaped (`%25`, `%2F`); segments are joined with a literal `/`.
 * Everything else is encoded once by the query layer (see searchParamsToQueryString).
 */
export function encodeItemPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((s) => s.replaceAll("%", "%25").replaceAll("/", "%2F"))
    .join("/");
}

function tryDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Inverse of encodeItemPath at the decoded-parameter layer (what
 * URLSearchParams.get("r") returns). Splits on the literal `/` joiners,
 * unescapes `%2F`/`%25` per segment, and applies the legacy rule (a segment
 * that still contains percent-escapes is decoded once more — see the file
 * header). Tolerant of already-decoded input.
 */
export function decodeItemPath(raw: string): string {
  return raw
    .split("/")
    .map((seg) => {
      let d = seg.replaceAll("%2F", "/").replaceAll("%2f", "/").replaceAll("%25", "%");
      if (/%[0-9A-Fa-f]{2}/.test(d)) d = tryDecode(d); // legacy double-encoded segment
      return d;
    })
    .filter(Boolean)
    .join("/");
}

/**
 * The query layer: encodes every value exactly once, but keeps the `r`
 * value readable — `'` and the `/` joiners stay literal (the stored `%2F`
 * escapes protect themselves: their `%` is encoded to `%25`, and `%252F`
 * does not contain the substring `%2F`). Other params use plain
 * encodeURIComponent. This is what the adapters write to the address bar.
 */
export function searchParamsToQueryString(params: URLSearchParams): string {
  const parts: string[] = [];
  for (const [key, value] of params.entries()) {
    const v =
      key === "r"
        ? encodeURIComponent(value).replaceAll("%2F", "/")
        : encodeURIComponent(value);
    parts.push(`${encodeURIComponent(key)}=${v}`);
  }
  return parts.join("&");
}

export function serializeUrlState(sel: UrlSelection): URLSearchParams {
  const p = new URLSearchParams();
  if (sel.collectionId) p.set("c", sel.collectionId);
  if (sel.itemPath) p.set("r", encodeItemPath(sel.itemPath));
  if (sel.environmentId) p.set("e", sel.environmentId);
  if (sel.sidebar) p.set("side", sel.sidebar);
  if (sel.tab) p.set("tab", sel.tab);
  return p;
}

/** Parse URL params into a selection. Unknown side/tab values are dropped. */
export function parseUrlState(params: URLSearchParams): UrlSelection {
  const side = params.get("side");
  const tab = params.get("tab");
  const itemPathRaw = params.get("r");
  return {
    collectionId: params.get("c") || undefined,
    itemPath: itemPathRaw ? decodeItemPath(itemPathRaw) : undefined,
    environmentId: params.get("e") || undefined,
    sidebar: side && SIDEBAR_VALUES.has(side) ? (side as SidebarTab) : undefined,
    tab: tab && TAB_VALUES.has(tab) ? (tab as EditorTab) : undefined,
  };
}

/** True when the two parsed selections describe the same view. */
export function sameUrlSelection(a: UrlSelection, b: UrlSelection): boolean {
  return (
    (a.collectionId ?? "") === (b.collectionId ?? "") &&
    (a.itemPath ?? "") === (b.itemPath ?? "") &&
    (a.environmentId ?? "") === (b.environmentId ?? "") &&
    (a.sidebar ?? "") === (b.sidebar ?? "") &&
    (a.tab ?? "") === (b.tab ?? "")
  );
}

/**
 * The default adapter: the browser URL itself. Selection changes push a
 * history entry; tab-only changes replace, so the Back button moves between
 * requests without one entry per tab click.
 */
export function createQueryUrlState(): UrlStateAdapter {
  return {
    read: () => new URLSearchParams(window.location.search),
    write(next, mode) {
      const q = searchParamsToQueryString(next);
      const url = `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`;
      if (mode === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    subscribe(cb) {
      window.addEventListener("popstate", cb);
      return () => window.removeEventListener("popstate", cb);
    },
  };
}

/**
 * Adapter for React Router 7 hosts:
 *   const [sp, setSp] = useSearchParams();
 *   <ApiClient urlState={reactRouterUrlState(sp, setSp)} />
 *
 * Writes the same single-encoded query string the query adapter uses (RR
 * accepts a string init; its own URLSearchParams stringifier would encode
 * `r` with `+` for space and `%2F` joiners).
 */
export function reactRouterUrlState(
  searchParams: URLSearchParams,
  setSearchParams: (next: URLSearchParams | string, opts?: { replace?: boolean }) => void
): UrlStateAdapter {
  return {
    read: () => new URLSearchParams(searchParams),
    write: (next, mode) => setSearchParams(searchParamsToQueryString(next), { replace: mode === "replace" }),
    subscribe(cb) {
      window.addEventListener("popstate", cb);
      return () => window.removeEventListener("popstate", cb);
    },
  };
}
