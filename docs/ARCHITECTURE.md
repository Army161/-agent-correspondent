# Architecture

Agent Correspondent is one TypeScript monorepo with a hard internal boundary:
**the model reasons; deterministic code decides.**

That boundary is the security model. A language model can propose a payment,
rank providers, or draft an intent. It cannot authorize a spend, because no
function it can reach authorizes one.

```
apps/web          Next.js app: chat, agents, jobs, wallets, clearing, API
packages/core     the economic kernel — pure, deterministic, dependency-light
packages/db       Drizzle schema over Postgres, append-only where it matters
packages/adapters the settlement plane: Arc, Circle, XRPL, Kaleido, BlockDAG
```

`@acor/core` has one runtime dependency (Zod) and performs no I/O. It is
consumed as TypeScript source through `transpilePackages`, so there is exactly
one copy of the economic logic and no build step between changing a rule and
seeing it enforced.

## The four planes

### Intelligence plane

Agent reasoning, chat, provider selection, reputation, risk and policy
*presentation*. Lives in `apps/web/src/lib/ai` and the chat surface.

The tool surface handed to the model (`lib/ai/tools.ts`) is read-only or
compile-only: discover providers, rank them, test a spend against a mandate,
compile a signable intent, read the ledger. Nothing on the other side of that
file moves money. A prompt injection that fully captures the model still cannot
cause a payment.

### Intent plane

`EconomicIntent`, quotes, negotiation, signed authorization, deadlines, nonces,
cancellation, spending bounds. Lives in `packages/core/src/intent`,
`.../bounds` and `.../relay`.

An intent is the unit of authorization: everything the executor may do is inside
the struct, and anything not stated is forbidden.

### Settlement plane

`packages/adapters`. One interface per rail — Arc, Circle, XRPL, and the
optional Kaleido and BlockDAG boundaries. Two rules hold for every adapter:

1. An adapter never decides whether a payment is allowed. It receives an
   authorization the mandate engine and bounds enforcer already approved, and
   re-checks the bounds immediately before submitting.
2. An adapter with missing credentials reports `NOT_CONFIGURED`. It never falls
   back to a simulation and never returns a fabricated balance or hash.

### Clearing plane

`packages/core/src/muledger`. The μLedger, bilateral netting (P0), multilateral
netting (P1), clearing cycles with reproducibility proofs, and the receipt and
reputation derivation built on top.

## Request path for a spend

```
user or agent states an intent in language
        │
        ▼
model proposes  ─────────────►  deterministic tools (read/compile only)
        │
        ▼
procurement ranks providers on effective cost
        │
        ▼
mandate engine        ALLOW / REQUIRE_HUMAN_APPROVAL / DENY
        │                              │
        ▼                              └──► refusal, recorded in the audit log
intent compiled → EIP-712 typed data → signed by a human or a key-holding agent
        │
        ▼
relay: signature, expiry, nonce, provider state, mandate — all re-checked
        │
        ▼
router: counterparty, mechanism, network, rail, asset, FX route, timing
        │
        ▼
capability engine: is this primitive verified live?   (UNKNOWN == DISABLED)
        │
        ▼
bounds enforcer: does the plan match the authorization, exactly?
        │
        ▼
adapter submits ──► receipt (immutable) ──► reputation ──► μLedger ──► clearing
```

Every arrow after "model proposes" is deterministic code. The model is not
consulted again.

## Data and money representation

Two types, kept separate on purpose — see [MONEY_MODEL.md](./MONEY_MODEL.md).

**`AssetAmount`** is a quantity of one asset: an integer of that asset's
smallest unit, carrying its own symbol, network, scale and issuer. One XRP is
1,000,000 drops. Floats never touch it.

**`UsdValue`** is an opinion about an `AssetAmount` at a point in time, from a
named source. It exists only when a registered peg policy or a live price says
so. There is no path from a quantity to a dollar figure that does not go through
one of those two, which is what stops one XRP from being recorded as one dollar.

USD limits — mandates, reporting — remain integer **nanodollars** (1 USD = 1e9).
In Postgres an amount is stored as `(atomic, asset_id, decimals)` and a
valuation as `(usd_nanos, usd_source, usd_as_of)`; database triggers reject an
insert missing either triple.

Conversion between scales is explicit and, by default, **exact**: if an
authorized amount cannot be represented in USDC's six decimals, compilation
fails rather than rounding the user's money in either direction.

## Determinism

The kernel is pure and total. Given the same inputs it produces the same
decision, with no I/O and no model call. This is what makes the system
auditable: a clearing cycle can be recomputed from its ledger entries, a
routing decision can be replayed during an incident, and an intent hash means
the same thing on two machines.

Canonical serialization (`packages/core/src/canonical`) is deliberately narrow:
sorted keys, no whitespace, bigints as decimal strings, and an outright
rejection of floats, non-finite numbers and cycles. A non-integer number in a
canonical document is a bug, so it raises rather than serializing.

## Testing

- `packages/core/test` — 176 unit tests, most written as attacks (see
  [SECURITY.md](./SECURITY.md)).
- `e2e/` — Playwright against a real build, run twice: once against a
  configured deployment with a live Postgres, and once against a deployment
  with nothing configured, to prove both the working path and the honest
  "NOT CONNECTED" path.
