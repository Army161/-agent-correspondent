# Final report

Agent Correspondent — Full-Stack Agent Chat OS and economic coordination layer.

This report states what is complete, what is partial, what is not done, and what
credentials would be required to finish each item. It is deliberately specific
about limitations: a report that only lists what works is not a report.

---

## Current verification status

The figures below distinguish the current checked-out code from the earlier
release snapshot. They are not a claim that an unconfigured local machine has
completed a production deployment.

| Command | Result |
| --- | --- |
| Node 22.12 unit suite | pass — **451 tests**, 28 files |
| `pnpm lint` | pass on Node 22.12 in a clean short-path checkout |
| `pnpm typecheck` | pass on Node 22.12 in a clean short-path checkout |
| `pnpm build` | pass on Node 22.12 in a clean short-path checkout |
| `pnpm e2e` without `DATABASE_URL` | pass; the complete browser matrix records `passed`, with database-only cases intentionally skipped |
| `pnpm e2e` with PostgreSQL 16 | blocked: this host's Docker Desktop engine pipe is unavailable, and GitHub Actions is enabled but refuses hosted jobs before startup because the account has a billing lock |

### Historical verified database evidence

The following was recorded before this recovery pass. It has not been repeated
on the current host because its Docker Desktop engine is unavailable; do not
treat it as a current configured-suite result.

The e2e suite was run twice against a production build:

1. **With a live PostgreSQL 16 database.** 54 tests pass. Registration, sign-in,
   agent creation, mandate enforcement, intent compilation, provider ranking,
   clearing and the activity timeline were exercised end to end through the real
   UI and the real API.
2. **With nothing configured.** 20 tests pass; the database-dependent group is
   skipped and the "without a database" group asserts that every data surface
   reads `NOT CONNECTED` rather than showing a number.

### Observed, not just asserted

The append-only database triggers were tested against live Postgres. Every one
of these raised `restrict_violation`:

```
UPDATE economic_receipts              → append-only: UPDATE is not permitted
DELETE FROM economic_receipts         → append-only: DELETE is not permitted
UPDATE muledger_entries SET amount    → only state and cycle_id may change
NETTED → OPEN                         → a netted obligation cannot be reopened
change cycle_id                       → cannot be moved between cycles
duplicate idempotency_key             → unique constraint violation
NETTED → SETTLED                      → permitted (the legitimate transition)
```

The clearing plane was run against five real obligations between three agents:

```
GROSS  $0.12800004   (5 entries)
NET    $0.02000004   (2 transfers)
84.37% of gross avoided, 3 fewer transfers
```

That includes the specification's own example (A owes B $0.07, B owes A $0.05 →
A owes B $0.02), a pair that cancels exactly, and a **40-nanodollar** obligation
that survives the entire pipeline and renders as `$0.00000004` — not `$0.00`.

---

## Features complete

### The economic kernel (`packages/core`, zero I/O, one dependency)

| Module | What it does |
| --- | --- |
| `units/money` | nanodollar math; exact parsing, exact rail conversion, bps, slippage |
| `canonical` | deterministic serialization, dependency-free SHA-256, domain-separated hashing |
| `mandate` | the deterministic spending policy engine, fail-closed |
| `intent` | `EconomicIntent` schema, compiler, EIP-712 encoder |
| `bounds` | fail-closed execution bounds |
| `relay` | non-custodial intent relay with a nonce ledger |
| `discovery` | provider normalization from internal, ERC-8004, MCP, A2A and x402 sources |
| `procurement` | effective-cost ranking; commit/reveal sealed auctions |
| `capability` | protocol capability engine; `UNKNOWN` is treated as `DISABLED` |
| `router` | deterministic rail selection |
| `muledger` | append-only ledger, bilateral and multilateral netting, proofs |
| `receipts` | immutable receipts, canonical hashing, settlement idempotency |
| `reputation` | reputation derived from settled work, recency-weighted |
| `jobs` | ERC-8183 lifecycle state machine |

### Database (`packages/db`)

All 22 tables named in the specification, plus `sessions`, `chat_threads`,
`chat_messages`, `intent_nonces` and `webhook_deliveries` — 27 in total. Money is
`numeric(38,0)` holding nanodollar integers. Two migrations, the second
installing the append-only triggers.

### Settlement plane (`packages/adapters`)

Arc, Circle, XRPL, Kaleido and BlockDAG behind one interface. Each probes what
is live and reports `NOT_CONFIGURED` rather than simulating. Network separation
between mainnet and testnet is enforced as a configuration error, not a
convention.

