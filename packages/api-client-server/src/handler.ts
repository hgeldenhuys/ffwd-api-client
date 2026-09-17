/**
 * createApiClientHandler — the whole API surface of the client as one plain
 * fetch function. Route logic moved verbatim from build 1's resource routes;
 * the Store and master key come from the host instead of process.env, and the
 * access gate is whatever auth function the host provides.
 */

import { sealSecret } from "./crypt";
import type { AuthFn } from "./session";
import { importCollection, importEnvironment } from "./import-export";
import { type ProxyPolicyOptions } from "./proxy-policy";
import { assertNotProductionOverride } from "./env";
import { performSend, type SendOutput } from "./sender";
import { collectionHasScripts, TRUST_MARKER } from "./scripts/run";
import type { Scope, Store } from "./store";

import { apiError } from "./api-error";
export { apiError };

import { safeDest } from "./session";

const DEFAULT_BASE_PATH = "/api/ffwd";

/**
 * The two SSO routes an SSO-capable auth may carry. They exist under the
 * basePath (`<basePath>/auth/sso/...`) AND at the literal top-level
 * `/auth/sso/...` when a host mounts the handler there too — an SSO
 * provider's `return_to` can then be `${publicUrl}/auth/sso/callback`. The
 * core ships no SSO auth; a host adapter package can provide one.
 */
function ssoAction(pathname: string, basePath: string): "start" | "callback" | null {
  if (pathname === "/auth/sso/start") return "start";
  if (pathname === "/auth/sso/callback") return "callback";
  if (pathname === `${basePath}/auth/sso/start`) return "start";
  if (pathname === `${basePath}/auth/sso/callback`) return "callback";
  return null;
}

/** Add details.sign_in_url to an existing 401 JSON body, preserving the rest. */
async function addSignInUrl(res: Response, signInUrl: string): Promise<Response | null> {
  try {
    const body = (await res.json()) as any;
    body.error = body.error ?? {};
    body.error.details = body.error.details ?? {};
    body.error.details.sign_in_url = signInUrl;
    return Response.json(body, { status: 401, headers: res.headers });
  } catch {
    return null;
  }
}

export interface CreateApiClientHandlerOptions {
  store: Store;
  /** base64, 32 bytes (SECRETS_MASTER_KEY in the reference host). */
  masterKey: string;
  basePath?: string;
  auth: AuthFn;
  policy?: Partial<ProxyPolicyOptions>;
}

function masterKeyBytes(base64: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  if (bytes.length !== 32) {
    throw new Error(
      `masterKey must decode to exactly 32 bytes (got ${bytes.length}): generate one with \`openssl rand -base64 32\`.`
    );
  }
  return bytes;
}

