# Runbooks

What to do when something goes wrong, using only controls that exist in this
repository. Where a procedure is missing, it says so — an operator mid-incident
needs to know what they cannot do as much as what they can.

**Principles.** Contain first, investigate second. Containment here is
reversible by construction (kill switches and quarantine are append-only logs;
lifting one is a new event, never an edit). Revoking a credential is **not**
reversible — do it when you are sure which credential leaked. Nothing in this
system retaliates or reaches outside the deployment; neither should you.

Actions that need a **fresh sign-in** (kill switches, issuing API keys) fail
with 401 if the session is older than the step-up window — sign out and back
in, then retry.

## Tenant runbooks (any organization owner)

### An agent is behaving unexpectedly or may be compromised

1. **Freeze it.** Agents → the agent → *Containment* → enter a reason →
   **Freeze agent**. Every intent the agent submits is refused before the
   relay is touched, and the refusal opens an incident.
2. **Look at what it tried.** `GET /api/v1/security/incidents` lists
   incidents with the full Sentinel-5 decision frozen as evidence; the
   Activity page shows the audit trail.
3. **Remove what it could use.** If an API key may have leaked, revoke it
   (below). If a wallet may be compromised, freeze that wallet too:
   ```js
   // signed in, from the browser console on the app's origin
   await fetch("/api/v1/security/kill-switch", { method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ scope: "WALLET", target: "<agentId>:<network>:<address>",
       action: "ENGAGE", reason: "suspected key compromise" }) });
   ```
   There is no wallet-freeze button yet; this is the API the agent page uses.
4. **Record the outcome.** `POST /api/v1/security/incidents`
   `{ "incidentId": "...", "status": "CONTAINED" | "RESOLVED", "note": "..." }`.
   Status only moves forward.
5. **Unfreeze** from the same panel once resolved.

A `CRITICAL` incident (mandate widened or payout changed just before a spend)
freezes the agent **automatically**. Unfreezing it is the same deliberate step.

### A group of agents (a convoy) needs stopping at once

`POST /api/v1/convoys/:id/freeze` `{ "action": "FREEZE", "reason": "..." }`
engages an AGENT switch for every member; `UNFREEZE` lifts them.

### An API key leaked

- Developers → *API keys* → **Revoke**. Effective on the next request.
- If you only have the key (not a session), it can revoke itself:
  `curl -X DELETE -H "authorization: Bearer $KEY" https://<host>/api/v1/api-keys/<keyId>`.
- A key cannot mint new keys, so revoking the leaked one leaves no backup
  behind. Check the audit trail for what it did while live.

### A session may be stolen

Settings → Security → revoke the session, or sign out all other sessions;
then change the password. A stolen cookie alone cannot spend (spending needs a
wallet signature), lift a freeze, or issue API keys (both need a fresh
sign-in) — but it can read your organization's data until revoked.

### A webhook signing secret leaked

`DELETE /api/v1/webhooks/:id`, then create a new subscription; the new secret
is shown once. Deliveries signed with the old secret stop immediately. Delivery
history stays in `webhook_delivery_attempts`.

## Operator runbooks (`PLATFORM_OPERATOR_EMAILS` only)

There is no operator UI; these are API calls from a signed-in operator
session.

### A rail or provider is misbehaving

- **Stop a rail:** `POST /api/v1/security/kill-switch`
  `{ "scope": "RAIL", "target": "ARC" | "XRPL" | ..., "action": "ENGAGE", "reason": "..." }`.
- **Distrust a provider whose health probe still says AVAILABLE:**
  `POST /api/v1/security/quarantine` `{ "providerId": "arc", "action": "QUARANTINE", "reason": "..." }`;
  `"LIFT"` to reverse.
- **Stop everything:** scope `GLOBAL`, no target. Use when you cannot tell
  what is safe. Every tenant is affected; every action is audited.

### A tenant reports a cross-tenant incident

**Gap:** operators cannot act on a single tenant's agents, wallets or
credentials. AGENT and WALLET switches are ownership-checked for every caller,
operators included, and there is no operator route to revoke another
organization's keys or sessions. The options are:

- ask the tenant to freeze the agent and revoke keys (their runbooks above);
- if money is at risk and the tenant cannot be reached, engage a `RAIL`
  switch for the rail involved, or `GLOBAL` — broad, but reversible and
  audited.

A narrowly-scoped operator freeze of one tenant's agent would close this; it
does not exist yet.

## Secret rotation

| Secret | Procedure | Consequence / gap |
| --- | --- | --- |
| `AUTH_SECRET` | Replace and redeploy | Expected to invalidate existing signed session cookies (all users sign in again); confirm in a preview deployment first |
| `CREDENTIAL_ISSUER_KEY` | Replace and redeploy; revoke outstanding credentials via the agent credentials API | **Gap:** one key, no key ids. Every credential issued under the old key stops verifying against the published key — and a verifier that pinned the old public key will still accept credentials forged with a stolen one. Treat issuer-key compromise as "reissue everything and notify verifiers" |
| `WEBHOOK_ENCRYPTION_KEY` | Replace and redeploy | **Gap:** no re-encryption path. Existing subscriptions' secrets become undecryptable and their deliveries fail (recorded in `webhook_delivery_attempts`). Every tenant must recreate subscriptions |
| `PADDLE_WEBHOOK_SECRET` | Rotate in Paddle and here together | Webhooks signed with the other secret are refused until both match |
| API keys, webhook secrets | Tenant-level; see above | — |

## Database

- **Migrations:** `DATABASE_URL=... pnpm --filter @acor/db migrate` applies the
  reviewed SQL in `packages/db/migrations` non-interactively. Never use
  `drizzle-kit push` against a shared database: it diffs live schema and can
  propose drops.
- **Mistakes are not undone by editing rows.** Receipts, ledger amounts,
  incidents, kill-switch history and the audit log reject UPDATE/DELETE by
  trigger. Corrections are new, compensating records. Recovery from a bad
  deploy is point-in-time restore — enable it before going live.
- **Do not disable triggers** to "fix" data. A superuser can; doing so destroys
  the evidentiary value of every append-only table.

## Before production

1. Run both e2e suites in the Node 22.12 / PostgreSQL 16 CI environment.
2. Set `ACOR_ENV=production` — this also makes webhook delivery require
   `https:` and ignores `WEBHOOK_ALLOW_PRIVATE_TARGETS`. Confirm that variable
   is **unset**.
3. Set `SENTRY_DSN` and confirm one event arrives (`docs/OBSERVABILITY.md`).
4. Enable point-in-time recovery on Postgres.
5. Put the app behind a gateway with rate limiting; only auth routes are
   limited in-app.
6. Egress-filter the app's network if it can reach sensitive internal
   services (webhook DNS-rebinding residual; `docs/THREAT_MODEL.md`).
7. Configure `PLATFORM_OPERATOR_EMAILS` deliberately — without it, nobody can
   engage a platform-wide switch.
