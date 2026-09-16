# Settlement

The settlement plane is a set of adapters behind one interface
(`packages/adapters/src/types.ts`). The economic router chooses between them
without knowing anything about their internals.

## Adapter contract

```ts
interface SettlementAdapter {
  name: string;
  networks: readonly string[];
  health(capabilities): Promise<AdapterHealth>;
  balances(address, assets): Promise<Outcome<BalanceReading[]>>;
  settle(request): Promise<Outcome<SettlementResult>>;
}
```

Two rules hold for every adapter:

1. **An adapter never decides whether a payment is allowed.** It receives an
   authorization the mandate engine and the bounds enforcer already approved,
   and re-checks the bounds immediately before submitting. Between those two
   checks the world can move, and that is the last moment at which refusing is
   free.
2. **An adapter with missing credentials reports `NOT_CONFIGURED`.** It never
   falls back to a simulation and never returns a fabricated balance or
   transaction hash.

## Routing

The rule that shapes the router: **a payment can only be made from money that is
already on the rail making it.**

XRPL pathfinding converts and routes assets that are already on XRPL; it cannot
debit an Arc wallet. An Arc contract cannot reach an XRPL account. Two
independent ledgers have no shared commit, so presenting a movement between them
as one atomic payment is not a routing decision — it is a false statement about
settlement risk.

Three facts go in, and they are kept apart:

| Input | Meaning |
| --- | --- |
| `payout` | what the provider must receive, in which asset, on which network |
| `inventory` | what is actually held, per network and per asset, right now |
| capabilities | which primitives have been verified live |

Every candidate route names the asset it must be funded from, and that asset is
always on the same network as the payment. There is deliberately no candidate
whose funding network differs from its payout network.

| Shape | Route |
| --- | --- |
| tiny, recurring, same counterparty | μLedger obligation — nothing moves, so no inventory is needed |
| sub-cent, synchronous, funded on Arc | x402 / Circle nanopayment |
| dollar-scale or asynchronous or evaluated, funded on Arc | ERC-8183 escrow |
| same asset, funded on XRPL | XRPL payment |
| different asset, **both on XRPL** | XRPL pathfinding, which converts in one transaction |
| funded on Arc, payout on XRPL | **no route** — see rebalancing |

Size thresholds are configuration, not opinions expressed at the call site:

```
nanopaymentCeilingUsd:   $0.01
escrowFloorUsd:          $1.00
ledgerAccrualCeilingUsd: $0.001
```

An asset with no registered peg has no known size band, so the size-banded rails
are not offered for it. The mandate engine is what refuses an unvaluable spend;
the router only shapes the route.

### Inventory

Only **unreserved** inventory can fund a payment. `reserved` is what is already
committed to in-flight payments or escrow; ignoring it is how a treasury
double-spends one balance across two concurrent routes.

When no rail can fund a payout, the router reports `INSUFFICIENT_INVENTORY` with
the shortfall **in the asset that is short** — and it computes that shortfall
independently of which check bound first, so an operator sees the inventory gap
even when a capability was also missing.

### Rebalancing

A rebalance moves inventory from one rail to another so a future payment becomes
possible. It is **never part of a payment**:

```ts
interface RebalanceProposal {
  from: { network, assetId };
  to: { network, assetId };
  amount: AssetAmount;
  mechanism: "CIRCLE_GATEWAY" | "MANUAL_TREASURY_TRANSFER" | "EXTERNAL_BRIDGE";
  atomicWithPayment: false;   // always, and stated rather than implied
  rationale: string;
}
```

It has its own confirmation, its own failure modes and its own audit record, and
the payment it unlocks cannot be attempted until it has settled.

**Circle Gateway is offered only when the capability is live *and* the runtime
configuration lists both networks as supported.** That list
(`gatewaySupportedNetworks`) is empty until it has been read from Circle. USDC
existing on a chain is not evidence that Gateway covers it, and assuming
coverage is how a payment gets routed into a bridge that does not exist.

## Capability gating

Every network primitive has an explicit state: `AVAILABLE`, `DISABLED`,
`TESTNET_ONLY`, `EXPERIMENTAL` or `UNKNOWN`.

`UNKNOWN` is treated exactly like `DISABLED`. Executing against a primitive that
is not actually live is how you lose a payment into a transaction that can never
be claimed, so nothing that depends on a live check ships as `AVAILABLE`. Only a
successful probe moves it.

`TESTNET_ONLY` is refused in production. `EXPERIMENTAL` requires an explicit
opt-in (`ACOR_ALLOW_EXPERIMENTAL=1`).

## Execution bounds

Before any submission, `enforceBounds` compares the plan against the signed
authorization:

- total spend ≤ `maxSpend`
- provider receives ≥ `minReceive`
- network fee ≤ `maxNetworkFee`
- the parts reconcile to the whole (nobody is taking an undeclared cut)
- asset, network, destination and rail all match exactly
- FX drift from the quote is within `maxFxSlippageBps`
- the quote is not stale
- the authorization has not expired

Any violation means do not execute. There is no "close enough", no override
flag, and no path that asks the model to decide.

## Settlement idempotency

A settlement carries an idempotency key, and the `settlements` table has a
unique index on it. Separately, `transactions` is uniquely indexed on
`(network, reference)` and `economic_receipts` on
`(network, transaction_reference)`: one settlement reference produces one
receipt, at the database level.

## Current status

| Adapter | Status | What completing it requires |
| --- | --- | --- |
| Arc | reads and probes implemented; submission prepared, not broadcast | a deployed intent verifier and a signing path |
| Circle | credential check and balance reads implemented | the entity-secret signing path |
| XRPL | balance reads and amendment probing implemented | a funded, key-bearing account |
| Kaleido | boundary only | an enterprise engagement |
| BlockDAG | boundary only; refuses stable-value settlement by design | — |

No adapter in this repository broadcasts a transaction, because this process
holds no signing authority — see [SECURITY.md](./SECURITY.md).
