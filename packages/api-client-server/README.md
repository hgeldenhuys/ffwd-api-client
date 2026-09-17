# @ffwd/api-client-server

The server core of the ffwd API client as one embeddable package: Postman
v2.1 import/export, server-held secret variables (encrypted at rest, hidden
in every response and in history), and an SSRF proxy policy on the send path.
No React, no DOM, no React Router — the handler is a plain fetch function you
can mount on anything.

## Install

```bash
bun add @ffwd/api-client-react @ffwd/api-client-server
```

## The handler

```ts
import { createApiClientHandler, SqliteStore, accessKeyAuth } from "@ffwd/api-client-server";

const handler = createApiClientHandler({
  store: new SqliteStore("./data/ffwd.sqlite"), // or your own Store implementation
  masterKey: process.env.SECRETS_MASTER_KEY!,        // base64, 32 bytes: openssl rand -base64 32
  basePath: "/api/ffwd",                             // default
  auth: accessKeyAuth({ key: process.env.APP_ACCESS_KEY!, masterKey: process.env.SECRETS_MASTER_KEY! }),
  policy: { allowPrivateTargets: false, timeoutMs: 30_000, maxBytes: 10 * 1024 * 1024 },
});
```

`auth` is your gate: `(req) => Promise<AuthResult>` where `AuthResult` is
`{ ok: true; principal: string } | { ok: false; response?: Response }`. When
`ok` is false and no `response` is given, the handler answers 401 with the
house error shape. `accessKeyAuth` (HMAC-signed session cookie, or an
`x-echo-key` header so a proxied send can reach a mounted `/_echo`) and
`anyOf(...)` composition are provided; bring your own `AuthFn` for anything
else.

## Routes (all under `basePath`, default `/api/ffwd`)

| Method | Path | What |
|---|---|---|
| GET | `/state` | Collections + environments (secret values blank) |
| POST | `/collections` | Create |
| PUT/DELETE | `/collections/:id` | Save / delete |
| POST | `/environments` | Create |
| PUT/DELETE | `/environments/:id` | Save / delete |
| GET | `/secrets?scope=&scopeId=` | Secret **metadata only** — no route returns a value |
| PUT/DELETE | `/secrets/:scope/:scopeId/:name` | Set (value encrypted at rest) / clear |
| POST | `/import` | Import a v2.1 collection or environment; secret values move into the store |
| GET | `/export/:kind/:id` | Export as v2.1 JSON (never contains a secret value) |
| POST | `/send` | Resolve + send through the proxy policy; response carries hidden secret references |
| GET | `/history`, `/history/:id` | Last 200 sends (unresolved requests only) |
| ANY | `/_echo` | Test echo endpoint, behind the same auth |

## Mounting

**React Router 7 resource route** (the reference host does exactly this):

```ts
// app/routes/api.$.ts
import { createApiClientHandler, SqliteStore, accessKeyAuth } from "@ffwd/api-client-server";

const handler = createApiClientHandler({ /* opts */ });

// @ts-expect-error — React Router types its args; a plain Request works
export const loader = ({ request }) => handler(request);
export const action = ({ request }) => handler(request);
```

with `route("/api/*", "routes/api.$.ts")` in `app/routes.ts` (or the file name
`api.$` inside `app/routes`, which React Router picks up automatically).

**Bun.serve:**

```ts
Bun.serve({ port: 3000, fetch: handler });
```

**Hono:**

```ts
import { Hono } from "hono";
const app = new Hono();
app.all("/api/ffwd/*", (c) => handler(c.req.raw));
export default app;
```

**Remix 3 fetch-router** (written from the Fetch contract; Remix 3 is beta and
was not installed here):

```ts
import { createRequestHandler } from "@remix-run/node-fetch-server"; // beta naming may differ
import { fetchRouter } from "remix";                                  // beta

const router = fetchRouter();
router.all("/api/ffwd/*", (request: Request) => handler(request));
// hand `router.fetch` (a (Request) => Response | Promise<Response>) to whatever
// serves your app — the handler only needs a standard Request in, Response out.
```

## Storage

`SqliteStore` (bun:sqlite, single file, WAL) is included, and
`storeFromEnv()` reads `DATA_DIR` and logs its choice. Any host on another
database implements the `Store` interface — exactly the methods the handler
calls: collections, environments, secrets (ciphertext crosses this interface
only), and history. See `dist/index.d.ts` for `Store`. For a store that
survives a container redeploy on a platform host, see the adapter package
listed in the root README's Hosts section.

## Secrets contract

- The value-setting route (`PUT /secrets/...`) is the only route that ever
  receives a value; nothing reads one back.
- Values are AES-256-GCM sealed with your `masterKey` before they touch the
  store; name + scope are bound as AAD.
- On send, values are substituted server-side and hidden (raw, URL-encoded,
  JSON-escaped, base64, base64url, hex, `\uXXXX`) in the resolved request
  preview, response headers, text bodies, error messages, and history.
- Export never contains a value.
