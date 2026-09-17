# Changelog

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
