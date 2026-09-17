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

## Scripts

Collections, folders and requests can carry Postman v2.1 scripts: an `event`
array with `listen: "prerequest"` or `"test"` and a `script.exec` list of
lines. On every send they run on the server, in inheritance order
(collection → folder(s) → request), inside a QuickJS WebAssembly sandbox: a
fresh runtime per phase, a 64 MB memory cap, a 5 second wall-clock limit per
phase (10 seconds per send), and no `fetch`, `require`, `process` or `Bun`
inside. A sandbox crash kills a worker process, never the server, and the
send answers `script_sandbox_crashed`.

**The trust model.** Every collection carries a `x-ffwd-scripts-trusted`
marker in its `info`. Collections you create in the app start **trusted**;
imported collections start **untrusted**, and the UI warns you on import.
Trusted scripts may read secret values, change variables and secrets
permanently, and send to any host; every secret read or write is logged
server-side (names only, never values). Turn this on only for collections you
wrote or have read — the UI's switch says the same. Untrusted scripts:
- `get` of a secret-typed name returns `undefined` (with a console note);
- variable and secret writes apply to **this send only** and are reported in
  the send response as `variablesChanged` with `persisted: false`;
- the request's origin (scheme + host + port) cannot change — headers, path,
  query and body may still be mutated.

**The `pm` surface** mirrors Postman: `pm.variables` (local, this send),
`pm.collectionVariables`, `pm.environment`, `pm.globals` (mapped to the
collection scope — this app has no workspace scope), `pm.secrets.set/has`
(writes the encrypted secret store; there is no `pm.secrets.get` — use the
scope objects), `pm.request` (method, url object, headers, body; mutations
apply to this send only), `pm.response` and `pm.response.to` in test scripts,
`pm.test`, a chai-compatible `pm.expect` subset, `pm.info`,
`pm.variables.replaceIn`, and `console.log/info/warn/error` (capped). `pm.crypto`
offers `sha256`, `md5`, `hmacSha256`, `base64`, `randomUUID`; `require("crypto-js")`
returns a shim with `SHA256`, `MD5`, `HmacSHA256` and the `enc` encoders;
`require` of anything else throws. `btoa`/`atob` and a synchronous
`setTimeout` shim exist. `postman.setNextRequest` and `pm.sendRequest` throw
a "not supported in this version" error naming what to do instead. A `pm.test`
returning a promise is recorded as failed ("async tests are not supported
yet").

**Secrets rule.** On the server a trusted script may `get` a secret's value
(signing a request needs it). Everything the scripts produce on the way back
to the browser — console lines, test names and messages, error messages —
goes through the same hiding engine as every other output, plus any secret a
script read or wrote. A script cannot write a secret's value into a plain
variable: the write is refused with a named error.

**What is not supported yet:** async tests, `pm.sendRequest` (scripts cannot
send their own requests), `postman.setNextRequest` (no collection runner),
iteration data, and folder-level script editing in the UI (folder scripts
still run; edit them in the collection JSON).

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
