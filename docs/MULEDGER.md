# The μLedger

The μLedger is double-entry accounting for obligations too small to be worth a
transaction.

**It is not a cryptocurrency, not a stablecoin, and not transferable.** It is
accounting infrastructure.

## Why it exists

A forty-nanodollar API call — $0.00000004 — costs more in gas than it is worth.
Without somewhere to record it, that obligation either does not get recorded
(and the provider works for free) or it gets rounded up to something settleable
(and the buyer overpays). The μLedger records it exactly, and settlement happens
later, in aggregate, once the netted position is worth moving.

## Units

One US dollar is `1_000_000_000` internal units. Every amount is a `bigint`; no
float touches an obligation. In Postgres the column is `numeric(38, 0)`.

## Invariants

1. **Append-only.** Entries are never edited or deleted. State changes are
   forward-only transitions (`OPEN → NETTED → SETTLED`) with an audit trail,
   enforced by a database trigger, not by convention.
2. **Reproducible.** Every settlement can be recomputed from the immutable
   entries that produced it. A clearing run that cannot be re-derived is not a
   clearing run — it is an unexplained movement of money.
3. **Conservation.** With no settlements, the sum of every agent's net position
   is exactly zero. `verifyConservation()` asserts it; a non-zero total means an
   entry was created or mutated outside `append`.
4. **No double credit.** Every entry carries an idempotency key naming the
   economic event behind it. A provider that submits the same completed job
   twice, or a webhook that fires twice, produces one obligation.

## Entry shape

```
entryId  debtor  creditor  amount  asset  service
intentId  receiptId  createdAt  state  idempotencyKey  cycleId?
```

Amounts are always positive: direction lives in debtor/creditor, never in the
sign. An agent cannot owe itself.

## Netting

### Bilateral (P0)

Between any two agents, offsetting obligations cancel and a single net transfer
remains.

```
A owes B $0.07
B owes A $0.05
─────────────────
NET: A owes B $0.02
```

Two transfers become one, and it is smaller.

### Multilateral (P1)

Across a whole cycle, only each agent's net position matters. The transfer set
that realises those positions can be much smaller than the bilateral set,
because money does not need to be routed around a cycle that nets to nothing:

```
A → B $1, B → C $1, C → A $1
bilateral:      3 transfers, $3 moved
multilateral:   0 transfers, $0 moved
```

The multilateral result settles every agent to exactly the same net position as
the bilateral result. The test suite asserts this equivalence rather than
trusting it.

Multilateral netting is implemented and tested, and registered as
`EXPERIMENTAL` in the capability engine: it is not used for live settlement
until it has been exercised against a real rail.

## Reproducibility proof

Each cycle carries a `proofHash`: a canonical hash over its inputs (the entry
ids) and its outputs (the settlement instructions). `verifyCycle` performs two
independent checks:

1. Does the cycle commit to its own contents? Editing a settlement instruction
   after the fact — redirecting a payout, say — leaves the stored proof hash
   describing the instructions that *were* there.
2. Do the ledger entries still produce this cycle when replayed?

Both must pass. The first check exists because the second alone does not catch
an edited instruction list, which is exactly the tampering that would matter.

The hash is order-independent: a ledger built in a different insertion order
produces the same cycle and the same proof.

## Observed behaviour

Against a live Postgres, five obligations between three agents:

```
GROSS  $0.12800004      5 entries
NET    $0.02000004      2 transfers
84.37% of gross avoided, 3 fewer transfers
```

including a 40-nanodollar obligation that survives the whole pipeline at full
precision and appears in the UI as `$0.00000004`, not as `$0.00`.
