# Convoy Mode

A pooled budget and correlated-behaviour check across a group of an
organization's own agents — the security case a per-agent mandate cannot
cover on its own.

## The gap it closes

An attacker who has taken over several agents in one fleet can spread
authorizations across them to stay under each agent's own individual
velocity threshold while draining the fleet as a whole. Five agents each
authorizing five payments an hour is unremarkable member by member; the same
twenty-five authorizations from one fleet in one hour is not. Nothing that
looks at one agent at a time can catch that, by construction.

## Shape

```
packages/core/src/convoy/index.ts   Pool and velocity arithmetic. Pure.
apps/web/src/lib/convoy/index.ts    Storage, real sensors from the ledger.
packages/db → agent_convoys, agent_convoy_members
```

## A convoy

A named group with a **shared daily USD pool**, stated up front at creation.
Membership is **exclusive** — an agent belongs to at most one convoy,
enforced by a unique index on `agent_id` — so the pool an authorization draws
against is never ambiguous.

The pool is **in addition to, never instead of**, each member's own
individual mandate. Passing the convoy check exempts nothing else: the
agent's own mandate, Sentinel-5's per-agent anomaly layer, and the relay's
signature and bounds checks all still run.

## Two checks

`checkConvoy()` runs in `POST /api/v1/intents/submit`, after Sentinel-5's
five-layer pre-check allows and before the relay is touched — a request held
here burns no nonce and leaves no intent recorded, the same property the
kill switch has.

1. **Pool.** Sum every member's valued `OUT` transactions since UTC midnight;
   refuse if this candidate would exceed the pool limit
   (`CONVOY_POOL_EXCEEDED`). Verified end to end: a $0.01 pool refuses a
   $5.00 authorization from an agent whose own individual mandate would have
   allowed it many times over — the pool, not the mandate, is what is being
   tested.
2. **Combined velocity.** Authorizations and distinct counterparties across
   *every* member in the last hour, checked against the convoy's own
   thresholds (separately configurable from, and typically tighter relative
   to member count than, any single agent's) — `CONVOY_VELOCITY` /
   `CONVOY_FANOUT`.

Both are read from `economic_intents` and `transactions` the same way
Sentinel-5's per-agent sensors are: derived from the ledger on every check,
never a cached counter that could drift from it.

A held convoy check opens a security incident exactly like a Sentinel-5 hold,
through the same `openIncident()`.

## Freezing a convoy

`POST /api/v1/convoys/{id}/freeze` — `{ action: "FREEZE" | "UNFREEZE" }`.

Implemented as an **AGENT-scope kill switch engaged for every member**,
rather than a new kill-switch scope: each member's freeze stays
independently visible in the same kill-switch log everything else uses,
instead of a parallel mechanism a caller has to separately know to check.
Reversible the same way any AGENT kill switch is — a fresh-session call to
`/api/v1/security/kill-switch`, or `UNFREEZE` here, undoes it.

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/convoys` | Create, with `dailyPoolLimitUsd` |
| `GET /api/v1/convoys` | List, with current members |
| `POST /api/v1/convoys/{id}/members` | Add (409 if the agent already belongs to a convoy) |
| `DELETE /api/v1/convoys/{id}/members` | Remove |
| `POST /api/v1/convoys/{id}/freeze` | Freeze or unfreeze every member |

Every endpoint is organization-scoped through the same `authenticateRequest`
every other endpoint in this product uses; a convoy id from another
organization behaves as `NOT_FOUND`.

## Verification

`packages/core/test/convoy.test.ts` — 9 tests: pool arithmetic at the exact
boundary, an already-overspent pool clamped to zero remaining rather than
negative, a negative limit or candidate refused rather than guessed at, and
combined velocity/fan-out including the case that no single member would
have tripped its own threshold.

`e2e/convoy.spec.ts` — 10 tests against live Postgres: exclusive membership,
a real signed submission held by the pool (not the mandate) before the relay
is touched, that the pool is genuinely shared across two different agents,
membership removal and rejoin, and freezing a convoy engaging a kill switch
for each of its members.

## Not yet built

- A convoy-scoped identity credential (see docs/AGENT_CREDENTIALS.md) that
  would let a counterparty verify "this agent travels in a fleet with N
  others" without querying this platform.
- Per-convoy configuration of the velocity thresholds (currently a shared
  deployment default); the arithmetic in `packages/core` already takes them
  as parameters, so this is a storage and API change, not a design one.
