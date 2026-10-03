# Threat model

What this system protects, from whom, across which boundaries, and — for each
threat — the control, where it is tested, and what is still open. Controls
are named by file so a reviewer can check the claim rather than trust it.
Companion documents: [SECURITY.md](./SECURITY.md) (control inventory),
[SENTINEL_5.md](./SENTINEL_5.md) (runtime containment),
[RUNBOOKS.md](./RUNBOOKS.md) (what to do when something happens).

## Assets

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| Authority to spend | The whole product is bounded delegation of it | Signed `EconomicIntent`s + mandates |
| Mandates | Define what an agent may spend | `economic_mandates` (versioned, never edited) |
| Ledger truth | Who owes whom; receipts; reputation | `muledger_entries`, `economic_receipts`, `transactions`, `reputation_events` (append-only by trigger) |
| Session cookies and API keys | Act as an organization | `auth_sessions`, `api_keys` (keys stored as SHA-256 only) |
| Credential issuing key | Makes statements about agents that counterparties trust | `CREDENTIAL_ISSUER_KEY` (env) |
| Webhook signing secrets | Let integrators trust our deliveries | `webhooks.secret_ciphertext` (AES-256-GCM under `WEBHOOK_ENCRYPTION_KEY`) |
| Tenant isolation | One organization must never see or act on another's data | `organization_id` on every economic row |
| Evidence | Incidents and audit records must survive the attacker | `security_incidents`, `kill_switch_events`, `audit_logs` (append-only) |

**Not an asset here, by design:** private keys and seed phrases. No column
holds key material; signing happens in the user's wallet or a custody
provider. Compromising this deployment does not yield the ability to sign a
payment.

## Actors

- **External attacker** — no account; reaches public endpoints only.
- **Malicious tenant** — a legitimate account trying to reach another tenant.
- **Credential thief** — holds a stolen session cookie or API key.
- **Hijacked model** — the agent's language model under prompt injection
  (from a document, a provider response, a chat message).
- **Malicious counterparty** — a provider agent or provider API returning
  hostile data, rotating payout addresses, or inflating prices.
- **Insider with database access** — can run SQL against Postgres directly.
- **Compromised platform operator** — on `PLATFORM_OPERATOR_EMAILS`.

## Trust boundaries

1. **Browser / API client → route handler.** Everything is untrusted; bodies
   are Zod-validated, every economic route authenticates and scopes by
   organization.
2. **Language model → tools.** The model is treated as an attacker-controlled
   process. Its tools (`apps/web/src/lib/ai/tools.ts`) are read-only or
   compile-only.
3. **Wallet signature → relay.** The relay accepts an intent only with a valid
   signature from a wallet bound by proof of control, and re-checks mandate,
   bounds, nonce and Sentinel-5 at execution.
4. **App → Postgres.** Append-only and state-transition rules are enforced by
   triggers, so they hold even against application bugs.
5. **App → external providers / receivers.** Rails, Paddle, webhook
   receivers, Sentry. Outbound data is minimized; inbound webhooks are
   signature- and replay-checked.

## Threats, by actor

### Hijacked model

| Threat | Control | Tested | Open |
| --- | --- | --- | --- |
| Model is talked into paying an attacker | No tool can move money; payment requires a wallet signature over typed data a human sees | `SECURITY.md` "central property"; tool surface | — |
| Model drafts an intent paying the wrong party | Destination, asset, network and amount are bound into the signed intent; relay re-checks the payout address | `bounds.test.ts`, `relay.test.ts` | Depends on the human reading what they sign |
| Runaway tool loop | `stopWhen: stepCountIs(6)` | — | Cost, not money |

### Credential thief

| Threat | Control | Tested | Open |
| --- | --- | --- | --- |
| Stolen API key mints a backup key | Keys issue only from a fresh signed-in session, never from a key | `api-keys.spec.ts` ("a key cannot mint another key") | — |
| Stolen key keeps working after discovery | Revocation (session, or the key itself) takes effect on the next request | `api-keys.spec.ts` | No scopes: a key is full org access |
| Stolen cookie lifts containment | Kill-switch and key issuance require a **fresh** session | `sentinel.spec.ts`, `api-keys.spec.ts` | Freshness window is a time bound, not proof of presence |
| Stolen cookie spends | Spending needs a wallet signature, which a cookie does not give | relay tests | — |
| Credential leaks into error tracker | Errors report path only, never query string (reset/OAuth tokens live there) | `instrumentation.test.ts` | — |

### Malicious tenant

