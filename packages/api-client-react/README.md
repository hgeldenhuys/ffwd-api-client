# @ffwd/api-client-react

The ffwd API client UI as an embeddable React 19 component. Three panes
(collections tree / request editor / response), Postman v2.1 import and export,
and server-held secret variables — all rendered inside whatever box the host
gives it. No route, no page chrome, no sign-in of its own.

## Install

```bash
bun add @ffwd/api-client-react @ffwd/api-client-server
```

```tsx
import { ApiClient } from "@ffwd/api-client-react";
import "@ffwd/api-client-react/styles.css"; // exactly once, at the host root

<ApiClient apiBase="/api/ffwd" className="h-screen" />
```

## Install & mount

```bash
bun add @ffwd/api-client-react
```

```tsx
import { ApiClient } from "@ffwd/api-client-react";
import "@ffwd/api-client-react/styles.css"; // exactly once, at the host root

<ApiClient
  apiBase="/api/ffwd"          // must match the server handler's basePath
  className="h-screen"              // the host sizes it; the component fills its box (min-height 480px)
  onUnauthorized={() => navigate("/sign-in")}  // host redirects to its own sign-in
/>
```

The host must pair this with `@ffwd/api-client-server`'s handler mounted at
the same `apiBase` (see that package's README). Render a `<Toaster />` from
`sonner` once at the host root — every failed fetch reports itself through it.

## Props

| Prop | Type | What |
|---|---|---|
| `apiBase` | `string` | Prefix for every fetch. Default `/api/ffwd`. |
| `className` | `string` | Extra classes on the component root (size it here). |
| `onUnauthorized` | `() => void` | Called on any 401 so the host can redirect. |
| `urlState` | `"query" \| "none" \| UrlStateAdapter` | Where the selection (collection / request / environment / tabs) lives. Default `"query"`: the URL query string, so reload restores the view and Back/Forward move between requests. `"none"` keeps selection in memory. |

### URL state

Grammar: `?c=<collectionId>&r=<request path, "/"-joined, URL-encoded>&e=<environmentId>&side=collections|envs|history&tab=params|headers|body|auth|vars` — all optional.
Selection changes push a history entry; tab-only changes replace. Unknown ids degrade to
the empty state with a toast. A React Router 7 host passes its own binding:

```tsx
import { ApiClient, reactRouterUrlState } from "@ffwd/api-client-react";
const [sp, setSp] = useSearchParams();
<ApiClient urlState={reactRouterUrlState(sp, setSp)} />
```

Any host store works by implementing `UrlStateAdapter`:
`{ read(): URLSearchParams; write(next, mode: "push" | "replace"): void; subscribe(cb): () => void }`.

## Exported sub-components

`TokenInput` (the `{{variable}}`-highlighting input), `VariablesTable` (the
secret-aware variables editor), `Sidebar`, `RequestEditor`, `ResponsePane` —
plus the shared types (`CollectionMeta`, `SendResult`, …) and helpers
(`classifyTokens`, `relativeTime`, `formatBytes`). `Button`, `Input` and
`Label` are re-exported for hosts that want matching form chrome.

## Styling

`@ffwd/api-client-react/styles.css` is a compiled Tailwind v4 layer whose
every rule lives under `.ffwd-api-client` (or the package's own Radix-portal
container), so it cannot restyle the host. Light/dark tokens follow the `.dark` class
wherever the host puts it (typically `<html class="dark">`), and also apply under
`prefers-color-scheme: dark` for hosts with no theme switch.
CodeMirror (the body editor / pretty viewer) is `React.lazy` — SSR hosts never
import it on the server.

## Peer dependencies

`react` and `react-dom` (>= 19). Everything else is a package dependency.
