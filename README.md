# Agent Correspondent

**The Full-Stack Agent Chat OS for the Machine Economy.**

Create autonomous agents that can reason, work, contract, transact, settle, and
build economic reputation across modern payment networks.

AI agents can think. What they lack is everything that turns a capable process
into an economic actor: who it is, what it may spend, how it contracts, and what
it owes. This repository is that layer.

## The one idea

**The model reasons. Deterministic code decides.**

A language model can propose a payment, rank providers, or draft an
authorization. It cannot authorize a spend, because nothing it can reach
authorizes one. Every tool exposed to the model is read-only or compile-only,
and every financial execution path is a pure function a model cannot call.

## Layout

```
apps/web           Next.js app: chat, agents, jobs, wallets, clearing, REST API
packages/core      the economic kernel — deterministic, no I/O, no model
packages/db        Drizzle schema over Postgres, append-only where it matters
packages/adapters  settlement plane: Arc, Circle, XRPL, Kaleido, BlockDAG
e2e                Playwright, run against configured and unconfigured builds
```

## Quick start

```bash
pnpm install
createdb agent_correspondent
export DATABASE_URL="postgres://user@localhost:5432/agent_correspondent"
pnpm --filter @acor/db exec drizzle-kit migrate
pnpm dev
```

It runs with nothing else configured. Unconfigured surfaces read
`NOT CONNECTED` — never a placeholder number.

## Verify

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e
```

## What is actually built

- **Nanodollar money math** — integer `bigint`, 1 USD = 1e9. Floats never touch
  an amount, and a $0.00000004 obligation survives the whole pipeline.
- **Economic mandates** — deterministic per-agent spending policy, fail-closed
  on missing mandate, unknown balance or unknown spend history.
- **Economic intents** — EIP-712 signable authorizations, with a parity test
  asserting our encoder and viem agree byte for byte.
- **Fail-closed execution bounds** — amount, asset, network, destination, rail,
  fee, slippage and expiry all re-checked immediately before submission.
- **Non-custodial intent relay** — holds no keys; compromising it fully still
  cannot cause a payment.
- **Procurement on effective cost** — price plus latency, failure risk,
  validation and counterparty risk, with the breakdown shown.
- **Economic router** — deterministic rail selection that refuses to route
  through a primitive not verified live.
- **μLedger** — append-only obligation ledger with bilateral (P0) and
  multilateral (P1) netting and reproducibility proofs.
- **Immutable receipts and derived reputation** — reputation is computed from
  settled work, never asserted.
- **Append-only database triggers** — because convention is not a control.

## Documentation

[Product spec](docs/PRODUCT_SPEC.md) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Economic intents](docs/ECONOMIC_INTENTS.md) ·
[Economic mandates](docs/ECONOMIC_MANDATES.md) ·
[μLedger](docs/MULEDGER.md) ·
[Settlement](docs/SETTLEMENT.md) ·
[Arc](docs/ARC.md) ·
[XRPL](docs/XRPL.md) ·
[Security](docs/SECURITY.md) ·
[Brand system](docs/BRAND_SYSTEM.md) ·
[ACOR](docs/ACOR.md) ·
[Deployment](docs/DEPLOYMENT.md)

[FINAL_REPORT.md](FINAL_REPORT.md) states exactly what is complete, what is
stubbed, what credentials are needed, and what is not done.

## ACOR

ACOR is an ecosystem and community utility token associated with Agent
Correspondent on Arc. It is not equity, carries no dividend or ownership rights,
and promises no return. **No contract has been deployed**; any address you are
shown is not ACOR. See [docs/ACOR.md](docs/ACOR.md).

## Disclaimer

Agent Correspondent is an independent project. It is not affiliated with,
endorsed by, or sponsored by Arc, Circle, Ripple, Kaleido, BlockDAG, or any
other project named in this repository. Nothing here is financial, investment,
legal or tax advice.