| Threat | Control | Tested | Open |
| --- | --- | --- | --- |
| Read or act on another org's agents, jobs, credentials, webhooks, keys | Every query scoped by `organization_id`; unowned ids answer 404, same as nonexistent | `product.spec.ts`, `credentials.spec.ts`, `wallets.spec.ts`, `webhooks.spec.ts`, `api-keys.spec.ts`, `sentinel.spec.ts` | No database row-level security; isolation is application-enforced |
| Freeze another org's agent | Ownership checked before any kill switch | `sentinel.spec.ts` | — |
| Bind someone else's wallet | Challenge/response signature proof, replay- and cross-agent-protected | `wallets.spec.ts` | — |
| Exhaust plan limits server-side | Agent limits enforced in the route, not the form | `billing.spec.ts` | No general API rate limiting (auth routes only) |

### Malicious counterparty

| Threat | Control | Tested | Open |
| --- | --- | --- | --- |
| Provider rotates payout address after signing | Authorization invalidated; buyer must re-sign | `relay.test.ts` | — |
| Price or fee inflation | `maxSpend`, `maxNetworkFee`, quote age, slippage bounds | `bounds.test.ts` | — |
| Funding one job twice with one intent | Intent consumed atomically inside the job's transaction | `jobs.spec.ts` | — |
| Under-funded job | Intent must cover the quoted price | `jobs.spec.ts` | — |
| Reputation farming | Counterparty diversity weighting | `settlement.test.ts` | Sybil resistance is weighting, not identity |
| Hostile provider API | Operator quarantine; anomaly sensors | `sentinel.spec.ts` | Evaluator attestations not cryptographically verified |

### External attacker

| Threat | Control | Tested | Open |
| --- | --- | --- | --- |
| Forged billing webhook | HMAC signature + timestamp freshness + replay table | `billing.test.ts`, `billing.spec.ts` | — |
| Forged credential | Ed25519 verification against the published key; revocation list public | `credentials.spec.ts` | Issuer key rotation is not supported (see RUNBOOKS) |
| Brute-force sign-in | Auth rate limiting (`AUTH_RATE_LIMIT_*`) | — | Other routes have no app-level rate limit; deploy behind a gateway |
| CSRF on JSON routes | `sameSite=lax` cookies + JSON bodies | — | No explicit Origin check on mutating routes |
| SSRF via webhook URLs | Host resolved and every address must be public (loopback, RFC 1918, link-local incl. `169.254.169.254`, CGNAT, multicast, IPv6 equivalents and IPv4-mapped/NAT64 forms refused), checked at subscription **and** before each delivery; redirects not followed; `https:` required when `ACOR_ENV=production` | `target.test.ts` (38 cases) | DNS rebinding within one TTL — see below |

### Insider with database access

| Threat | Control | Tested | Open |
| --- | --- | --- | --- |
| Edit a receipt, ledger amount, incident evidence, kill-switch history | Triggers raise `restrict_violation` on UPDATE/DELETE | Verified against live Postgres (`FINAL_REPORT.md`) | A superuser can drop triggers; detect via audit of DDL, not prevented |
| Read webhook secrets | Ciphertext only; key is outside the database | `crypto.test.ts` | An attacker with both DB and env has everything |
| Read API keys / sessions | Hashes only | — | — |

### Compromised operator

| Threat | Control | Tested | Open |
| --- | --- | --- | --- |
| Engage GLOBAL/RAIL switch to halt the platform | Operator allowlist; every action audited and reversible | `sentinel.spec.ts` | Denial of service is possible by design — that is what the switch is |
| Use operator access to move money | Operators have no spend path; switches only ever refuse | — | — |

## Residual risk worth knowing about

**DNS rebinding on webhook delivery.** The webhook target check
(`apps/web/src/lib/webhooks/target.ts`) resolves the host immediately before
each delivery and refuses non-public addresses, and redirects are not
followed. A hostile DNS server can still answer the check with a public
address and the connection, moments later, with a private one. Closing that
fully means pinning the checked address into the connection (a custom
connect-time `lookup`), which needs an HTTP client dependency this app does
not have. The impact is bounded — the request body is ours, the response body
is discarded, and only a status code is recorded — but an operator running
inside a network with sensitive unauthenticated internal services should
treat outbound webhooks as able to reach them, and egress-filter the app.

`WEBHOOK_ALLOW_PRIVATE_TARGETS=true` disables the address check for local
development and CI (whose tests deliver to `127.0.0.1`). It is ignored when
`ACOR_ENV=production`, and must never be set on a deployment that serves
tenants.

## Out of scope

Compromise of a user's own wallet or device; compromise of Vercel, GitHub or
the database provider; legal/regulatory threats; physical attacks. These are
real, but no control in this repository addresses them.
