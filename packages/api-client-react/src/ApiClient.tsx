import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileJson,
  Folder,
  FolderPlus,
  History as HistoryIcon,
  KeyRound,
  Plus,
  Send as SendIcon,
  Square,
  Trash2,
  Upload,
  X,
  FilePlus2,
  Pencil,
} from "lucide-react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Badge } from "./components/ui/badge";
import { Checkbox } from "./components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { TokenInput } from "./components/token-input";
import { VariablesTable, type VarRow } from "./components/variables-table";
import {
  blankCollection,
  blankRequest,
  formatBytes,
  METHODS,
  relativeTime,
  type CollectionMeta,
  type EnvironmentMeta,
  type HistoryMeta,
  type SecretMeta,
  type SendResult,
  type V21Collection,
  type V21Item,
  type V21Param,
  type V21Request,
} from "./lib/types";
import { api, apiUrl, configureApi, type UnauthorizedInfo } from "./api";
import {
  createQueryUrlState,
  parseUrlState,
  serializeUrlState,
  type EditorTab,
  type SidebarTab,
  type UrlStateAdapter,
} from "./url-state";

// ---------- client-only JSON editor ------------------------------------------
// CodeMirror is React.lazy so SSR hosts never import it on the server.

const LazyCodeMirrorJson = lazy(() => import("./code-mirror"));

function EditorFallback({
  value,
  onChange,
  editable = true,
}: {
  value: string;
  onChange?: (v: string) => void;
  editable?: boolean;
}) {
  return editable ? (
    <textarea
      className="h-48 w-full rounded border bg-transparent p-2 font-mono text-[13px]"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ) : (
    <pre className="p-3 font-mono text-[13px] whitespace-pre-wrap">{value}</pre>
  );
}

function CodeMirrorJson(props: {
  value: string;
  onChange?: (v: string) => void;
  editable?: boolean;
  height?: string;
}) {
  return (
    <Suspense fallback={<EditorFallback value={props.value} onChange={props.onChange} editable={props.editable} />}>
      <LazyCodeMirrorJson {...props} />
    </Suspense>
  );
}

// ---------- small pieces -----------------------------------------------------

function statusClass(status: number | null): string {
  if (status === null) return "bg-muted text-muted-foreground";
  if (status < 300) return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (status < 400) return "bg-sky-500/15 text-sky-600 dark:text-sky-400";
  if (status < 500) return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  return "bg-red-500/15 text-red-600 dark:text-red-400";
}

function methodBadgeClass(method: string): string {
  switch (method) {
    case "GET": return "bg-sky-500/15 text-sky-600 dark:text-sky-400";
    case "POST": return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "PUT":
    case "PATCH": return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "DELETE": return "bg-red-500/15 text-red-600 dark:text-red-400";
    default: return "bg-muted text-muted-foreground";
  }
}

function findItem(json: V21Collection, path: string): V21Item | null {
  const parts = path.split("/").filter(Boolean);
  let group: any = json;
  let found: V21Item | null = null;
  for (const part of parts) {
    const next: V21Item | undefined = (group.item ?? []).find((i: any) => i?.name === part);
    if (!next) return null;
    found = next;
    group = next;
  }
  return found;
}

function inheritedAuthFor(json: V21Collection, path: string): any | null {
  let auth: any = json.auth ?? null;
  let group: any = json;
  for (const part of path.split("/").filter(Boolean)) {
    const next = (group.item ?? []).find((i: any) => i?.name === part);
    if (!next) break;
    if (next.auth) auth = next.auth;
    group = next;
  }
  return auth;
}

interface Selection {
  kind: "request" | "collection" | "environment";
  collectionId?: string;
  itemPath?: string;
  environmentId?: string;
}

// ---------- confirm / rename dialogs (no alert/confirm/prompt anywhere) -------

type ConfirmRequest = { title: string; description: string; resolve: (v: boolean) => void };
type RenameRequest = { initial: string; resolve: (v: string | null) => void };

