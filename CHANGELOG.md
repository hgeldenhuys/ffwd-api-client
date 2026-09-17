# Changelog

## 0.2.0

Build 7 — Postman-style scripts and a visible Export.

- **Scripts on send.** Collections, folders and requests carry Postman v2.1
  `event` scripts (`prerequest` and `test`); they run on the server at send
  time in order collection → folder(s) → request, in a QuickJS WebAssembly
  sandbox (one fresh runtime per phase: 64 MB memory cap, 5 s wall-clock
  interrupt per phase, 10 s per send, console capped at 200 lines / 64 KB).
  `fetch`, `require`, `process` and `Bun` do not exist inside. The sandbox
  runs in one long-lived Bun `Worker` per process; a crash kills the worker,
  never the server, and the send answers a house error.
- **The `pm` bridge.** Variables (local, collection, environment, globals,
  secrets), request mutation for the current send, response assertions, a
  chai-compatible `pm.expect` subset, `pm.test`, console capture, `pm.crypto`
  (sha256 / md5 / hmacSha256 / base64 / randomUUID), a `crypto-js` require
  shim, `btoa`/`atob`, and `pm.variables.replaceIn`. `postman.setNextRequest`
  and `pm.sendRequest` throw a named "not supported in this version" error.
- **Trust model.** Collections carry `x-ffwd-scripts-trusted` in their info
  (created in the app: true; imported: false). Untrusted scripts cannot read
  secret values, cannot persist variable or secret writes, and cannot change
  the request origin. Trusted scripts can; every secret read or write is
  logged host-side without values. Writes are persisted after the send and
  reported to the UI in `scripts.variablesChanged`.
- **Hiding.** Everything a script phase returns (console, test names and
  messages, errors) is hidden like every other output: raw, URL-encoded,
  JSON-escaped, base64, base64url and hex forms of every secret used, read or
  written in the send.
- **Editor UI.** Pre-request and Tests tabs on requests and the collection
  view (CodeMirror JavaScript, snippet inserters), Tests and Console tabs in
  the response pane, test summaries on the Send toast, and a one-time warning
  toast when a collection with scripts is imported.
- **Export.** An Export dialog listing collections and environments with
  Download buttons; Export… entries in each row's ⋯ menu; environments export
  with secret values blank and `type: "secret"`.
- All three packages bump to 0.2.0.

## 0.1.0

First public release.

- `@ffwd/api-client-server` — a fetch-function API handler mountable on any
  fetch-based router: Postman v2.1 collection/environment import and export,
  server-held secret variables (AES-256-GCM at rest, substituted
  server-side on send and hidden in previews, responses, errors, history and
  export), an SSRF proxy policy (private-target refusal, redirect re-checks,
  size and time caps), request history (last 200, unresolved only), an
  `SqliteStore`, an HMAC access-key auth with `anyOf` composition, and
  startup environment validation.
- `@ffwd/api-client-react` — the three-pane client UI (collections tree,
  request editor, response pane) as an embeddable React 19 component with a
  self-scoped stylesheet, Postman import/export, secret-aware variable
  editing, URL-based selection state, and a sign-in redirect hook.
- a third adapter package for platform hosting: a durable write-through
  `Store` and platform SSO sign-in (see that package's README).
- `examples/hono-host` — a complete minimal host on Hono.
