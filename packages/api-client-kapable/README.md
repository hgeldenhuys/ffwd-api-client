# @ffwd/api-client-kapable

The Kapable-platform adapter for the ffwd API client: the pieces that only
make sense when the host runs on Kapable. The core packages
(`@ffwd/api-client-server`, `@ffwd/api-client-react`) carry none of this.

- **`KapableDataStore`** — a durable `Store` for platform deploys, where a
  deploy replaces the container and its SQLite file. SQLite stays the local
  read model; every write ALSO goes through to the platform's data service,
  and on boot the local model is restored from the platform. A failed
  platform write never breaks a request: it is logged once, the local write
  still succeeds, and the row retries on the next boot or every 60 s.
  Secret rows cross the wire as ciphertext + nonce only. `store.ready` waits
  for the boot restore, `store.flush()` awaits in-flight write-throughs,
  `store.syncDirty()` retries failed pushes on demand.
- **`storeFromEnv()`** — `KapableDataStore` when `KAPABLE_ORG_KEY` is set,
  `SqliteStore` otherwise; logs which it chose and why.
- **`kapableSessionAuth()`** — Sign in with Kapable: the SSO start/callback
  routes, a backchannel token exchange, and an HMAC-signed app session
  cookie. Combine with the core's `accessKeyAuth` through `anyOf`.
- **`authFromEnv()`** — the SSO auth when the four SSO variables are set,
  `accessKeyAuth` otherwise.

## Install

```bash
bun add @ffwd/api-client-kapable @ffwd/api-client-server
```

## Environment variables

| Variable | Meaning |
|---|---|
| `KAPABLE_ORG_KEY` | Org API key (Bearer). Set → `KapableDataStore`. |
| `KAPABLE_API_BASE` | Data service base. Default `https://api.kapable.ai`. |
| `KAPABLE_TABLE` | Table name in the data service. Default `ffwd_store`. |
| `KAPABLE_AUTH_URL` | The org's auth base, `https://{org}.kapable.ai/auth`. |
| `KAPABLE_APP_SLUG` | The app's slug registered for SSO. |
| `APP_SSO_SECRET` | The app's SSO secret (backchannel exchange). |
| `PUBLIC_URL` | This app's public origin; the SSO callback is `${PUBLIC_URL}/auth/sso/callback`. |

`KapableDataStore` creates the table on boot (`POST /v1/tables`; 409 "already
exists" is the normal path) and never overwrites a local row that is newer
than the platform copy.

## Deploying on Kapable

The platform pipeline runs `bun install`, `bun run build`, then `bun run start`
(listening on `PORT`, default 3000). Set these environment variables on the app.

### Required

| Variable | Secret | What it is |
|---|---|---|
| `SECRETS_MASTER_KEY` | **secret** | base64, 32 bytes — encrypts secret values at rest. Generate with `openssl rand -base64 32`. |
| `KAPABLE_ORG_KEY` | **secret** | Org API key — turns on the durable `KapableDataStore` (write-through to kapable-data). Without it data is local to the container and lost on redeploy. |
| `NODE_ENV` | no | `production`. |

### Sign in with Kapable (set all four to enable SSO)

| Variable | Secret | What it is |
|---|---|---|
| `KAPABLE_AUTH_URL` | no | The org's auth base, `https://{org}.kapable.ai/auth`. |
| `KAPABLE_APP_SLUG` | no | The app's slug registered for SSO on the platform. |
| `APP_SSO_SECRET` | **secret** | The app's SSO secret from the platform (backchannel exchange). |
| `PUBLIC_URL` | no | This app's public origin, e.g. `https://apiclient.{org}.kapable.run`. The SSO callback is `${PUBLIC_URL}/auth/sso/callback`. |

### Optional

| Variable | Secret | What it is |
|---|---|---|
| `APP_ACCESS_KEY` | **secret** | Shared access key — always available as a sign-in fallback when SSO is on, and the only gate when it is off. |
| `DATA_DIR` | no | Where the SQLite read model lives (default `./data`). |

### Setting them

In the shape `~/.claude/skills/deploy-customer-app/scripts/app-env.sh <org> <app> KEY=VALUE --secret KEY`
expects (do not run from here):

```
app-env.sh <org> apiclient \
  NODE_ENV=production \
  KAPABLE_AUTH_URL=https://<org>.kapable.ai/auth \
  KAPABLE_APP_SLUG=<slug> \
  PUBLIC_URL=https://apiclient.<org>.kapable.run \
  DATA_DIR=./data \
  --secret SECRETS_MASTER_KEY \
  --secret KAPABLE_ORG_KEY \
  --secret APP_SSO_SECRET \
  --secret APP_ACCESS_KEY
```

Secrets (`SECRETS_MASTER_KEY`, `KAPABLE_ORG_KEY`, `APP_SSO_SECRET`, `APP_ACCESS_KEY`)
must go through the `--secret` arm; everything else is a plain env var.