function AppDialogs({
  confirmReq,
  setConfirmReq,
  renameReq,
  setRenameReq,
}: {
  confirmReq: ConfirmRequest | null;
  setConfirmReq: (r: ConfirmRequest | null) => void;
  renameReq: RenameRequest | null;
  setRenameReq: (r: RenameRequest | null) => void;
}) {
  const [renameValue, setRenameValue] = useState("");
  useEffect(() => {
    if (renameReq) setRenameValue(renameReq.initial);
  }, [renameReq]);
  return (
    <>
      <Dialog open={confirmReq !== null} onOpenChange={(o) => { if (!o) { confirmReq?.resolve(false); setConfirmReq(null); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{confirmReq?.title}</DialogTitle>
            <DialogDescription>{confirmReq?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { confirmReq?.resolve(false); setConfirmReq(null); }}>Cancel</Button>
            <Button variant="destructive" onClick={() => { confirmReq?.resolve(true); setConfirmReq(null); }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={renameReq !== null} onOpenChange={(o) => { if (!o) { renameReq?.resolve(null); setRenameReq(null); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameValue.trim()) {
                renameReq?.resolve(renameValue.trim());
                setRenameReq(null);
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => { renameReq?.resolve(null); setRenameReq(null); }}>Cancel</Button>
            <Button disabled={!renameValue.trim()} onClick={() => { renameReq?.resolve(renameValue.trim()); setRenameReq(null); }}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------- main app ---------------------------------------------------------

export interface ApiClientProps {
  /** Must match the server handler's basePath. Default "/api/ffwd". */
  apiBase?: string;
  /** The host sizes it; the component fills its box. */
  className?: string;
  /** Called on any 401 so the host can redirect to its own sign-in. */
  onUnauthorized?: (info: UnauthorizedInfo) => void;
  /**
   * Where the selection (collection / request / environment / tabs) lives.
   * Default "query": the URL query string via pushState/replaceState/popstate.
   * "none": the component keeps selection in memory only (today's behaviour).
   * Or a host-supplied UrlStateAdapter (e.g. reactRouterUrlState()).
   */
  urlState?: "query" | "none" | UrlStateAdapter;
}

type InternalSidebarTab = "collections" | "environments" | "history";
type InternalEditorTab = "params" | "headers" | "body" | "auth" | "variables";

const toUrlSidebar = (t: InternalSidebarTab): SidebarTab => (t === "environments" ? "envs" : t);
const fromUrlSidebar = (t: SidebarTab): InternalSidebarTab => (t === "envs" ? "environments" : t);
const toUrlEditorTab = (t: InternalEditorTab): EditorTab => (t === "variables" ? "vars" : t);
const fromUrlEditorTab = (t: EditorTab): InternalEditorTab => (t === "vars" ? "variables" : t);

export function ApiClient({ apiBase = "/api/ffwd", className, onUnauthorized, urlState }: ApiClientProps) {
  const [authDenied, setAuthDenied] = useState<UnauthorizedInfo | null>(null);
  configureApi({
    apiBase,
    onUnauthorized: (info) => {
      setAuthDenied(info);
      onUnauthorized?.(info);
    },
  });
  const [collections, setCollections] = useState<CollectionMeta[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentMeta[]>([]);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [historyList, setHistoryList] = useState<HistoryMeta[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>("none");
  const [tab, setTab] = useState<InternalSidebarTab>("collections");
  const [editorTab, setEditorTab] = useState<InternalEditorTab>("params");
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<{ collectionId: string; json: V21Collection; dirty: boolean } | null>(null);
  const [response, setResponse] = useState<SendResult | null>(null);
  const [sending, setSending] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [renameReq, setRenameReq] = useState<RenameRequest | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ----- URL state -------------------------------------------------------------
  // The URL holds selection only (never draft edits, never secret values —
  // the browser never has those). See docs/BRIEF-3.md.

  const queryAdapter = useMemo(() => createQueryUrlState(), []);
  const urlKey: "query" | "none" | "adapter" =
    urlState === undefined || urlState === "query" ? "query" : urlState === "none" ? "none" : "adapter";
  const adapterRef = useRef<UrlStateAdapter | null>(null);
  adapterRef.current = urlKey === "query" ? queryAdapter : urlKey === "adapter" ? (urlState as UrlStateAdapter) : null;
  const lastUrlRef = useRef<string>("");
  // Set by applyFromUrl to the canonical URL of the state it just applied. The state → URL
  // effect stays silent until React state has caught up with that URL; without this, a
  // deep-linked load (and every Back) wrote the STALE state first and pushed a stray entry
  // — measured 2026-09-16: Back from a fresh load landed on the same URL.
  const pendingFromUrlRef = useRef<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  // refs so the URL callbacks always see the latest data without re-arming
  const collectionsRef = useRef(collections); collectionsRef.current = collections;
  const environmentsRef = useRef(environments); environmentsRef.current = environments;
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const draftRef = useRef(draft); draftRef.current = draft;
  const selectedEnvIdRef = useRef(selectedEnvId); selectedEnvIdRef.current = selectedEnvId;
  const tabRef = useRef(tab); tabRef.current = tab;
  const editorTabRef = useRef(editorTab); editorTabRef.current = editorTab;

  const paramsFromRefs = useCallback((): URLSearchParams => {
    const s = selectionRef.current;
    return serializeUrlState({
      collectionId: s && s.kind !== "environment" ? s.collectionId : undefined,
      itemPath: s?.kind === "request" ? s.itemPath : undefined,
      environmentId: selectedEnvIdRef.current !== "none" ? selectedEnvIdRef.current : undefined,
      sidebar: toUrlSidebar(tabRef.current),
      tab: toUrlEditorTab(editorTabRef.current),
    });
  }, []);

  /** Apply a URL's selection to the component state, degrading invalid ids. */
  const applyFromUrl = useCallback((params: URLSearchParams) => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    const sel = parseUrlState(params);
    const cols = collectionsRef.current;
    const envs = environmentsRef.current;

    let collectionId = sel.collectionId;
    let itemPath = sel.itemPath;
    let degraded = false;
    if (collectionId && !cols.some((c) => c.id === collectionId)) {
      collectionId = undefined;
      itemPath = undefined;
      degraded = true;
    } else if (collectionId && itemPath) {
      const col = cols.find((c) => c.id === collectionId)!;
      if (!findItem(col.json, itemPath)) {
        itemPath = undefined;
        degraded = true;
      }
    }
    const environmentId = sel.environmentId && envs.some((e) => e.id === sel.environmentId) ? sel.environmentId : undefined;
    const sidebar = fromUrlSidebar(sel.sidebar ?? "collections");
    const editorTabFromUrl = sel.tab ? fromUrlEditorTab(sel.tab) : undefined;

    const cur = selectionRef.current;
    const curColId = cur && cur.kind !== "environment" ? cur.collectionId : undefined;
    if (
      collectionId && curColId && collectionId !== curColId &&
      draftRef.current?.dirty && draftRef.current.collectionId !== collectionId
    ) {
      toast.warning("You have unsaved edits in another collection: save or discard them first.");
      const p = paramsFromRefs();
      lastUrlRef.current = p.toString();
      adapter.write(p, "replace");
      return;
    }

    pendingFromUrlRef.current = serializeUrlState({
      collectionId,
      itemPath,
      environmentId,
      sidebar: toUrlSidebar(sidebar),
      tab: toUrlEditorTab(editorTabFromUrl ?? editorTabRef.current),
    }).toString();

    if (itemPath && collectionId) {
      const col = cols.find((c) => c.id === collectionId)!;
      setSelection({ kind: "request", collectionId, itemPath });
      if (!draftRef.current || draftRef.current.collectionId !== collectionId) {
        setDraft({ collectionId, json: structuredClone(col.json), dirty: false });
      }
      setResponse(null);
    } else if (collectionId) {
      const col = cols.find((c) => c.id === collectionId)!;
      setSelection({ kind: "collection", collectionId });
      if (!draftRef.current || draftRef.current.collectionId !== collectionId) {
        setDraft({ collectionId, json: structuredClone(col.json), dirty: false });
      }
    } else if (environmentId && sidebar === "environments") {
      setSelection({ kind: "environment", environmentId });
    } else {
      setSelection(null);
    }
    setSelectedEnvId(environmentId ?? "none");
    setTab(sidebar);
    if (editorTabFromUrl) setEditorTab(editorTabFromUrl);

    const cleaned = serializeUrlState({
      collectionId,
      itemPath,
      environmentId,
      sidebar: toUrlSidebar(sidebar),
      tab: editorTabFromUrl ? toUrlEditorTab(editorTabFromUrl) : undefined,
    });
    const cleanedStr = cleaned.toString();
    if (cleanedStr !== params.toString()) {
      adapter.write(cleaned, "replace");
    }
    lastUrlRef.current = cleanedStr;
    if (degraded && sel.collectionId) {
      toast.error("That collection is not in this workspace any more.");
    }
  }, [paramsFromRefs]);

  // read the URL once the workspace data is there (invalid ids need it to degrade)
  useEffect(() => {
    if (urlKey === "none" || !initialLoaded) return;
    const adapter = adapterRef.current!;
    applyFromUrl(adapter.read());
  }, [urlKey, initialLoaded, applyFromUrl]);

  // external navigation (Back/Forward, host routing)
  useEffect(() => {
    if (urlKey === "none") return;
    const adapter = adapterRef.current!;
    return adapter.subscribe(() => applyFromUrl(adapter.read()));
  }, [urlKey, applyFromUrl]);

  // state → URL: push on selection changes, replace on tab-only changes
  useEffect(() => {
    if (urlKey === "none" || !initialLoaded) return;
    const adapter = adapterRef.current!;
    const params = serializeUrlState({
      collectionId: selection && selection.kind !== "environment" ? selection.collectionId : undefined,
      itemPath: selection?.kind === "request" ? selection.itemPath : undefined,
      environmentId: selectedEnvId !== "none" ? selectedEnvId : undefined,
      sidebar: toUrlSidebar(tab),
      tab: toUrlEditorTab(editorTab),
    });
    const s = params.toString();
    if (pendingFromUrlRef.current !== null) {
      if (s !== pendingFromUrlRef.current) return; // state has not caught up with the URL yet
      pendingFromUrlRef.current = null;
      lastUrlRef.current = s;
      return; // the URL already says this; nothing to write
    }
    if (s === lastUrlRef.current) return;
    const prev = parseUrlState(new URLSearchParams(lastUrlRef.current));
    lastUrlRef.current = s;
    const selectionChanged =
      (prev.collectionId ?? "") !== (selection && selection.kind !== "environment" ? selection.collectionId ?? "" : "") ||
      (prev.itemPath ?? "") !== (selection?.kind === "request" ? selection.itemPath ?? "" : "") ||
      (prev.environmentId ?? "") !== (selectedEnvId !== "none" ? selectedEnvId : "");
    adapter.write(params, selectionChanged ? "push" : "replace");
  }, [selection, selectedEnvId, tab, editorTab, urlKey, initialLoaded]);

  const refresh = useCallback(async () => {
    const state = await api<{ collections: CollectionMeta[]; environments: EnvironmentMeta[] }>("/api/state");
    if (state) {
      setCollections(state.collections);
      setEnvironments(state.environments);
    }
    const secs = await api<SecretMeta[]>("/api/secrets");
    if (secs) setSecrets(secs);
    const hist = await api<HistoryMeta[]>("/api/history?limit=200");
    if (hist) setHistoryList(hist);
    setInitialLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedEnv = environments.find((e) => e.id === selectedEnvId) ?? null;

  const knownNames = useMemo(() => {
    const set = new Set<string>();
    const colJson = draft?.json ?? collections.find((c) => c.id === selection?.collectionId)?.json;
    for (const v of colJson?.variable ?? []) if (v.key && v.type !== "secret") set.add(v.key);
    for (const v of selectedEnv?.json.values ?? []) if (v.key && v.type !== "secret") set.add(v.key);
    return set;
  }, [draft, collections, selection, selectedEnv]);

  const secretNames = useMemo(() => {
    const set = new Set<string>();
    for (const s of secrets) {
      if (draft && s.scope === "collection" && s.scopeId === draft.collectionId) set.add(s.name);
      else if (s.scope === "environment" && s.scopeId === selectedEnvId) set.add(s.name);
    }
    // also mark collection variables declared type:"secret" (imported ones) as secret
    const colJson = draft?.json ?? collections.find((c) => c.id === selection?.collectionId)?.json;
    for (const v of colJson?.variable ?? []) if (v.key && v.type === "secret") set.add(v.key);
    return set;
  }, [secrets, draft, selectedEnvId, collections, selection]);

  // ----- selection -----

  function selectRequest(collectionId: string, path: string) {
    const col = collections.find((c) => c.id === collectionId);
    if (!col) return;
    if (draft?.dirty && draft.collectionId !== collectionId) {
      toast.warning("You have unsaved edits in another collection: save or discard them first.");
      return;
    }
    setSelection({ kind: "request", collectionId, itemPath: path });
    if (!draft || draft.collectionId !== collectionId) {
      setDraft({ collectionId, json: structuredClone(col.json), dirty: false });
    }
    setResponse(null);
  }

  function selectCollection(id: string) {
    const col = collections.find((c) => c.id === id);
    if (!col) return;
    setSelection({ kind: "collection", collectionId: id });
    if (!draft || draft.collectionId !== id) setDraft({ collectionId: id, json: structuredClone(col.json), dirty: false });
  }

  function selectEnvironment(id: string) {
    setSelection({ kind: "environment", environmentId: id });
    setSelectedEnvId(id);
  }

  function mutate(fn: (json: V21Collection) => void) {
    setDraft((d) => {
      if (!d) return d;
      const json = structuredClone(d.json);
      fn(json);
      return { ...d, json, dirty: true };
    });
  }

  // ----- save / send -----

  async function saveDraft(): Promise<boolean> {
    if (!draft) return false;
    const updated = await api<CollectionMeta>(`/api/collections/${draft.collectionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: draft.json.info?.name ?? "Collection", json: draft.json }),
    });
    if (!updated) return false;
    setDraft((d) => (d ? { ...d, dirty: false } : d));
    setCollections((cols) => cols.map((c) => (c.id === updated.id ? updated : c)));
    toast.success("Saved.");
    return true;
  }

  const currentItem = useMemo(() => {
    if (!draft || selection?.kind !== "request" || !selection.itemPath) return null;
    return findItem(draft.json, selection.itemPath);
  }, [draft, selection]);

  async function send() {
    if (selection?.kind !== "request" || !selection.itemPath || !draft) {
      toast.error("Pick a request to send first.");
      return;
    }
    if (draft.dirty) {
      const ok = await saveDraft();
      if (!ok) return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    setResponse(null);
    try {
      const res = await fetch(apiUrl("/send"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          collectionId: draft.collectionId,
          itemPath: selection.itemPath,
          environmentId: selectedEnvId === "none" ? null : selectedEnvId,
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error?.message ?? `The send failed with status ${res.status}.`);
        return;
      }
      setResponse(data as SendResult);
      for (const w of (data as SendResult).warnings ?? []) toast.warning(w);
      const hist = await api<HistoryMeta[]>("/api/history?limit=200");
      if (hist) setHistoryList(hist);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setResponse(null);
        toast.info("The send was cancelled.");
      } else {
        toast.error(err?.message ?? "The send failed: the server could not be reached.");
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!sending) send();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ----- variables -----

  function varRowsFor(scope: "collection" | "environment", scopeId: string): VarRow[] {
    const rows: VarRow[] = [];
    if (scope === "collection") {
      const col = draft?.collectionId === scopeId ? draft.json : collections.find((c) => c.id === scopeId)?.json;
      for (const v of col?.variable ?? []) {
        if (!v.key) continue;
        rows.push({ ...v, secret: undefined });
      }
    } else {
      const env = environments.find((e) => e.id === scopeId);
      for (const v of env?.json.values ?? []) {
        if (!v.key) continue;
        rows.push({ ...v, secret: undefined });
      }
    }
    for (const s of secrets) {
      if (s.scope !== scope || s.scopeId !== scopeId) continue;
      const existing = rows.find((r) => r.key === s.name);
      if (existing) {
        existing.type = "secret";
        existing.value = "";
        existing.secret = s;
      } else {
        rows.push({ key: s.name, value: "", type: "secret", secret: s });
      }
    }
    return rows;
  }

  async function variablesChanged(scope: "collection" | "environment", scopeId: string) {
    const secList = await api<SecretMeta[]>("/api/secrets");
    if (!secList) return;
    setSecrets(secList);
    const names = new Set(secList.filter((s) => s.scope === scope && s.scopeId === scopeId).map((s) => s.name));
    if (scope === "collection") {
      const source = draft?.collectionId === scopeId ? draft.json : collections.find((c) => c.id === scopeId)?.json;
      if (!source) return;
      const json = structuredClone(source);
      json.variable ??= [];
      for (const name of names) {
        const row = json.variable.find((v) => v.key === name);
        if (row) {
          row.type = "secret";
          row.value = "";
        } else {
          json.variable.push({ key: name, value: "", type: "secret" });
        }
      }
      const updated = await api<CollectionMeta>(`/api/collections/${scopeId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: json.info?.name ?? "Collection", json }),
      });
      if (updated) {
        setCollections((cols) => cols.map((c) => (c.id === updated.id ? updated : c)));
        if (draft?.collectionId === scopeId) setDraft({ collectionId: scopeId, json: updated.json, dirty: false });
      }
    } else {
      const env = environments.find((e) => e.id === scopeId);
      if (!env) return;
      const json = structuredClone(env.json);
      json.values ??= [];
      for (const name of names) {
        const row = json.values.find((v) => v.key === name);
        if (row) {
          row.type = "secret";
          row.value = "";
        } else {
          json.values.push({ key: name, value: "", type: "secret" });
        }
      }
      const updated = await api<EnvironmentMeta>(`/api/environments/${scopeId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: env.name, json }),
      });
      if (updated) setEnvironments((envs) => envs.map((e) => (e.id === updated.id ? updated : e)));
    }
  }

  // ----- history reopen -----

  async function reopenHistory(id: string) {
    const row = await api<HistoryMeta>(`/api/history/${id}`);
    if (!row) return;
    const col = collections.find((c) => c.id === row.collectionId);
    if (!col || !row.request?.itemPath) {
      toast.error("The collection this request belongs to no longer exists, so it cannot be reopened.");
      return;
    }
    if (draft?.dirty && draft.collectionId !== col.id) {
      toast.warning("Save or discard your unsaved edits first.");
      return;
    }
    const json = structuredClone(col.json);
    const parts = row.request.itemPath.split("/");
    let group: any = json;
    for (let i = 0; i < parts.length - 1; i++) {
      group = (group.item ?? []).find((it: any) => it?.name === parts[i]);
      if (!group) break;
    }
    if (group && Array.isArray(group.item)) {
      const idx = group.item.findIndex((it: any) => it?.name === parts[parts.length - 1]);
      const stored = row.request.request;
      if (idx >= 0 && stored) {
        group.item[idx] = { ...group.item[idx], request: stored.request ?? stored };
      }
    }
    setDraft({ collectionId: col.id, json, dirty: true });
    setSelection({ kind: "request", collectionId: col.id, itemPath: row.request.itemPath });
    if (row.environmentId) setSelectedEnvId(row.environmentId);
    setTab("collections");
    toast.info("Reopened from history (unsaved). Press Send to re-send it, Save to keep it.");
  }

  // ============ render ============

  // A 401 whose server advertises a sign-in URL (an SSO-capable auth) gets
  // its own empty state with a "Sign in" button, not only a toast.
  if (authDenied?.signInUrl) {
    return (
      <div className={`ffwd-api-client flex h-full min-h-[480px] w-full flex-col items-center justify-center ${className ?? ""}`}>
        <Toaster position="bottom-right" />
        <div className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold">Sign in required</h2>
            <p className="text-muted-foreground">Sign in to open the ffwd API client.</p>
          </div>
          <Button asChild className="w-full">
            <a href={authDenied.signInUrl}>Sign in</a>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`ffwd-api-client flex h-full min-h-[480px] w-full flex-col overflow-hidden ${className ?? ""}`}>
      {/* The component owns its toaster: a host without Sonner would otherwise swallow every error (2026-09-16). */}
      <Toaster position="bottom-right" />
      <ResizablePanelGroup orientation="horizontal" className="flex-1">
        <ResizablePanel defaultSize="22" minSize="14">
          <Sidebar
            collections={collections}
            environments={environments}
            historyList={historyList}
            tab={tab}
            setTab={setTab}
            filter={filter}
            setFilter={setFilter}
            selection={selection}
            draft={draft}
            mutate={mutate}
            selectRequest={selectRequest}
            selectCollection={selectCollection}
            selectEnvironment={selectEnvironment}
            reopenHistory={reopenHistory}
            openImport={() => setImportOpen(true)}
            confirm={(title, description) => new Promise<boolean>((resolve) => setConfirmReq({ title, description, resolve }))}
            rename={(initial) => new Promise<string | null>((resolve) => setRenameReq({ initial, resolve }))}
            refresh={refresh}
            clearDraft={() => setDraft(null)}
            clearSelection={() => setSelection(null)}
            selectedEnvId={selectedEnvId}
            setSelectedEnvId={setSelectedEnvId}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize="78">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel defaultSize="60" minSize="25">
              <div className="flex h-full flex-col overflow-hidden">
                <div className="flex items-center gap-2 p-2">
                  {selection?.kind === "request" && currentItem?.request ? (
                    <>
                      <Select
                        value={currentItem.request.method ?? "GET"}
                        onValueChange={(v) =>
                          mutate((json) => {
                            const item = findItem(json, selection.itemPath!);
                            if (item?.request) item.request.method = v;
                          })
                        }
                      >
                        <SelectTrigger className={`w-24 font-mono text-[13px] ${methodBadgeClass(currentItem.request.method ?? "GET")}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {METHODS.map((m) => (
                            <SelectItem key={m} value={m}>{m}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <TokenInput
                        className="flex-1"
                        value={typeof currentItem.request.url === "string" ? currentItem.request.url : currentItem.request.url?.raw ?? ""}
                        onChange={(v) =>
                          mutate((json) => {
                            const item = findItem(json, selection.itemPath!);
                            if (item?.request) {
                              if (typeof item.request.url === "string") item.request.url = v;
                              else item.request.url.raw = v;
                            }
                          })
                        }
                        known={knownNames}
                        secrets={secretNames}
                        placeholder="https://api.example.com/path?key={{name}}"
                        onKeyDown={(e) => e.key === "Enter" && send()}
                      />
                      {sending ? (
                        <Button variant="outline" className="gap-1" onClick={() => abortRef.current?.abort()}>
                          <Square className="size-3.5" /> Cancel
                        </Button>
                      ) : (
                        <Button className="gap-1" onClick={send}>
                          <SendIcon className="size-3.5" /> Send
                        </Button>
                      )}
                    </>
                  ) : (
                    <div className="flex-1 text-muted-foreground">
                      {selection?.kind === "collection"
                        ? "Collection selected — pick a request on the left, or use Variables below."
                        : selection?.kind === "environment"
                          ? "Environment selected — see Variables below."
                          : "Import a collection or create one, then click a request."}
                    </div>
                  )}
                  {/* Environment selector: a normal flex item, never a fixed overlay — a fixed
                      box sat on top of the Send button and escaped the host's container (2026-09-16). */}
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <span className="text-muted-foreground">Environment</span>
                    <Select value={selectedEnvId} onValueChange={setSelectedEnvId}>
                      <SelectTrigger className="w-44">
                        <SelectValue placeholder="No environment" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No environment</SelectItem>
                        {environments.map((e) => (
                          <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex-1 overflow-auto px-2 pb-2">
                  {selection?.kind === "request" && currentItem?.request ? (
                    <RequestEditor
                      itemPath={selection.itemPath!}
                      draftJson={draft!.json}
                      mutate={mutate}
                      tab={editorTab}
                      onTabChange={setEditorTab}
                      inheritedAuth={inheritedAuthFor(draft!.json, selection.itemPath!)}
                      knownNames={knownNames}
                      secretNames={secretNames}
                      collectionScopeId={draft!.collectionId}
                      collectionVars={varRowsFor("collection", draft!.collectionId)}
                      onVariablesChanged={variablesChanged}
                      dirty={draft!.dirty}
                      onSave={saveDraft}
                    />
                  ) : selection?.kind === "collection" && draft ? (
                    <CollectionVariables
                      draft={draft}
                      rows={varRowsFor("collection", draft.collectionId)}
                      mutate={mutate}
                      onVariablesChanged={variablesChanged}
                      onSave={saveDraft}
                    />
                  ) : selection?.kind === "environment" && selection.environmentId ? (
                    <EnvironmentVariables
                      environmentId={selection.environmentId}
                      rows={varRowsFor("environment", selection.environmentId)}
                      onVariablesChanged={variablesChanged}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      Import a collection or create one
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize="40" minSize="15">
              <ResponsePane response={response} sending={sending} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={refresh} />
      <AppDialogs
        confirmReq={confirmReq}
        setConfirmReq={setConfirmReq}
        renameReq={renameReq}
        setRenameReq={setRenameReq}
      />
    </div>
  );
}

// ---------- sidebar -----------------------------------------------------------

export function Sidebar(props: {
  collections: CollectionMeta[];
  environments: EnvironmentMeta[];
  historyList: HistoryMeta[];
  tab: string;
  setTab: (t: any) => void;
  filter: string;
  setFilter: (v: string) => void;
  selection: Selection | null;
  draft: { collectionId: string; json: V21Collection; dirty: boolean } | null;
  mutate: (fn: (json: V21Collection) => void) => void;
  selectRequest: (id: string, path: string) => void;
  selectCollection: (id: string) => void;
  selectEnvironment: (id: string) => void;
  reopenHistory: (id: string) => void;
  openImport: () => void;
  confirm: (title: string, description: string) => Promise<boolean>;
  rename: (initial: string) => Promise<string | null>;
  refresh: () => void;
  clearDraft: () => void;
  clearSelection: () => void;
  selectedEnvId: string;
  setSelectedEnvId: (v: string) => void;
}) {
  const {
    collections, environments, historyList, tab, setTab, filter, setFilter, selection, draft,
    mutate, selectRequest, selectCollection, selectEnvironment, reopenHistory, openImport,
    confirm, rename, refresh, clearDraft, clearSelection,
  } = props;

  return (
    <div className="flex h-full flex-col border-r">
      <div className="flex items-center gap-1 p-2">
        <Button size="sm" variant="outline" className="gap-1" onClick={openImport}>
          <Upload className="size-3.5" /> Import
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1">
              <Plus className="size-3.5" /> New
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={async () => {
                const created = await api<CollectionMeta>("/api/collections", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: "New collection" }),
                });
                if (created) {
                  await refresh();
                  selectCollection(created.id);
                }
              }}
            >
              <FilePlus2 className="size-3.5" /> Collection
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                const created = await api<EnvironmentMeta>("/api/environments", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: "New environment" }),
                });
                if (created) {
                  await refresh();
                  selectEnvironment(created.id);
                  setTab("environments");
                }
              }}
            >
              <KeyRound className="size-3.5" /> Environment
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-2 pb-2">
        <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8" />
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v)} className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="mx-2 grid grid-cols-3">
          <TabsTrigger value="collections">Collections</TabsTrigger>
          <TabsTrigger value="environments">Envs</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="collections" className="mt-0 flex-1 overflow-auto">
          {collections.length === 0 ? (
            <div className="p-4 text-muted-foreground">
              <p className="mb-2">No collections yet.</p>
              <Button size="sm" variant="outline" onClick={openImport}>
                Import a collection or create one
              </Button>
            </div>
          ) : (
            collections.map((col) => {
              const djson = draft?.collectionId === col.id ? draft.json : col.json;
              const matches = (s: string) => s.toLowerCase().includes(filter.toLowerCase());
              return (
                <div key={col.id} className="px-1 py-0.5">
                  <div className="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent">
                    <button
                      className={`flex flex-1 items-center gap-1.5 text-left text-[13px] ${selection?.collectionId === col.id && selection.kind !== "request" ? "font-semibold" : ""}`}
                      onClick={() => selectCollection(col.id)}
                    >
                      <FileJson className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{djson?.info?.name ?? col.name}</span>
                      {draft?.dirty && draft.collectionId === col.id && <span aria-hidden>•</span>}
                    </button>
                    <a href={`/api/export/collection/${col.id}`} title="Export as v2.1 JSON" className="opacity-0 group-hover:opacity-100">
                      <Download className="size-3.5 text-muted-foreground" />
                    </a>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100">⋯</Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          onClick={async () => {
                            if (draft?.collectionId !== col.id) {
                              toast.warning("Click the collection first to open it, then add to it.");
                              return;
                            }
                            mutate((json) => {
                              json.item ??= [];
                              json.item.push({ name: "New request", request: blankRequest() });
                            });
                          }}
                        >
                          <Plus className="size-3.5" /> Add request
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={async () => {
                            if (draft?.collectionId !== col.id) {
                              toast.warning("Click the collection first to open it, then add to it.");
                              return;
                            }
                            mutate((json) => {
                              json.item ??= [];
                              json.item.push({ name: "New folder", item: [] });
                            });
                          }}
                        >
                          <FolderPlus className="size-3.5" /> Add folder
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={async () => {
                            if (!(await confirm(`Delete collection “${col.name}”?`, "The collection and its variables are deleted. Requests in history keep their copies."))) return;
                            await api(`/api/collections/${col.id}`, { method: "DELETE" });
                            if (draft?.collectionId === col.id) clearDraft();
                            if (selection?.collectionId === col.id) clearSelection();
                            refresh();
                          }}
                        >
                          <Trash2 className="size-3.5" /> Delete collection
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <TreeView
                    items={(djson?.item ?? []).filter((it: any) => matches(it?.name ?? ""))}
                    path=""
                    selectionPath={selection?.kind === "request" && selection.collectionId === col.id ? selection.itemPath! : null}
                    onSelect={(p) => selectRequest(col.id, p)}
                    draft={draft}
                    collectionId={col.id}
                    mutate={mutate}
                    confirm={confirm}
                    rename={rename}
                    refresh={refresh}
                  />
                </div>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="environments" className="mt-0 flex-1 overflow-auto">
          {environments.length === 0 ? (
            <p className="p-4 text-muted-foreground">No environments yet. Import one, or press New → Environment.</p>
          ) : (
            environments.map((env) => (
              <div key={env.id} className="group flex items-center gap-1 rounded px-2 py-1 hover:bg-accent">
                <button
                  className={`flex flex-1 items-center gap-1.5 text-left text-[13px] ${selection?.environmentId === env.id ? "font-semibold" : ""}`}
                  onClick={() => selectEnvironment(env.id)}
                >
                  <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{env.name}</span>
                </button>
                <a href={`/api/export/environment/${env.id}`} title="Export" className="opacity-0 group-hover:opacity-100">
                  <Download className="size-3.5 text-muted-foreground" />
                </a>
                <button
                  className="opacity-0 group-hover:opacity-100"
                  title="Delete environment"
                  onClick={async () => {
                    if (!(await confirm(`Delete environment “${env.name}”?`, "Its variables and its secrets are deleted."))) return;
                    await api(`/api/environments/${env.id}`, { method: "DELETE" });
                    if (props.selectedEnvId === env.id) props.setSelectedEnvId("none");
                    if (selection?.environmentId === env.id) clearSelection();
                    refresh();
                  }}
                >
                  <Trash2 className="size-3.5 text-destructive" />
                </button>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-0 flex-1 overflow-auto">
          {historyList.length === 0 ? (
            <p className="p-4 text-muted-foreground">No sends yet. Send a request and it will appear here (last 200).</p>
          ) : (
            historyList.map((h) => (
              <button
                key={h.id}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => reopenHistory(h.id)}
              >
                <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-[13px]">{h.request?.name ?? h.request?.collectionName ?? "Send"}</span>
                <Badge variant="outline" className={`shrink-0 ${statusClass(h.status)}`}>{h.status ?? h.error ?? "—"}</Badge>
                <span className="shrink-0 text-muted-foreground">{relativeTime(h.at)}</span>
              </button>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- tree -------------------------------------------------------------

function TreeView(props: {
  items: V21Item[];
  path: string;
  selectionPath: string | null;
  onSelect: (path: string) => void;
  draft: { collectionId: string; json: V21Collection; dirty: boolean } | null;
  collectionId: string;
  mutate: (fn: (json: V21Collection) => void) => void;
  confirm: (title: string, description: string) => Promise<boolean>;
  rename: (initial: string) => Promise<string | null>;
  refresh: () => void;
}) {
  const { items, path, selectionPath, onSelect, draft, collectionId, mutate, confirm, rename } = props;
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // A deep link or Back/Forward can select a request inside a collapsed folder; open the
  // folders on its path so the selected row is visible (2026-09-16).
  useEffect(() => {
    if (!selectionPath) return;
    setOpen((o) => {
      let changed = false;
      const next = { ...o };
      for (const item of items) {
        const p = path ? `${path}/${item.name}` : item.name!;
        if (Array.isArray(item.item) && selectionPath.startsWith(p + "/") && !next[p]) {
          next[p] = true;
          changed = true;
        }
      }
      return changed ? next : o;
    });
  }, [selectionPath, items, path]);

  function requireDraft(): boolean {
    if (!draft || draft.collectionId !== collectionId) {
      toast.warning("Click the collection in the sidebar first to open it, then edit it.");
      return false;
    }
    return true;
  }

  return (
    <div className="pl-3">
      {items.map((item, i) => {
        const p = path ? `${path}/${item.name}` : item.name!;
        const isFolder = Array.isArray(item.item);
        const selected = selectionPath === p;
        return (
          <div key={p + i}>
            <div className="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent">
              {isFolder ? (
                <button className="flex flex-1 items-center gap-1.5 text-left text-[13px]" onClick={() => setOpen((o) => ({ ...o, [p]: !o[p] }))}>
                  {open[p] ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{item.name}</span>
                </button>
              ) : (
                <button className="flex flex-1 items-center gap-1.5 text-left text-[13px]" onClick={() => onSelect(p)}>
                  <span className={`shrink-0 rounded px-1 py-0.5 font-mono text-[10px] ${methodBadgeClass(item.request?.method ?? "GET")}`}>
                    {(item.request?.method ?? "GET").slice(0, 4)}
                  </span>
                  <span className={`truncate ${selected ? "font-semibold" : ""}`}>
                    {item.name}
                    {draft?.dirty && draft.collectionId === collectionId && selected ? " •" : ""}
                  </span>
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100">⋯</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {isFolder && (
                    <>
                      <DropdownMenuItem
                        onClick={() => {
                          if (!requireDraft()) return;
                          mutate((json) => {
                            const folder = findItem(json, p);
                            if (folder) { folder.item ??= []; folder.item.push({ name: "New request", request: blankRequest() }); }
                          });
                        }}
                      >
                        <Plus className="size-3.5" /> Add request
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          if (!requireDraft()) return;
                          mutate((json) => {
                            const folder = findItem(json, p);
                            if (folder) { folder.item ??= []; folder.item.push({ name: "New folder", item: [] }); }
                          });
                        }}
                      >
                        <FolderPlus className="size-3.5" /> Add folder
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuItem
                    onClick={async () => {
                      if (!requireDraft()) return;
                      const item0 = findItem(draft!.json, p);
                      if (!item0) return;
                      const newName = await rename(item0.name ?? "");
                      if (!newName) return;
                      mutate((json) => {
                        const target = findItem(json, p);
                        if (target) target.name = newName;
                      });
                    }}
                  >
                    <Pencil className="size-3.5" /> Rename…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={async () => {
                      if (!(await confirm(`Delete “${item.name}”?`, isFolder ? "The folder and everything inside it is deleted." : "The request is deleted from the collection."))) return;
                      if (!requireDraft()) return;
                      mutate((json) => {
                        const parentPath = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
                        const parent: any = parentPath ? findItem(json, parentPath) : json;
                        const name = p.slice(p.lastIndexOf("/") + 1);
                        if (parent?.item) parent.item = parent.item.filter((it: any) => it?.name !== name);
                      });
                      toast.info("Deleted from the draft. Press Save to keep it, or reload to undo.");
                    }}
                  >
                    <Trash2 className="size-3.5" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {isFolder && open[p] && (
              <TreeView {...props} items={item.item ?? []} path={p} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- request editor ----------------------------------------------------

export function RequestEditor(props: {
  itemPath: string;
  draftJson: V21Collection;
  mutate: (fn: (json: V21Collection) => void) => void;
  tab: InternalEditorTab;
  onTabChange: (t: InternalEditorTab) => void;
  inheritedAuth: any | null;
  knownNames: Set<string>;
  secretNames: Set<string>;
  collectionScopeId: string;
  collectionVars: VarRow[];
  onVariablesChanged: (scope: "collection" | "environment", scopeId: string) => void;
  dirty: boolean;
  onSave: () => Promise<boolean>;
}) {
  const { itemPath, mutate, tab, onTabChange, inheritedAuth, knownNames, secretNames, collectionScopeId, collectionVars, onVariablesChanged, dirty, onSave } = props;
  const item = findItem(props.draftJson, itemPath);
  if (!item?.request) return <p className="p-4 text-muted-foreground">Pick a request.</p>;
  const req = item.request;

  function editRequest(fn: (r: V21Request, item: V21Item) => void) {
    mutate((json) => {
      const target = findItem(json, itemPath);
      if (!target?.request) return;
      fn(target.request, target);
    });
  }

  const url = typeof req.url === "string" ? req.url : req.url?.raw ?? "";
  const params = typeof req.url === "string" ? ([] as V21Param[]) : req.url?.query ?? [];
  const headers = req.header ?? [];
  const body = req.body ?? { mode: "none" as const };

  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as InternalEditorTab)} className="pt-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-semibold">{item.name}{dirty ? " •" : ""}</span>
        {dirty && <Button size="sm" onClick={onSave}>Save</Button>}
      </div>
      <TabsList className="mt-2">
        <TabsTrigger value="params">Params{params.length ? ` (${params.length})` : ""}</TabsTrigger>
        <TabsTrigger value="headers">Headers{headers.length ? ` (${headers.length})` : ""}</TabsTrigger>
        <TabsTrigger value="body">Body</TabsTrigger>
        <TabsTrigger value="auth">Auth</TabsTrigger>
        <TabsTrigger value="variables">Variables</TabsTrigger>
      </TabsList>

      <TabsContent value="params">
        <ParamRows
          rows={params}
          knownNames={knownNames}
          secretNames={secretNames}
          onChange={(rows) =>
            editRequest((r) => {
              if (typeof r.url === "string") r.url = { raw: r.url, query: rows };
              else r.url.query = rows;
            })
          }
        />
      </TabsContent>

      <TabsContent value="headers">
        <ParamRows
          rows={headers}
          knownNames={knownNames}
          secretNames={secretNames}
          onChange={(rows) => editRequest((r) => { r.header = rows; })}
        />
      </TabsContent>

      <TabsContent value="body">
        <div className="space-y-2 pt-1">
          <Select
            value={body.mode ?? "none"}
            onValueChange={(v) => editRequest((r) => { r.body = { mode: v as any }; })}
          >
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">none</SelectItem>
              <SelectItem value="raw">raw</SelectItem>
              <SelectItem value="urlencoded">urlencoded</SelectItem>
              <SelectItem value="formdata">form-data</SelectItem>
            </SelectContent>
          </Select>
          {body.mode === "raw" && (
            <CodeMirrorJson value={body.raw ?? ""} onChange={(v) => editRequest((r) => { r.body!.raw = v; })} />
          )}
          {body.mode === "urlencoded" && (
            <ParamRows
              rows={body.urlencoded ?? []}
              knownNames={knownNames}
              secretNames={secretNames}
              onChange={(rows) => editRequest((r) => { r.body!.urlencoded = rows; })}
            />
          )}
          {body.mode === "formdata" && (
            <ParamRows
              rows={body.formdata ?? []}
              knownNames={knownNames}
              secretNames={secretNames}
              onChange={(rows) => editRequest((r) => { r.body!.formdata = rows; })}
            />
          )}
        </div>
      </TabsContent>

      <TabsContent value="auth">
        <AuthEditor
          itemAuth={item.auth ?? null}
          inheritedAuth={inheritedAuth}
          knownNames={knownNames}
          secretNames={secretNames}
          onChange={(newAuth) => editRequest((_r, target) => { (target as any).auth = newAuth; })}
        />
      </TabsContent>

      <TabsContent value="variables">
        <VariablesTable
          rows={collectionVars}
          scope="collection"
          scopeId={collectionScopeId}
          onChanged={() => onVariablesChanged("collection", collectionScopeId)}
        />
      </TabsContent>
    </Tabs>
  );
}

// ---------- param rows ----------------------------------------------------------

function ParamRows({
  rows,
  onChange,
  knownNames,
  secretNames,
}: {
  rows: V21Param[];
  onChange: (rows: V21Param[]) => void;
  knownNames: Set<string>;
  secretNames: Set<string>;
}) {
  if (rows.length === 0) {
    return (
      <div className="pt-2">
        <p className="mb-2 text-muted-foreground">No rows yet.</p>
        <Button size="sm" variant="outline" className="gap-1" onClick={() => onChange([{ key: "", value: "", disabled: false }])}>
          <Plus className="size-3.5" /> Add row
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-1 pt-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Checkbox
            checked={!row.disabled}
            onCheckedChange={(v) => {
              const next = [...rows];
              next[i] = { ...row, disabled: !v };
              onChange(next);
            }}
          />
          <Input
            className="h-8 flex-1 font-mono text-[13px]"
            placeholder="key"
            value={row.key}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...row, key: e.target.value };
              onChange(next);
            }}
          />
          <TokenInput
            className="flex-[2]"
            placeholder="value"
            value={row.value}
            known={knownNames}
            secrets={secretNames}
            onChange={(v) => {
              const next = [...rows];
              next[i] = { ...row, value: v };
              onChange(next);
            }}
          />
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" className="gap-1" onClick={() => onChange([...rows, { key: "", value: "", disabled: false }])}>
        <Plus className="size-3.5" /> Add row
      </Button>
    </div>
  );
}

// ---------- auth editor ---------------------------------------------------------

function AuthEditor({
  itemAuth,
  inheritedAuth,
  knownNames,
  secretNames,
  onChange,
}: {
  itemAuth: any | null;
  inheritedAuth: any | null;
  knownNames: Set<string>;
  secretNames: Set<string>;
  onChange: (auth: any | null) => void;
}) {
  const mode = itemAuth === null ? "inherit" : itemAuth.type === "noauth" ? "none" : itemAuth.type;
  function setMode(m: string) {
    if (m === "inherit") return onChange(null);
    if (m === "none") return onChange({ type: "noauth" });
    if (m === "bearer") return onChange({ type: "bearer", bearer: [{ key: "token", value: "" }] });
    if (m === "basic") return onChange({ type: "basic", basic: [{ key: "username", value: "" }, { key: "password", value: "" }] });
    if (m === "apikey") return onChange({ type: "apikey", apikey: [{ key: "key", value: "" }, { key: "value", value: "" }, { key: "in", value: "header" }] });
  }
  const param = (type: string, key: string) => itemAuth?.[type]?.find((p: any) => p.key === key)?.value ?? "";
  function setParam(type: string, key: string, value: string) {
    const next = structuredClone(itemAuth);
    const list = (next[type] ??= []);
    const row = list.find((p: any) => p.key === key);
    if (row) row.value = value;
    else list.push({ key, value });
    onChange(next);
  }
  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center gap-2">
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">Inherit</SelectItem>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="bearer">Bearer token</SelectItem>
            <SelectItem value="basic">Basic auth</SelectItem>
            <SelectItem value="apikey">API key</SelectItem>
          </SelectContent>
        </Select>
        {mode === "inherit" && inheritedAuth && (
          <span className="flex items-center gap-1 text-muted-foreground">
            inherits <Badge variant="outline">{inheritedAuth.type}</Badge> from the collection or folder
          </span>
        )}
      </div>
      {mode === "bearer" && (
        <div className="flex items-center gap-2">
          <span className="w-16 text-muted-foreground">token</span>
          <TokenInput
            className="flex-1"
            value={param("bearer", "token")}
            known={knownNames}
            secrets={secretNames}
            onChange={(v) => setParam("bearer", "token", v)}
            placeholder="{{token}} — prefer a secret variable"
          />
        </div>
      )}
      {mode === "basic" && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-16 text-muted-foreground">username</span>
            <Input className="flex-1 font-mono text-[13px]" value={param("basic", "username")} onChange={(e) => setParam("basic", "username", e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-muted-foreground">password</span>
            <TokenInput
              className="flex-1"
              value={param("basic", "password")}
              known={knownNames}
              secrets={secretNames}
              onChange={(v) => setParam("basic", "password", v)}
              placeholder="{{password}}"
            />
          </div>
        </>
      )}
      {mode === "apikey" && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-16 text-muted-foreground">key</span>
            <Input className="flex-1 font-mono text-[13px]" value={param("apikey", "key")} onChange={(e) => setParam("apikey", "key", e.target.value)} placeholder="X-API-Key" />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-muted-foreground">value</span>
            <TokenInput
              className="flex-1"
              value={param("apikey", "value")}
              known={knownNames}
              secrets={secretNames}
              onChange={(v) => setParam("apikey", "value", v)}
              placeholder="{{api_key}}"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-muted-foreground">add to</span>
            <Select value={param("apikey", "in") || "header"} onValueChange={(v) => setParam("apikey", "in", v)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="header">header</SelectItem>
                <SelectItem value="query">query</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- response pane -------------------------------------------------------

export function ResponsePane({ response, sending }: { response: SendResult | null; sending: boolean }) {
  const [respTab, setRespTab] = useState<"body" | "headers">("body");
  const pretty = useMemo(() => {
    if (!response?.body) return null;
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return null;
    }
  }, [response]);
  const downloadUrl = useMemo(() => {
    if (!response?.bodyBase64) return null;
    const bin = atob(response.bodyBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: response.contentType || "application/octet-stream" }));
  }, [response]);

  if (sending) return <div className="flex h-full items-center justify-center text-muted-foreground">Sending…</div>;
  if (!response) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
        <p>Press Send to see the response here.</p>
        <p className="text-xs">⌘⏎ sends · Cancel stops an in-flight send</p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
        <Badge className={statusClass(response.status)}>{response.status ?? "—"} {response.statusText}</Badge>
        <span className="text-muted-foreground">{response.durationMs} ms</span>
        <span className="text-muted-foreground">{formatBytes(response.sizeBytes)}{response.truncated ? " (truncated at 10 MB)" : ""}</span>
        {response.redirects.length > 0 && <span className="text-muted-foreground">{response.redirects.length} redirect(s)</span>}
        {response.error && <Badge className="bg-red-500/15 text-red-600 dark:text-red-400">{response.error.code}</Badge>}
        {response.hidden === false && response.notHiddenReason && (
          <span className="text-muted-foreground" title={response.notHiddenReason}>body not hidden</span>
        )}
        <Tabs value={respTab} onValueChange={(v) => setRespTab(v as any)} className="ml-auto">
          <TabsList className="h-7">
            <TabsTrigger value="body" className="h-7">Body</TabsTrigger>
            <TabsTrigger value="headers" className="h-7">Headers</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {response.error && (
        <div className="border-b bg-destructive/10 px-3 py-2 text-[13px]">{response.error.message}</div>
      )}
      <div className="flex-1 overflow-auto">
        {respTab === "headers" ? (
          <table className="w-full text-[13px]">
            <tbody>
              {Object.entries(response.headers).map(([k, v]) => (
                <tr key={k} className="border-b">
                  <td className="w-64 px-3 py-1 align-top font-mono text-muted-foreground">{k}</td>
                  <td className="px-3 py-1 font-mono break-all whitespace-pre-wrap">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : response.bodyBase64 !== null ? (
          <div className="p-3 text-[13px] text-muted-foreground">
            <p className="mb-2">Binary body ({formatBytes(response.sizeBytes)}, {response.contentType || "unknown type"}): not rendered inline.</p>
            {response.notHiddenReason && <p className="mb-2">{response.notHiddenReason}</p>}
            {downloadUrl && <a className="underline" href={downloadUrl} download>Download body</a>}
          </div>
        ) : pretty !== null ? (
          <CodeMirrorJson value={pretty} editable={false} height="100%" />
        ) : (
          <pre className="p-3 font-mono text-[13px] whitespace-pre-wrap">{response.body}</pre>
        )}
      </div>
    </div>
  );
}

// ---------- collection/environment variable views -------------------------------

function CollectionVariables({
  draft,
  rows,
  mutate,
  onVariablesChanged,
  onSave,
}: {
  draft: { collectionId: string; json: V21Collection; dirty: boolean };
  rows: VarRow[];
  mutate: (fn: (json: V21Collection) => void) => void;
  onVariablesChanged: (scope: "collection" | "environment", scopeId: string) => void;
  onSave: () => Promise<boolean>;
}) {
  return (
    <div className="pt-2">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">Variables — {draft.json.info?.name ?? "collection"}</h3>
        {draft.dirty && <Button size="sm" onClick={onSave}>Save collection</Button>}
      </div>
      <VariablesTable
        rows={rows}
        scope="collection"
        scopeId={draft.collectionId}
        onChanged={() => onVariablesChanged("collection", draft.collectionId)}
      />
      <div className="mt-3">
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={() =>
            mutate((json) => {
              json.variable ??= [];
              json.variable.push({ key: "", value: "" });
            })
          }
        >
          <Plus className="size-3.5" /> Add variable
        </Button>
      </div>
    </div>
  );
}

function EnvironmentVariables({
  environmentId,
  rows,
  onVariablesChanged,
}: {
  environmentId: string;
  rows: VarRow[];
  onVariablesChanged: (scope: "collection" | "environment", scopeId: string) => void;
}) {
  return (
    <div className="pt-2">
      <h3 className="mb-2 text-[13px] font-semibold">Variables — environment</h3>
      <VariablesTable
        rows={rows}
        scope="environment"
        scopeId={environmentId}
        onChanged={() => onVariablesChanged("environment", environmentId)}
      />
    </div>
  );
}

// ---------- import dialog --------------------------------------------------------

function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
}) {
  const [kind, setKind] = useState<"collection" | "environment">("collection");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function importText(jsonText: string) {
    let json: any;
    try {
      json = JSON.parse(jsonText);
    } catch {
      toast.error("That is not valid JSON: check the paste and try again.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/import"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, json }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error?.message ?? `The import failed with status ${res.status}.`);
        return;
      }
      for (const m of data.moved ?? []) {
        toast.success(`Moved into secrets: "${m.name}" (${m.where ?? m.scope})`);
      }
      for (const w of data.warnings ?? []) toast.warning(w);
      if ((data.moved ?? []).length === 0 && (data.warnings ?? []).length === 0) {
        toast.success(`Imported the ${kind}.`);
      }
      onOpenChange(false);
      setText("");
      onImported();
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await importText(await file.text());
    e.target.value = "";
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import</DialogTitle>
          <DialogDescription>
            Import a Postman v2.1 collection or environment. Secret values move into the encrypted store and are blanked in the stored JSON.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as any)}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="collection">Collection</SelectItem>
              <SelectItem value="environment">Environment</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex-1">
            <input type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
            <Button variant="outline" className="w-full gap-1" asChild>
              <span><Upload className="size-3.5" /> Choose file…</span>
            </Button>
          </label>
        </div>
        <textarea
          className="h-40 w-full rounded-md border bg-transparent p-2 font-mono text-[13px]"
          placeholder={`…or paste the ${kind} JSON here`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !text.trim()} onClick={() => importText(text)}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ApiClient;
