# Sentinel-5

The security control plane: the sequence every economic authorization is
checked against, and the containment tools that respond when one fails.

## The five layers

`packages/core/src/sentinel/index.ts` — pure, deterministic, tested without a
database.

```
IDENTITY       Is the caller who they say they are?
AUTHORIZATION  Are they entitled to touch this resource at all?
MANDATE        Is this spend inside the agent's economic policy?
BOUNDS         Is this execution inside the signed authorization's limits?
ANOMALY        Does this look like this account's normal behaviour?
```

Evaluated in order. **Any layer can deny; the first non-ALLOW result stops
the evaluation.** A request refused at IDENTITY is never told what MANDATE
would have said — that would be a free oracle for someone probing.

MANDATE and BOUNDS are not reimplemented by Sentinel-5. They are the existing
mandate engine (`packages/core/src/mandate/`) and bounds checker
(`packages/core/src/bounds/`), which the relay already runs atomically with
signature verification. `evaluateSentinel` sequences them; it does not
duplicate them. See "Where it runs" below for how the pieces fit together.

ANOMALY is the only layer that returns **HOLD** rather than ALLOW or DENY. An
unusual payment is not a forbidden one, and a control that blocks legitimate
business gets switched off. Holding puts a person in the loop, which is the
actual goal.

## Why a language model is never a layer

Every rule in every layer is a comparison against a stated threshold — a
count, a boolean, a timestamp delta. A model can explain a decision
afterwards. It cannot make one. `AnomalyFacts` are counts a person can check
against a database row, never a model-derived "risk score" — a score nobody
can point at evidence for is not something anyone can audit, argue with, or
tune.

## Anomaly rules, in the order checked

1. **Mandate widened in the last hour** (`MANDATE_RECENTLY_WIDENED`) — the
   single most valuable sequence to an attacker holding a stolen session:
   raise your own ceiling, then drain it. Only a *widening* of any limit
   counts; a narrowed mandate is not a signal.
2. **Payout wallet changed in the last hour** (`PAYOUT_RECENTLY_CHANGED`) —
   redirect where the money goes, then send it.
3. **Spend spike** (`SPEND_SPIKE`) — more than 10× the largest spend this
   agent has made in the last 30 days. An account with no history is not
   compared against anything: everything is a spike relative to nothing, and
   holding every first payment would make the control useless.
4. **Authorization velocity** (`AUTHORIZATION_VELOCITY`) — more than 60
   authorizations in the last hour.
5. **Counterparty fan-out** (`COUNTERPARTY_FANOUT`) — more than 10 distinct
   counterparties in the last hour.
6. A first payment to an unregistered counterparty is **noted, not held**
   (`NEW_UNVERIFIED_COUNTERPARTY`, outcome `ALLOW`): most legitimate first
   payments look exactly like this, and the mandate's own
   unverified-counterparty limit already bounds them.

Only the most serious matching rule fires — a held request needs one clear
reason, not five. Thresholds are `SentinelThresholds`, round numbers an
operator can argue with; an untunable threshold gets switched off the first
time it is inconvenient.

## Where it runs

`apps/web/src/lib/security/evaluate.ts` — `preCheckIntent()`, called from
`POST /api/v1/intents/submit` **before** the relay is touched.

It answers IDENTITY (the caller already authenticated to reach the route),
AUTHORIZATION (a kill switch, provider quarantine, resource ownership, and
identity verification — see docs/IDENTITY_VERIFICATION.md), and ANOMALY
(real sensors, below) itself. MANDATE and BOUNDS pass through as
"not yet evaluated" placeholders so the sequence can still reach ANOMALY; the
`relay.submit()` call immediately afterward is what actually enforces them,
atomically with signature verification, exactly as it did before Sentinel-5
existed.

A request Sentinel-5 holds or denies **never reaches the relay**: no nonce is
burned, no intent is recorded. Verified end-to-end against live Postgres: an
agent-scoped kill switch refuses submission with `KILL_SWITCH_ENGAGED`
before compiling or signing means anything, and disengaging it lets the
*relay's own* economic checks run — which then refuse on their own merits
(an unfunded μLedger position), proving nothing was silently bypassed while
the switch was engaged.

A relay denial whose code looks like an active forgery attempt
(`SIGNATURE_INVALID`, `SIGNER_MISMATCH`, `DESTINATION_SUBSTITUTION`, a nonce
reused, a chain/contract/domain mismatch) gets the same incident treatment as
a Sentinel-5 hold. A routine mandate-limit refusal does not — that is normal
traffic, not evidence.