### Application (`apps/web`)

All 13 required routes, plus `/login` and 8 API endpoints. Landing page with all nine
sections. Agent Chat OS with deterministic action cards. Full brand system,
logo in seven asset variants, SEO and Open Graph.

---

## Live routes

**Pages:** `/` `/chat` `/agents` `/agents/[id]` `/jobs` `/jobs/[id]` `/wallets`
`/clearing` `/activity` `/developers` `/acor` `/settings` `/security` `/login`

**Core API:** `GET /api/health` · `POST /api/chat` ·
`GET /api/v1/network/capabilities` · `GET,POST /api/v1/agents` ·
`GET /api/v1/quotes` · `POST /api/v1/intents` · `POST /api/v1/mandate/check` ·
`GET /api/v1/clearing` · `GET,POST /api/v1/jobs` ·
`GET /api/v1/jobs/[id]` · `POST /api/v1/jobs/[id]/transition` ·
`GET,POST /api/v1/webhooks` · security, convoy, wallet, credential, billing,
and auth endpoints.

---

## Network adapters

| Adapter | Implemented | Not implemented | Needs |
| --- | --- | --- | --- |
| **Arc** | chain-id verification, contract-code probing for USDC / ERC-8004 / ERC-8183, USDC balance reads, bounds re-check, EIP-712 digest | transaction broadcast | `ARC_RPC_URL`, `ARC_USDC_ADDRESS`, deployed registries, `ARC_INTENT_VERIFIER_ADDRESS`, a signing path |
| **Circle** | credential verification, wallet balance reads | transfers | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, the entity-secret signing path |
| **XRPL** | node probing, amendment detection for 10 gated features, XRP and issued-currency balances | payment submission | `XRPL_WS_URL`, `XRPL_RLUSD_ISSUER`, a funded key-bearing account |
| **Kaleido** | adapter boundary, capability registration | everything else | an enterprise engagement |
| **BlockDAG** | adapter boundary; refuses stable-value settlement by design | — | — |

**No adapter broadcasts a transaction.** This process holds no signing
authority, by design (see `docs/SECURITY.md`). Adapters prepare and validate;
signing happens in a user-controlled wallet or a custody provider.

---

## Credentials needed to go further