export function createApiClientHandler(opts: CreateApiClientHandlerOptions): (req: Request) => Promise<Response> {
  const store = opts.store;
  const masterKey = masterKeyBytes(opts.masterKey);
  const basePath = (opts.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
  const policy: ProxyPolicyOptions = opts.policy ?? {};

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // The SSO routes are handled BY the auth function (it owns the signing
    // keys); they bypass the normal gate-then-route order. A verdict that
    // already carries a response (303/401) is the answer; a bare ok:false
    // with ok:true means signed in, so bounce to the destination.
    const sso = ssoAction(url.pathname, basePath);
    if (sso) {
      const verdict = await opts.auth(req);
      if (!verdict.ok) return verdict.response ?? apiError("unauthorized", "Not authorized: sign in and try again.", {}, 401);
      const dest = sso === "start" ? safeDest(url.searchParams.get("dest") ?? "/") : "/";
      return new Response(null, { status: 303, headers: { location: dest } });
    }

    let path = url.pathname;
    if (path === basePath) path = "/";
    else if (path.startsWith(basePath + "/")) path = path.slice(basePath.length);
    else {
      return apiError(
        "not_found",
        `That path is not part of the API client: mount the handler at ${basePath} and call its routes under it.`,
        { path: url.pathname, basePath },
        404
      );
    }
    let segments = path.split("/").filter(Boolean);
    // Build-1 route names carried an "/api/" prefix (e.g. /api/_echo); after
    // basePath stripping, tolerate that leading "api" segment so requests
    // written as `<base>/api/_echo` and `<base>/_echo` both route.
    if (segments[0] === "api") segments = segments.slice(1);

    // every route is behind the host's auth
    const verdict = await opts.auth(req);
    if (!verdict.ok) {
      // WWW-Authenticate-style: an SSO-capable auth advertises where to sign
      // in — on its own 401 body, or on the 401 another auth in an anyOf
      // chain produced.
      if (verdict.response) {
        if (
          (opts.auth as { ssoCapable?: unknown }).ssoCapable === true &&
          verdict.response.status === 401
        ) {
          const withUrl = await addSignInUrl(verdict.response, `${basePath}/auth/sso/start?dest=${encodeURIComponent(url.pathname + url.search)}`);
          if (withUrl) return withUrl;
        }
        return verdict.response;
      }
      const details: Record<string, unknown> = {};
      if ((opts.auth as { ssoCapable?: unknown }).ssoCapable === true) {
        details.sign_in_url = `${basePath}/auth/sso/start?dest=${encodeURIComponent(url.pathname + url.search)}`;
      }
      return apiError("unauthorized", "Not authorized: sign in and try again.", details, 401);
    }

    try {
      return await route(req, segments, url);
    } catch (err: any) {
      return apiError("internal", err?.message ?? "Something went wrong handling that request: check the server log.", {}, 500);
    }
  };

  // ---- routing ----------------------------------------------------------------

  async function route(req: Request, seg: string[], url: URL): Promise<Response> {
    const [a, b, c, d] = seg;

    if (a === "_echo") return echo(req);

    if (a === "state") return json({
      collections: store.listCollections().map((co) => ({ id: co.id, name: co.name, json: JSON.parse(co.json), updatedAt: co.updated_at })),
      environments: store.listEnvironments().map((e) => ({ id: e.id, name: e.name, json: JSON.parse(e.json), updatedAt: e.updated_at })),
    });

    if (a === "collections" && !b) return collectionsCollection(req);
    if (a === "collections" && b) return collectionById(req, b);

    if (a === "environments" && !b) return environmentsEnv(req);
    if (a === "environments" && b) return environmentById(req, b);

    if (a === "secrets" && !b) return secretsList(req, url);
    if (a === "secrets" && b && c && d) return secretValue(req, b as Scope, c, d);
    if (a === "secrets") {
      return apiError("bad_path", "The path must be /api/secrets/{scope}/{scopeId}/{name}, or /api/secrets?scope=&scopeId= to list.", { path: url.pathname }, 400);
    }

    if (a === "import") return importDoc(req);
    if (a === "export" && b && c) return exportDoc(req, b, c);

    if (a === "send") return send(req);
    if (a === "history" && !b) return historyList(req, url);
    if (a === "history" && b) return historyItem(req, b);

    return apiError("not_found", "That route does not exist: check the API client's route table.", { path: url.pathname }, 404);
  }

  // ---- state / echo / history ---------------------------------------------------

  async function echo(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const body = await req.text();
    return Response.json({
      method: req.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      headers,
      body,
    });
  }

  async function historyList(req: Request, url: URL): Promise<Response> {
    if (req.method !== "GET") return apiError("method_not_allowed", "Use GET to list history.", { method: req.method }, 405);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const rows = store.listHistory(Number.isFinite(limit) ? limit : 200);
    return json(rows.map(historyToJson));
  }

  async function historyItem(req: Request, id: string): Promise<Response> {
    if (req.method !== "GET") return apiError("method_not_allowed", "Use GET to read one history entry.", { method: req.method }, 405);
    const row = store.getHistory(id);
    if (!row) return apiError("not_found", "That history entry is gone: it may have aged out of the last 200 sends.", { id }, 404);
    return json(historyToJson(row));
  }

  function historyToJson(r: {
    id: string; at: string; request_json: string; environment_id: string | null;
    collection_id: string | null; item_path: string | null; status: number | null;
    error: string | null; duration_ms: number | null; size_bytes: number | null;
  }) {
    return {
      id: r.id,
      at: r.at,
      request: JSON.parse(r.request_json),
      environmentId: r.environment_id,
      collectionId: r.collection_id,
      itemPath: r.item_path,
      status: r.status,
      error: r.error,
      durationMs: r.duration_ms,
      sizeBytes: r.size_bytes,
    };
  }

  // ---- collections ---------------------------------------------------------------

  async function collectionsCollection(req: Request): Promise<Response> {
    if (req.method !== "POST") return apiError("method_not_allowed", "Use POST to create a collection.", { method: req.method }, 405);
    const body = await readJson(req);
    if (body === null) return apiError("bad_json", "The request body must be JSON with a \"name\" field.");
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "New collection";
    const j = body?.json ?? {
      info: {
        name,
        _postman_id: crypto.randomUUID(),
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        [TRUST_MARKER]: true,
      },
      item: [],
      variable: [],
    };
    const row = store.createCollection(name, JSON.stringify(j));
    return json({ id: row.id, name: row.name, json: JSON.parse(row.json), updatedAt: row.updated_at }, 201);
  }

  async function collectionById(req: Request, id: string): Promise<Response> {
    if (req.method === "PUT") {
      const body = await readJson(req);
      if (body === null) return apiError("bad_json", "The request body must be JSON with \"name\" and \"json\" fields.");
      if (!body?.json) return apiError("missing_json", "The update needs a \"json\" field holding the collection.");
      const row = store.updateCollection(id, String(body.name ?? "Collection"), JSON.stringify(body.json));
      if (!row) return apiError("not_found", "That collection no longer exists: refresh the list.", { id }, 404);
      return json({ id: row.id, name: row.name, json: JSON.parse(row.json), updatedAt: row.updated_at });
    }
    if (req.method === "DELETE") {
      if (!store.deleteCollection(id)) return apiError("not_found", "That collection no longer exists: refresh the list.", { id }, 404);
      return new Response(null, { status: 204 });
    }
    return apiError("method_not_allowed", "Use PUT to save or DELETE to remove a collection.", { method: req.method }, 405);
  }

  // ---- environments ----------------------------------------------------------------

  async function environmentsEnv(req: Request): Promise<Response> {
    if (req.method !== "POST") return apiError("method_not_allowed", "Use POST to create an environment.", { method: req.method }, 405);
    const body = await readJson(req);
    if (body === null) return apiError("bad_json", "The request body must be JSON with a \"name\" field.");
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "New environment";
    const j = body?.json ?? { name, values: [] };
    const row = store.createEnvironment(name, JSON.stringify(j));
    return json({ id: row.id, name: row.name, json: JSON.parse(row.json), updatedAt: row.updated_at }, 201);
  }

  async function environmentById(req: Request, id: string): Promise<Response> {
    if (req.method === "PUT") {
      const body = await readJson(req);
      if (body === null) return apiError("bad_json", "The request body must be JSON with \"name\" and \"json\" fields.");
      if (!body?.json) return apiError("missing_json", "The update needs a \"json\" field holding the environment.");
      const row = store.updateEnvironment(id, String(body.name ?? "Environment"), JSON.stringify(body.json));
      if (!row) return apiError("not_found", "That environment no longer exists: refresh the list.", { id }, 404);
      return json({ id: row.id, name: row.name, json: JSON.parse(row.json), updatedAt: row.updated_at });
    }
    if (req.method === "DELETE") {
      if (!store.deleteEnvironment(id)) return apiError("not_found", "That environment no longer exists: refresh the list.", { id }, 404);
      return new Response(null, { status: 204 });
    }
    return apiError("method_not_allowed", "Use PUT to save or DELETE to remove an environment.", { method: req.method }, 405);
  }

  // ---- secrets -----------------------------------------------------------------------

  async function secretsList(req: Request, url: URL): Promise<Response> {
    if (req.method !== "GET") return apiError("method_not_allowed", "Use GET to list secret metadata.", { method: req.method }, 405);
    const scope = url.searchParams.get("scope");
    const scopeId = url.searchParams.get("scopeId");
    if (scope && scope !== "collection" && scope !== "environment") {
      return apiError("bad_scope", "The scope must be \"collection\" or \"environment\".", { scope });
    }
    const rows = store.listSecrets(scope ? (scope as Scope) : undefined, scopeId ?? undefined);
    return json(
      rows.map((r) => ({
        name: r.name,
        scope: r.scope,
        scopeId: r.scopeId,
        has_value: r.has_value,
        updated_at: r.updated_at,
        last_used_at: r.last_used_at,
      }))
    );
  }

  /** The ONLY route that ever receives a secret value. Nothing reads one back. */
  async function secretValue(req: Request, scope: Scope, scopeId: string, name: string): Promise<Response> {
    if (scope !== "collection" && scope !== "environment") {
      return apiError("bad_scope", "The scope must be \"collection\" or \"environment\".", { scope }, 400);
    }
    if (req.method === "PUT") {
      const body = await readJson(req);
      if (body === null) return apiError("bad_json", "The request body must be JSON with a \"value\" field.");
      if (typeof body?.value !== "string" || body.value.length === 0) {
        return apiError("bad_value", "Give the secret a non-empty \"value\".");
      }
      const sealed = await sealSecret(masterKey, scope, scopeId, name, body.value);
      store.setSecret(scope, scopeId, name, sealed.ciphertext, sealed.nonce);
      return new Response(null, { status: 204 });
    }
    if (req.method === "DELETE") {
      if (!store.deleteSecret(scope, scopeId, name)) {
        return apiError("not_found", "There is no stored value for that secret: nothing to clear.", { name }, 404);
      }
      return new Response(null, { status: 204 });
    }
    return apiError("method_not_allowed", "Use PUT to set or DELETE to clear a secret value.", { method: req.method }, 405);
  }

  // ---- import / export -----------------------------------------------------------------

  async function importDoc(req: Request): Promise<Response> {
    if (req.method !== "POST") return apiError("method_not_allowed", "Use POST to import.", { method: req.method }, 405);
    const body = await readJson(req);
    if (body === null) return apiError("bad_json", "The request body must be JSON with \"kind\" and \"json\" fields.");
    const kind = body?.kind;
    const doc = body?.json;
    if (!doc || typeof doc !== "object") {
      return apiError("bad_json", "Give the imported document under \"json\".");
    }

    if (kind === "collection") {
      if (!doc.info || !Array.isArray(doc.item)) {
        return apiError("bad_collection", "That document does not look like a Postman v2.1 collection: it needs info and item fields.");
      }
      const slug = slugify(doc.info?.name ?? "collection");
      const { json: cleaned, report, secrets } = importCollection(doc, slug);
      cleaned.info ??= {};
      cleaned.info[TRUST_MARKER] = false;
      const row = store.createCollection(doc.info?.name ?? "Imported collection", JSON.stringify(cleaned));
      for (const s of secrets) {
        await putSecret("collection", row.id, s.name, s.value);
      }
      return json({
        id: row.id,
        name: row.name,
        moved: report.movedSecrets,
        warnings: report.warnings,
        runsScripts: collectionHasScripts(cleaned),
        trusted: false,
      }, 201);
    }

    if (kind === "environment") {
      if (!Array.isArray(doc.values) && !doc.name) {
        return apiError("bad_environment", "That document does not look like a Postman environment: it needs a values array.");
      }
      const { json: cleaned, report, secrets } = importEnvironment(doc);
      const row = store.createEnvironment(doc.name ?? "Imported environment", JSON.stringify(cleaned));
      for (const s of secrets) {
        await putSecret("environment", row.id, s.name, s.value);
      }
      return json({
        id: row.id,
        name: row.name,
        moved: report.movedSecrets.map((m) => ({ ...m, scope: "environment" as const })),
        warnings: report.warnings,
      }, 201);
    }

    return apiError("bad_kind", "The kind must be \"collection\" or \"environment\".", { kind });
  }

  async function putSecret(scope: Scope, scopeId: string, name: string, value: string) {
    const sealed = await sealSecret(masterKey, scope, scopeId, name, value);
    store.setSecret(scope, scopeId, name, sealed.ciphertext, sealed.nonce);
  }

  async function exportDoc(req: Request, kind: string, id: string): Promise<Response> {
    if (req.method !== "GET") return apiError("method_not_allowed", "Use GET to export.", { method: req.method }, 405);
    if (kind === "collection") {
      const row = store.getCollection(id);
      if (!row) return apiError("not_found", "That collection no longer exists: refresh the list.", { id }, 404);
      return new Response(row.json, {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${encodeURIComponent(row.name)}.postman_collection.json"`,
        },
      });
    }
    if (kind === "environment") {
      const row = store.getEnvironment(id);
      if (!row) return apiError("not_found", "That environment no longer exists: refresh the list.", { id }, 404);
      return new Response(row.json, {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${encodeURIComponent(row.name)}.postman_environment.json"`,
        },
      });
    }
    return apiError("bad_kind", "The kind must be \"collection\" or \"environment\".", { kind });
  }

  // ---- send -------------------------------------------------------------------------------

  async function send(req: Request): Promise<Response> {
    if (req.method !== "POST") return apiError("method_not_allowed", "Use POST to send a request.", { method: req.method }, 405);
    const body = await readJson(req);
    if (body === null) return apiError("bad_json", "The request body must be JSON with a collectionId and itemPath.");
    const { collectionId, environmentId, requestJson } = body ?? {};
    const colRow = collectionId ? store.getCollection(collectionId) : null;
    if (!colRow) {
      return apiError("collection_not_found", "Pick a collection before sending: the request needs one to resolve variables from.", undefined, 400);
    }
    const envRow = environmentId ? store.getEnvironment(environmentId) : null;
    if (environmentId && !envRow) {
      return apiError("environment_not_found", "That environment no longer exists: pick another one.", { environmentId }, 400);
    }
    const collectionJson = JSON.parse(colRow.json);
    // The browser sends its edited request; if it matches an item path in the
    // collection we resolve through the stored copy so auth inheritance works.
    const itemPath: string = typeof body?.itemPath === "string" ? body.itemPath : "";
    const requestJsonToUse = requestJson ?? findRequestJson(collectionJson, itemPath);
    if (!requestJsonToUse && !itemPath) {
      return apiError("missing_request", "Give the request to send under \"requestJson\" or an \"itemPath\" into the collection.");
    }

    const secretsInScope = [
      ...store.listSecrets("collection", collectionId).map((s) => ({ scope: "collection" as Scope, scopeId: collectionId, name: s.name })),
      ...(envRow ? store.listSecrets("environment", envRow.id).map((s) => ({ scope: "environment" as Scope, scopeId: envRow.id, name: s.name })) : []),
    ];

    const result = await performSend(store, masterKey, {
      collectionJson,
      collectionId,
      environmentJson: envRow ? JSON.parse(envRow.json) : null,
      environmentId,
      itemPath,
      secretsInScope,
      externalSignal: req.signal,
    }, policy);

    // History stores the UNRESOLVED request plus the environment id — never a
    // resolved copy, so no secret value can reach it.
    store.addHistory({
      at: new Date().toISOString(),
      request_json: JSON.stringify({
        collectionId,
        collectionName: colRow.name,
        itemPath,
        request: requestJsonToUse,
        name: requestJsonToUse?.name ?? colRow.name,
      }),
      environment_id: environmentId,
      collection_id: collectionId,
      item_path: itemPath,
      status: result.status,
      error: result.error?.code ?? null,
      duration_ms: result.durationMs,
      size_bytes: result.sizeBytes,
    });

    // Pre-request script failures and sandbox crashes are 4xx house errors.
    const status = scriptFailureStatus(result);
    return json(result, status);
  }
}

function scriptFailureStatus(result: SendOutput): number {
  if (!result.error) return 200;
  if (
    result.error.code === "prerequest_failed" ||
    result.error.code === "script_sandbox_crashed" ||
    result.error.code === "script_origin_refused"
  ) {
    return 400;
  }
  return 200;
}

// ---- shared helpers -------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function readJson(req: Request): Promise<any | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function findRequestJson(collectionJson: any, itemPath: string): any | null {
  const parts = itemPath.split("/").filter(Boolean);
  let group = collectionJson;
  for (const part of parts) {
    if (!group?.item) return null;
    const next = (group.item as any[]).find((i: any) => i?.name === part);
    if (!next) return null;
    group = next;
  }
  return group?.request ? group : null;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "collection";
}

export { assertNotProductionOverride };
