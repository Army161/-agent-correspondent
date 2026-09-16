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

The economic router (`packages/core/src/router`) maps a request to a rail:

| Shape | Route |
| --- | --- |
| tiny, recurring, same counterparty | μLedger obligation, settled next cycle |
| sub-cent, synchronous | x402 / Circle nanopayment |
| dollar-scale or asynchronous or evaluated | ERC-8183 escrow |
| cross-currency or cross-network | XRPL payment / pathfinding |

Thresholds are configuration, not opinions expressed at the call site:

```ts
nanopaymentCeiling:    $0.01
escrowFloor:           $1.00
ledgerAccrualCeiling:  $0.001
```

The router enumerates every structurally valid route, discards the ones whose
primitives are not verified live, orders the survivors by configured preference,
and returns the winner **plus the rejected routes and why**. Routing logic never
lives in a React component.

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
