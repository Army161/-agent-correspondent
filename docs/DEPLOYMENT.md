# Deployment

## Requirements

- Node.js ≥ 22.12
- pnpm 10
- PostgreSQL 14+

## Local development

```bash
pnpm install
createdb agent_correspondent
export DATABASE_URL="postgres://user@localhost:5432/agent_correspondent"
pnpm --filter @acor/db exec drizzle-kit migrate
pnpm dev
```

The application runs with nothing else configured. Every unconfigured surface
reports `NOT CONNECTED` or `AWAITING DATA` rather than showing a placeholder
number — that is deliberate, and it is tested.

## Environment

### Core

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `AUTH_SECRET` | yes | session signing |
| `ACOR_ENV` | no | `production` enables production-only guards |
| `NEXT_PUBLIC_SITE_URL` | no | canonical URL for SEO |

Without `DATABASE_URL` the platform still serves, but authentication and every
data surface report that they are not connected.

### Model providers

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic models |
| `OPENAI_API_KEY` | OpenAI models |

At least one is required for the chat surface. Without either, the chat input is
disabled and says why.

### Settlement

See [ARC.md](./ARC.md) and [XRPL.md](./XRPL.md) for the full list. Nothing is
required; each unconfigured rail reports `NOT_CONFIGURED`.

```
ARC_RPC_URL  ARC_USDC_ADDRESS  ARC_ERC8004_ADDRESS  ARC_ERC8183_ADDRESS
ARC_INTENT_VERIFIER_ADDRESS  ARC_CHAIN_ID  ARC_NETWORK
CIRCLE_API_KEY  CIRCLE_ENTITY_SECRET  CIRCLE_WALLET_SET_ID
XRPL_WS_URL  XRPL_NETWORK  XRPL_RLUSD_ISSUER  XRPL_SOURCE_TAG
KALEIDO_BASE_URL  KALEIDO_API_KEY
BLOCKDAG_RPC_URL
NEXT_PUBLIC_ACOR_CONTRACT_ADDRESS
```

### Network separation

`ACOR_ENV=production` combined with `ARC_NETWORK=testnet` or
`XRPL_NETWORK=testnet` is a hard configuration error, surfaced on `/developers`
and in `/api/health`. Testnet addresses are never reused in production; they are
separate variables, not the same variable with a flag.

## Migrations

```bash
pnpm --filter @acor/db exec drizzle-kit generate   # after a schema change
pnpm --filter @acor/db exec drizzle-kit migrate    # apply
```

`0001_append_only.sql` installs the triggers that make the financial tables
append-only. It is not optional: without it, append-only is a convention rather
than a control.

## Build and verify

```bash
pnpm lint
pnpm typecheck
pnpm test          # unit suite; see FINAL_REPORT.md for the current count
pnpm build
pnpm e2e           # Playwright, desktop and mobile
```

Run the e2e suite twice — once with `DATABASE_URL` set and once without — to
exercise both the working path and the honest unconfigured path. The suite skips
the group that does not apply to the deployment it finds.

## Health

`GET /api/health` returns `READY` only when the database is connected and there
are no configuration errors; otherwise `DEGRADED` with a 503 and a per-service
breakdown. `GET /api/v1/network/capabilities` probes the rails live.

## Production notes

- Deploy behind a gateway that provides rate limiting; the application does not
  implement it.
- Serve over HTTPS. Session cookies are `secure` in production and will not be
  stored over plain HTTP.
- Keep `AUTH_SECRET` and all rail credentials server-side; none is exposed to
  the browser.
- Back up Postgres. The financial tables are append-only by design, so
  point-in-time recovery is the only way back from an operational mistake.
