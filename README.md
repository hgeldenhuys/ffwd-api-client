# ffwd API client

A browser-hosted API client that speaks Postman collections: import a v2.1
collection or environment, edit and send requests, and read the response in a
three-pane UI. Secret variables are set once over HTTPS and live on the
server, so a shared workspace never pastes a credential into a browser. The
UI is an embeddable React component and the backend is a plain fetch-function
handler, so you mount both inside your own app rather than deploy ours.

## 60-second quickstart

```bash
bun add @ffwd/api-client-react @ffwd/api-client-server
```

Mount the handler on any fetch-based router (React Router 7 / Remix 3 /
Bun.serve / Hono all work — the handler takes a standard `Request` and
returns a `Response`):

```ts
import { createApiClientHandler, SqliteStore, accessKeyAuth } from "@ffwd/api-client-server";

const handler = createApiClientHandler({
  store: new SqliteStore("./data/ffwd.sqlite"),
  masterKey: process.env.SECRETS_MASTER_KEY!,   // base64, 32 bytes: openssl rand -base64 32
  basePath: "/api/ffwd",
  auth: accessKeyAuth({ key: process.env.APP_ACCESS_KEY!, masterKey: process.env.SECRETS_MASTER_KEY! }),
});
```

Render the component and import its stylesheet once at the host root:

```tsx
import { ApiClient } from "@ffwd/api-client-react";
import "@ffwd/api-client-react/styles.css";

<ApiClient apiBase="/api/ffwd" className="h-screen" />
```

The server refuses to start without `APP_ACCESS_KEY` and
`SECRETS_MASTER_KEY`; set both before launching:

```bash
export APP_ACCESS_KEY="$(openssl rand -base64 24)"
export SECRETS_MASTER_KEY="$(openssl rand -base64 32)"
```

## Secret variables

A secret is a named value scoped to a collection or an environment. You set
it once with a PUT over HTTPS; it is AES-256-GCM encrypted with your master
key before it touches storage. When a request that references
`{{the_secret}}` is sent, the value is substituted server-side and then
hidden — raw, URL-encoded, JSON-escaped, base64, base64url and hex forms —
from the request preview, response headers, bodies, error messages and
history. No route ever returns a value; export never contains one; history
stores only the unresolved request. Delete the secret and the value is gone.

## Proxy policy

Sends go through the server rather than straight from the browser, so the
server can enforce one policy on every request: private and loopback targets
are refused (production never allows overrides), non-canonical IP literals
are refused, redirects are re-checked hop by hop up to a small limit, and
responses are capped in bytes and time. The policy exists so a stored
collection cannot be turned into a tunnel into your network.

## URL grammar

`?c=<collectionId>&r=<request path, "/"-joined, URL-encoded>&e=<environmentId>&side=collections|envs|history&tab=params|headers|body|auth|vars` — all
optional. Selection changes push a history entry; tab-only changes replace.
Unknown ids degrade to the empty state. `"none"` or your own
`UrlStateAdapter` are accepted instead.

## Extension points

- **`Store`** — collections, environments, secrets (ciphertext crosses this
  interface only) and history. `SqliteStore` (bun:sqlite, single file) is
  included; implement the interface for any other database.
- **`AuthFn`** — `(req) => { ok: true; principal } | { ok: false; response? }`.
  `accessKeyAuth` (HMAC-signed session cookie + `x-echo-key` header) and
  `anyOf(...)` composition are included; bring your own for anything else.
- **`storeFromEnv()`** — picks a store from the environment and logs its
  choice; the core only knows SQLite.

## Hosts

The same handler and component run unchanged in Bun, Hono, React Router 7
and Remix 3's fetch router; `examples/hono-host` is a complete small host.
For a Store and sign-in that are durable across container redeploys on the
Kapable platform, use the adapter package `@ffwd/api-client-kapable`.

## Status

0.1.0. Known residual: the proxy policy's DNS rebinding window — Bun's fetch
cannot pin a resolved IP, so a hostname that changes address between the
policy check and the connect is checked once, not twice. The platform
adapter's SSO was verified against a faked exchange endpoint, not a live
platform.
