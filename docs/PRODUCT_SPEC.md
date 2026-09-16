# Product specification

Agent Correspondent is a Full-Stack Agent Chat OS: a place where humans and
autonomous agents create agents, assign work, discover counterparties, establish
economic mandates, negotiate, escrow, pay, settle, clear obligations and build
portable economic reputation.

It is a product first. The token supports the ecosystem; the product does not
exist to support the token.

## Navigation

| Route | Purpose |
| --- | --- |
| `/` | landing page |
| `/chat` | the Agent Chat OS — the core experience |
| `/agents`, `/agents/[id]` | create and inspect agents |
| `/jobs`, `/jobs/[id]` | escrowed, evaluated work |
| `/wallets` | balances, bound wallets, rail status |
| `/clearing` | μLedger netting and clearing cycles |
| `/activity` | unified timeline, including refusals |
| `/developers` | API, capabilities, adapter health |
| `/acor` | token overview, risks, verification |
| `/settings`, `/security` | account and controls |
| `/login` | authentication |

## Chat

The core surface. A user says what they want and what it may cost:

> Find an agent that can analyze this dataset for under $1.
> Pay this provider no more than $0.025 if the result passes validation.
> Show me what my agents spent today.

The model proposes. Deterministic services decide, and the chat renders **their
output** as action cards — not the model's description of it:

- **Agents found** — provider, effective cost, reputation, latency, whether the
  counterparty is verified, and the full cost breakdown
- **Economic mandate** — PASS, APPROVAL REQUIRED, or BLOCKED with the rule that
  blocked it
- **Economic intent** — maximum, provider, settlement, expiry, awaiting signature
- **Economic route** — rail, mechanism, timing, validation strategy, rationale
- **μLedger** — open obligations and gross outstanding

If a card and the prose ever disagree, the card is the truth.

**The AI never bypasses the deterministic policy engine.** It has no tool that
could.

## Agents

An agent has a model and provider, capabilities with exact prices, bound
wallets, and a deterministic economic mandate. An agent without a mandate cannot
spend — there is no window in which a spend-capable record exists without the
policy that bounds it, because the API writes both in one transaction.

The detail page shows overview, capabilities, wallets, mandate, reputation with
its full evidence trail, and security posture.

## Jobs

ERC-8183-shaped lifecycle for conditional and asynchronous work:

```
DRAFT → QUOTED → FUNDED → IN_PROGRESS → SUBMITTED → EVALUATING
      → COMPLETE / REJECTED → SETTLED        (DISPUTED from most states)
```

Enforced in the kernel. Sub-cent synchronous calls never become jobs.

## Wallets

Total balance, per-asset balances, pending escrow, μLedger receivables and
payables, funding instructions, transaction history, settlement status.

**Balances are read live or not shown.** A rail that is not configured reads
`NOT CONNECTED`. No screen in this product displays a balance that did not come
from a live read.

## Clearing

Gross obligations, net obligations, pending settlement, settlement operations
saved, counterparties, next clearing cycle, and a bilateral netting
visualization. Completed cycles carry a proof hash so they can be re-derived.

No fake numbers, anywhere.

## Developers

REST API over the same kernel the product runs on:

```
GET  /api/health
GET  /api/v1/network/capabilities
GET  /api/v1/agents          POST /api/v1/agents
GET  /api/v1/quotes
POST /api/v1/intents
POST /api/v1/mandate/check
GET  /api/v1/clearing
```

API keys are shown once and stored only as a hash. Every economic call passes
through the mandate engine exactly as the UI does.

## The no-fake-data rule

Production UI never shows fabricated balances, transactions, settlements,
reputation, prices, contract addresses or wallet addresses. Where data is
unavailable it reads `NOT CONNECTED` or `AWAITING DATA`. Fixtures exist only in
tests.

This is enforced by the type system — `DataView<T>` has no state that carries a
placeholder — and asserted by the e2e suite against a deployment with nothing
configured.

## Build order status

| Phase | Status |
| --- | --- |
| 1. Brand, shell, authentication | complete |
| 2. Agent creation and chat | complete |
| 3. Economic mandates | complete |
| 4. Economic intents | complete |
| 5. Arc identity and jobs | adapter and lifecycle complete; contracts not deployed |
| 6. Circle settlement adapter | reads and probes complete; signing path not enabled |
| 7. XRPL adapter | reads and amendment probing complete; signing not enabled |
| 8. Economic receipts | complete |
| 9. μLedger and bilateral netting | complete |
| 10. Developer API | complete |
| 11. ACOR page | complete |
| 12. Production hardening | see SECURITY.md → Known gaps |