## Sensors

`apps/web/src/lib/security/sensors.ts` — every `AnomalyFacts` field read
straight from `economic_intents`, `economic_mandates`, `agent_wallets` and
`transactions`. No field is inferred or estimated.

- **Mandate widening** compares the two most recent mandate versions
  (mandates are append-only; a new policy is a new version, never an edit —
  see docs/ECONOMIC_MANDATES.md) and only fires if a limit actually grew.
- **Payout change** is the most recent `createdAt` among verified wallets on
  the intent's network (wallets require proof of control — see
  docs/WALLET_SECURITY.md — so an unverified binding cannot itself trigger
  this).
- **Velocity / fan-out** count `economic_intents` rows in the last hour for
  the buyer agent.
- **Spend spike** compares against the largest valued `OUT` transaction in
  the last 30 days.

## Kill switches

`apps/web/src/lib/security/kill-switches.ts` — `packages/db` `kill_switch_events`.

State is a **log, not a flag**: the most recent ENGAGE/DISENGAGE event for a
`(scope, target)` pair is the current state. That makes containment
reversible by construction (disengaging is a new row, never an edit) and
means there is exactly one place this can ever disagree with itself. The
table is append-only by database trigger — UPDATE and DELETE are refused —
so the history itself cannot be edited even by something with a raw
connection.

| Scope | Target | Who may engage |
| --- | --- | --- |
| `AGENT` | an agent id | That agent's own organization — self-service |
| `WALLET` | `agentId:network:address` | That wallet's own organization — self-service |
| `RAIL` | a network id (`ARC`, `XRPL`, …) | A platform operator only |
| `GLOBAL` | none | A platform operator only |
| `PROVIDER` | a provider id | A platform operator only |

Self-service AGENT/WALLET freezing is deliberate: a customer who suspects
their own agent is compromised should not have to wait for an operator to
stop it. `POST /api/v1/security/kill-switch` requires a **fresh session** — a
stolen cookie must not be enough to disengage containment any more than it
should be enough to move money — and an org can only ever name its own
agents and wallets (`resolveOwnedWalletTarget` confirms ownership before
resolving a WALLET target; an unowned agent id gets the same 404 a
nonexistent one would).

**Per-wallet execution freeze** reaches into the relay itself:
`authorizeSigner` checks the WALLET switch for the bound wallet a signature
matched, and `lookupProvider` checks it for the resolved payout address — a
frozen payout wallet is "not payable", exactly like one that was never
configured, never "pick a different wallet instead."

An unreadable kill-switch log fails **toward containment**, not away from
it: `killSwitchState()` returns `engaged: true` on a database error, because
a deployment that cannot confirm nothing is wrong must not proceed as if
nothing were.

### Platform operators

`apps/web/src/lib/security/operators.ts` — `PLATFORM_OPERATOR_EMAILS`, an
exact allowlist read from configuration. This codebase has no general RBAC;
every user is simply the owner of their own organization, which is correct
for tenant isolation but wrong for an action that affects every tenant at
once. Without the variable configured, **nobody** — including whoever owns
the first organization ever created — can engage a platform-wide switch.

## Provider quarantine

`apps/web/src/lib/security/quarantine.ts` — `provider_quarantines`, operator-only.

Narrower than a kill switch in mechanism, same effect in practice: a
provider whose API has started returning suspicious data is still
"AVAILABLE" by every live health probe. Quarantine says "AVAILABLE, and also
do not use it" independent of what the probe reports. Wired into the same
pre-check that reads kill switches: a quarantined rail's provider (`arc` for
`ARC`/`ARC_TESTNET`, `xrpl` for `XRPL`/`XRPL_TESTNET`; `MULEDGER` has no
external provider and cannot be quarantined) is refused identically to an
engaged RAIL kill switch.

An unreadable quarantine table also fails toward "quarantined" — the same
fail-closed direction as the kill switch.

## Incidents

`apps/web/src/lib/security/incidents.ts` — `security_incidents`, append-only
by trigger.

Opened automatically whenever `evaluateSentinel` returns anything but ALLOW.
`evidence` is the **entire decision** — every layer, in the order evaluated —
frozen at write time; nothing about what Sentinel-5 actually saw can be
edited after the fact. `status` moves forward only: `OPEN` → `CONTAINED` →
`RESOLVED`, enforced by the trigger as well as in application code.