| To do this | You need |
| --- | --- |
| Run the platform at all | `DATABASE_URL`, `AUTH_SECRET` |
| Use the chat surface | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| Read Arc balances | `ARC_RPC_URL`, `ARC_USDC_ADDRESS` |
| Compile a signable intent | `ARC_INTENT_VERIFIER_ADDRESS` (a deployed contract) |
| Use ERC-8004 identity | `ARC_ERC8004_ADDRESS` (a deployed registry) |
| Use ERC-8183 jobs | `ARC_ERC8183_ADDRESS` (a deployed registry) |
| Use Circle wallets | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` |
| Read XRPL balances | `XRPL_WS_URL` |
| Settle RLUSD on XRPL | `XRPL_RLUSD_ISSUER` and a trust line |
| Display the ACOR contract | `NEXT_PUBLIC_ACOR_CONTRACT_ADDRESS`, after a verified deployment |

---

## Limitations

Stated plainly.

1. **Nothing settles on a live network.** Every adapter stops before broadcast
   because no signing authority is attached. The end-to-end money path has not
   been exercised against real funds.
2. **No contracts are deployed.** The ERC-8004 identity registry, the ERC-8183
   job registry and the EIP-712 intent verifier do not exist yet. Intent
   compilation refuses (503) without a verifier address rather than producing an
   authorization bound to nothing.
3. **No ACOR contract exists.** The `/acor` page displays
   `CONTRACT NOT YET DEPLOYED` and the e2e suite asserts no 40-hex address
   appears there.
4. **Job creation is an API-backed vertical slice, not a live-settlement
   product.** Jobs can be created and transitioned through their guarded
   lifecycle, but funding and settlement still require a verified live rail.
5. **Clearing cycles are projected, not executed.** `/clearing` shows what
   netting would produce right now, computed from real ledger entries. Committing
   a cycle and settling it requires a live rail.
6. **μLedger entries have no write API.** Obligations would be created by a
   completed x402 or nanopayment call, which requires a live rail.
7. **Rate limiting is currently scoped to authentication.** Other public API
   endpoints still need gateway-level limits before production exposure.
8. **No general CSRF origin check exists for every mutating API route.**
   Auth uses trusted origins and same-site cookies; broader route coverage is
   still required.
9. **Evaluator attestations are unverified.** The evaluator is recorded on the
   intent and receipt but does not yet sign its verdict.
10. **Multilateral netting is `EXPERIMENTAL`.** It is implemented and tested,
    including an assertion that it settles every agent to the same net position
    as bilateral netting, but it is gated off for live settlement.
11. **UI components are shadcn-shaped, not shadcn.** They follow the same
    composition style and use `class-variance-authority`, `clsx` and
    `tailwind-merge`, but were written directly rather than generated by the
    shadcn CLI.
12. **Sentry and PostHog are not wired.** Neither package is installed; there is
    no telemetry in this build.
13. **The landing page chat panel is a static illustration**, labelled as such on
    the page and asserted by a test. It is not a live readout.
14. **The TypeScript SDK is present but not yet published.** `packages/sdk`
   contains the typed client and webhook verifier; package publishing and
   versioning are still required.

---

## Two bugs this process found

Both were found by running the product rather than by reading it, and both are
fixed:

1. **Every agent count rendered as zero.** Drizzle renders a column interpolated
   into a `sql` subquery *without its table qualification*, so
   `where "agent_id" = "id"` resolved entirely within the inner table and
   silently matched nothing. The agents list showed "0 capabilities" and
   "NO MANDATE" for agents that had both. Replaced with `LEFT JOIN` plus
   `COUNT(DISTINCT ...)`.

2. **Sub-cent prices were rounded in the UI.** The display helper switched to
   two decimal places above $0.01, so a capability priced at $0.021 rendered as
   `$0.02` — precision loss in exactly the product that claims not to lose it.
   The formatter is now always exact.

A third issue was caught by a test while writing it: `verifyCycle` originally
re-derived a clearing cycle from its ledger entries but never checked the
cycle's own recorded instructions against its proof hash, so an edited payout
instruction would have passed verification. It now performs both checks.

---

## P1 work, in priority order

1. Deploy the EIP-712 intent verifier on Arc testnet and complete the signing
   path, so an intent can be signed and executed end to end.
2. Wire one live rail — Circle nanopayments on Arc testnet is the shortest path
   — and take a single real payment from intent to receipt.
3. Add the μLedger write API, so completed nanopayments create obligations.
4. Execute a clearing cycle: commit the projection, settle it, mark entries
   `SETTLED`, and verify the cycle reproduces.
5. Job creation and quoting API, completing the ERC-8183 path.
6. Deploy ERC-8004 identity and start reading real reputation evidence.
7. Discovery fetching for MCP, A2A and x402 endpoints — **with an SSRF allowlist
   in place before the first outbound fetch**, not after.
8. Rate limiting, CSRF origin checks, and webhook signature verification.
9. Signed evaluator attestations.
10. TypeScript SDK over the REST API.
11. Sentry and PostHog, behind configuration checks.
12. Promote multilateral netting out of `EXPERIMENTAL` once exercised on a rail.

---

## Acceptance checklist

| Requirement | Status |
| --- | --- |
| Homepage | ✅ nine sections, all asserted |
| Mobile | ✅ no horizontal overflow at 390px, nav toggle tested |
| Chat | ✅ renders, disabled with an explanation when unconfigured |
| Agent creation | ✅ through the API, visible in the UI, verified live |
| Mandate creation | ✅ written atomically with the agent |
| Job creation | ⚠️ lifecycle and UI complete; no write API yet |
| Signed intent generation | ✅ typed data and digest, viem parity asserted |
| Fail-closed spending rules | ✅ 25 mandate tests + live API assertions |
| Wallet connection | ⚠️ binding schema and UI complete; no connect flow |
| Live network health | ✅ `/api/health`, `/developers`, live probes |
| Economic receipt creation | ✅ kernel complete and tested; no live settlement to receipt |
| μLedger math | ✅ 23 tests, plus verified live at $0.00000004 precision |
| ACOR page | ✅ with risk disclosures and verification guidance |
| No fake contract | ✅ asserted — no 40-hex string on `/acor` |
| No fake financial data | ✅ asserted against an unconfigured deployment |
| No unauthorized branding claims | ✅ asserted — prohibited claims only inside denials |

---

## Final principle

Agent Correspondent is not a meme coin with a website attached. The product is a
Full-Stack Agent Chat OS where autonomous agents reason, contract, transact,
settle, clear obligations and build economic reputation. ACOR supports that
ecosystem.

The platform was built first. What is not built is listed above rather than
implied to exist.
