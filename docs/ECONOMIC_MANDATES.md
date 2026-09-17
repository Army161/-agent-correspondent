# Economic mandates

An economic mandate is the deterministic financial policy for one agent. It is
authored by a human, stored server-side, and evaluated by pure code. The
language model that operates the agent can read its mandate and has no path to
change it.

Every spend in the platform passes through `evaluateMandate` before it reaches a
rail.

## Schema

```json
{
  "dailySpendLimitUsd": 100,
  "maxTransactionUsd": 5,
  "minimumReserveUsd": 20,
  "unverifiedCounterpartyLimitUsd": 0.05,
  "humanApprovalAboveUsd": 50,
  "creditAllowed": false,
  "tokenTradingAllowed": false,
  "allowedAssets": ["USDC", "RLUSD"],
  "allowedNetworks": ["ARC", "XRPL"]
}
```

Limits are decimal strings or numbers on the wire and exact nanodollar integers
inside the system. Both allowlists must be non-empty: a mandate has to be
explicit about what it permits.

Mandate limits are **dollar figures**, because that is how an operator reasons
about them. A spend arrives denominated in an asset, so it must be valued before
it can be tested — and a spend that cannot be valued cannot be checked, so it is
denied. See [MONEY_MODEL.md](./MONEY_MODEL.md).

## Rules, in evaluation order

| Rule | Denies when |
| --- | --- |
| `amount.positive` | the amount is zero or negative |
| `asset.allowed` | the asset is not in `allowedAssets` |
| `network.allowed` | the network is not in `allowedNetworks` |
| `transaction.max` | the amount exceeds `maxTransactionUsd` |
| `daily.limit` | today's spend plus this one exceeds `dailySpendLimitUsd` |
| `reserve.floor` | the remaining balance would fall below `minimumReserveUsd`, unless `creditAllowed` is true |
| `counterparty.unverifiedLimit` | the counterparty is unverified and the amount exceeds `unverifiedCounterpartyLimitUsd` |
| `credit.allowed` | the spend incurs credit and `creditAllowed` is false |
| `tokenTrading.allowed` | the spend is a token trade and `tokenTradingAllowed` is false |
| `human.approval` | the amount exceeds `humanApprovalAboveUsd` and no approval is attached |

The decision is `ALLOW`, `REQUIRE_HUMAN_APPROVAL`, or `DENY`, and it carries the
full rule trace — every check, passed or failed, with its limit and the observed
value — for the audit log and the UI.

`DENY` takes precedence over `REQUIRE_HUMAN_APPROVAL`. A human approval flag
never rescues a spend that violates a hard limit: approving a $500 payment does
not raise a $5 per-transaction ceiling.

## The reserve floor and credit

Dipping below `minimumReserveUsd` is taking on credit, by definition — the
agent would be spending money it was told to keep in reserve. A mandate with
`creditAllowed: false` denies it, exactly like any other hard limit. A mandate
with `creditAllowed: true` permits it, and only it: `creditAllowed` does not
relax `dailySpendLimitUsd`, `maxTransactionUsd`, or any other rule, each of
which is still checked and can still deny the same spend on its own terms.

This is why `creditAllowed` exists at all, not just as a label on
`request.incursCredit` (which is a separate, agent-declared flag for spends
that are explicitly a loan or an advance — a purchase on terms, say). Without
this rule, no agent could ever make its first μLedger payment: a fresh agent
with no funding has `availableBalance` at or below its reserve floor, so every
spend would breach the reserve and reserve.floor would deny it unconditionally
regardless of `creditAllowed` — the very setting meant to permit exactly that.
An operator who wants an agent that can only ever spend money it already has
sets `creditAllowed: false` and funds the agent before its first job.

## Fail-closed

Four conditions are denials rather than defaults:

- **No mandate.** An agent without a mandate cannot spend anything.
- **Unknown balance.** `availableBalance: null` denies, rather than assuming
  funds exist.
- **Unknown spend history.** `spentToday: null` denies, rather than assuming
  zero.
- **Unvaluable amount.** An asset with no registered peg and no fresh price
  cannot be compared to a dollar limit, so it is denied — never valued at zero
  and never assumed to be a dollar.

This matters in practice. A rail outage that makes balances unreadable must not
become a window in which the daily limit is unenforceable.

## Default mandate

Newly created agents get a deliberately conservative policy:

```json
{
  "dailySpendLimitUsd": "1.00",
  "maxTransactionUsd": "0.025",
  "minimumReserveUsd": "0.00",
  "unverifiedCounterpartyLimitUsd": "0.00",
  "humanApprovalAboveUsd": "1.00",
  "creditAllowed": false,
  "tokenTradingAllowed": false,
  "allowedAssets": ["USDC"],
  "allowedNetworks": ["ARC", "MULEDGER"]
}
```

A dollar a day, two and a half cents a transaction, nothing to a counterparty we
cannot identify, and a human in the loop above a dollar.

## Storage

Mandates are versioned, never edited: a change writes a new row with an
incremented `version` and the id of the user who authorized it. The evaluation
path always reads the highest version. `authorized_by_user_id` is a user, never
an agent and never a model.

## Testing it yourself

```bash
curl -X POST https://agentcorrespondent.com/api/v1/mandate/check \
  -H "authorization: Bearer $ACOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"agentId":"agent_...","amountUsd":"0.05","asset":"USDC","network":"ARC","availableBalanceUsd":"10"}'
```

The endpoint runs the same function the relay and the chat tools call, so the
answer is exactly the answer a real spend would get.
