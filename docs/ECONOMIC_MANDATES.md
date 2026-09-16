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

Amounts are decimal strings or numbers on the wire and exact nanodollar
integers everywhere inside the system. Both allowlists must be non-empty: a
mandate has to be explicit about what it permits.

## Rules, in evaluation order

| Rule | Denies when |
| --- | --- |
| `amount.positive` | the amount is zero or negative |
| `asset.allowed` | the asset is not in `allowedAssets` |
| `network.allowed` | the network is not in `allowedNetworks` |
| `transaction.max` | the amount exceeds `maxTransactionUsd` |
| `daily.limit` | today's spend plus this one exceeds `dailySpendLimitUsd` |
| `reserve.floor` | the remaining balance would fall below `minimumReserveUsd` |
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

## Fail-closed

Three conditions are denials rather than defaults:

- **No mandate.** An agent without a mandate cannot spend anything.
- **Unknown balance.** `availableBalance: null` denies, rather than assuming
  funds exist.
- **Unknown spend history.** `spentToday: null` denies, rather than assuming
  zero.

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