Severity (`severityFor`) is a plain mapping from outcome and code:

| Signal | Severity |
| --- | --- |
| Mandate-widened or payout-changed anomaly | `CRITICAL` |
| A BOUNDS denial (a signed authorization exceeded), or a spend spike | `HIGH` |
| Velocity, fan-out, or a HOLD at MANDATE | `MEDIUM` |
| Everything else (routine IDENTITY/AUTHORIZATION denials) | `LOW` |

### Automatic containment

A `CRITICAL` incident automatically engages an **AGENT**-scope kill switch
for the agent the request was about — nothing broader. This is reversible by
construction (it is the same kill-switch log everything else uses) and
requires an authenticated, fresh-session call to
`POST /api/v1/security/kill-switch` to lift, which is exactly the deliberate
human decision this is meant to force before more money moves. Recorded on
the incident's `containmentActions` via `recordContainment()`.

Nothing here does anything irreversible automatically. There is no
auto-response that revokes a session, deletes data, or reaches outside this
deployment.

### Revoking a principal

`apps/web/src/lib/security/containment.ts` — `revokePrincipal()`. Deliberately
**not** automatic. When an incident's evidence points at a specific stolen
credential rather than a compromised agent, the fastest real remedy is
ending that credential's ability to authenticate at all — but unlike an
agent kill switch, revoking a session or an API key is not reversible (a
burned cookie does not come back), and an automated response that revokes a
legitimate user's session on a false positive would itself be a harmful
automated action. It exists as a tool an operator can reach for; nothing
calls it on Sentinel-5's own initiative.

## Evidence and audit

Every kill-switch action, incident status change, quarantine action, and
principal revocation is written to `audit_logs` (also append-only) in
addition to its own table, via the existing `recordAudit()` used everywhere
else in this codebase. There is no separate event-bus infrastructure: this
is one Postgres-backed application, not a distributed system, and a message
queue between two calls in the same process would be complexity without a
buyer. The audit log and the incidents table together *are* the event
record — queryable, append-only, and already exercised by every other
security-relevant action in the product.

## What Sentinel-5 does not do

- **No hack-back.** Containment is refusing, holding, freezing and telling
  somebody. Nothing here probes, retaliates against, or reaches outside
  infrastructure this deployment owns.
- **No LLM in the loop.** No chat tool can engage or disengage a kill switch,
  open or resolve an incident, or quarantine a provider. Every endpoint in
  this document requires an authenticated human session.
- **No automatic irreversible action.** The one automated response
  (auto-containing a CRITICAL agent) is reversible by the same mechanism a
  human uses, and nothing automated ever revokes a credential, merges code,
  or deploys anything.
- **Not wired into the capability manifest yet.** Quarantine currently gates
  intent submission; it does not yet suppress a quarantined provider's status
  on the public manifest (docs/CAPABILITY_MANIFEST.md). No real provider is
  configured in this deployment, so this has not been exercised beyond unit
  and e2e coverage.

## Fixing a finding in this repository

Distinct from containing a live incident against a deployed instance: when a
security finding is about this *codebase* (a dependency vulnerability, a bug
in one of the controls above), the fix is committed to the designated
development branch, tested, and pushed for human review — never merged or
deployed automatically. No tool in this repository, and no capability
described anywhere in this document, opens or merges a pull request, or
deploys anything. That is a property of how this session operates throughout,
not a feature specific to Sentinel-5.

## Verification

`packages/core/test/sentinel.test.ts` — 17 tests: the ordering guarantee (a
denial at one layer reveals nothing about later layers), the kill-switch
check firing before ownership is even asked about, hold-vs-deny for every
layer, and each anomaly rule in isolation plus the "most serious rule wins"
and "layer five never denies" properties.

`e2e/sentinel.spec.ts` — 7 tests against live Postgres: self-service
freeze/unfreeze, a frozen agent's submission refused before the relay is
touched and the incident it produces, cross-organization isolation (a
wallet-owning attack surface a probing org cannot reach), the operator
allowlist gating both RAIL kill switches and provider quarantine, and that
disengaging restores relay-governed refusal rather than blanket approval.

Trigger behaviour (append-only on both new tables, forward-only incident
status) verified directly against live Postgres.
