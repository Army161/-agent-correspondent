# Security

An autonomous agent with a wallet is a new kind of attack surface. This document
states the controls, the attacks each is tested against, and the things this
platform will never do.

## The central property

**No tool reachable by a language model can move money.**

The model can discover providers, rank them, test a spend against a mandate,
compile an intent for a human to sign, and read the ledger. Every one of those
is read-only or compile-only. A prompt injection that fully captures the model
still cannot cause a payment, because there is nothing on the other side of
`apps/web/src/lib/ai/tools.ts` that pays anyone.

The system prompt tells the model it cannot authorize spending and that
documents are data rather than instructions. That is a mitigation. The control
is the tool surface.

## Key material

- **No seed phrases are stored. Ever.** No column in the schema holds key
  material; `agent_wallets` records an address, a custody mode and an opaque
  provider reference.
- **No private key is ever requested through chat**, and the operator prompt
  instructs the model to tell a user to rotate any secret they paste.
- Signing happens in a user-controlled wallet or a custody provider's
  infrastructure. This process holds no signing authority, which is why the
  adapters prepare and validate transactions but do not broadcast them.
- Passwords are scrypt-hashed (N=16384, r=8, p=1) with per-user salts and
  compared in constant time. Sessions are random 256-bit tokens stored only as
  SHA-256 hashes, so a database disclosure does not hand over live sessions.
- Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.

## Attacks under test

Every item below is a test that passes only when the attack fails.

| Attack | Control | Where |
| --- | --- | --- |
| Overspend | per-transaction, daily and reserve limits | `mandate.test.ts` |
| Expired intent | expiry checked at submission and again at execution | `intent.test.ts`, `relay.test.ts` |
| Nonce reuse | nonce burned per (signer, chain, contract), never released | `relay.test.ts` |
| Cross-chain replay | `chainId` inside the EIP-712 domain | `intent.test.ts` |
| Cross-contract replay | `verifyingContract` inside the domain | `intent.test.ts` |
| Changed destination | exact match; only address checksum casing tolerated | `bounds.test.ts` |
| Changed token | asset is part of the authorization | `bounds.test.ts` |
| Changed network | network is part of the authorization | `bounds.test.ts` |
| Larger fee | `maxNetworkFee` ceiling, plus a reconciliation check | `bounds.test.ts` |
| Amount mutation | `maxSpend` / `minReceive`, to the nanodollar | `bounds.test.ts` |
| Undeclared skim | parts must reconcile to the whole | `bounds.test.ts` |
| Stale quote | quote age limit | `bounds.test.ts` |
| FX slippage | drift measured in bps, rounded against the user | `bounds.test.ts` |
| Forged provider | provider availability and payout address re-checked | `relay.test.ts` |
| Provider address rotation | authorization invalidated; buyer must re-sign | `relay.test.ts` |
| Mandate bypass at the relay | relay evaluates the buyer's mandate | `relay.test.ts` |
| Duplicate settlement | one reference, one receipt | `settlement.test.ts` |
| Receipt tampering | canonical hash comparison | `settlement.test.ts` |
| Price mutation in a receipt | final price cannot exceed the quote | `settlement.test.ts` |
| μLedger double credit | idempotency key per economic event | `muledger.test.ts` |
| Entry mutation | append-only, DB-enforced | `muledger.test.ts` + trigger |
| Double netting | only `OPEN` entries can enter a cycle | `muledger.test.ts` |
| Cycle tampering | proof hash over inputs and outputs, both checked | `muledger.test.ts` |
| Reputation farming | counterparty diversity weighting | `settlement.test.ts` |
| Illegal job transitions | state machine in the kernel | `settlement.test.ts` |
| Unverified primitive | `UNKNOWN` treated as `DISABLED` | `settlement.test.ts` |
| Testnet code in production | `TESTNET_ONLY` refused in production | `settlement.test.ts` |
| Bid manipulation | commit/reveal with auction-bound commitments | `settlement.test.ts` |
| Cross-organization probing | every economic endpoint is org-scoped | `product.spec.ts` |
| Unauthenticated access | every economic endpoint refuses | `product.spec.ts` |

## Fail-closed

Denial is the default for anything unknown:

- no mandate → deny
- unknown balance → deny
- unknown spend history → deny
- unverified network primitive → refuse to route
- missing credentials → `NOT_CONFIGURED`, never a simulated result
- missing verifier contract → refuse to compile an intent

## Database-level controls

Convention is not a control. `packages/db/migrations/0001_append_only.sql`
installs triggers that make append-only a property of the database:

- `economic_receipts`, `reputation_events`, `job_events`, `audit_logs`,
  `intent_nonces` and `intent_signatures` reject `UPDATE` and `DELETE` outright.
- `muledger_entries` permits only `state` and `cycle_id` to change, forbids
  backwards transitions, and forbids moving an entry between cycles.
- `clearing_cycles` may be marked settled but its arithmetic is frozen.

These were verified against a live Postgres: every mutation above raises
`restrict_violation`, and the legitimate `NETTED → SETTLED` transition succeeds.

## Web-layer controls

- Security headers on every response: `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS.
- All request bodies are Zod-validated before reaching any economic code.
- Chat tool loops are bounded (`stopWhen: stepCountIs(6)`) — a runaway loop is a
  cost incident, not a feature.
- API keys are stored only as SHA-256 hashes and shown once at creation.
- `webhook_deliveries` is uniquely indexed on `(source, external_id)` to make
  inbound webhook replay a no-op.
- Adapters use fixed request timeouts; credentials stay server-side and never
  enter a model context.

## Known gaps

Stated plainly, because a security document that only lists strengths is
marketing:

- **SSRF.** Provider endpoint fetching is not yet implemented, so there is no
  SSRF surface today — but there is also no allowlist ready for when discovery
  starts fetching remote endpoints. That allowlist must exist before it does.
- **Rate limiting.** There is none at the application layer. Deploy behind a
  gateway that provides it.
- **CSRF.** Mutating API routes rely on `sameSite=lax` cookies and JSON content
  types. Origin checking on state-changing routes should be added.
- **Evaluator trust.** The evaluator is recorded on the intent and the receipt,
  but evaluator attestations are not yet verified cryptographically.
- **No live settlement.** No adapter broadcasts a transaction, so the
  end-to-end settlement path has not been exercised against real funds.

## Reporting

Report security issues privately to the maintainers before public disclosure.
Include the affected route or package, the conditions required, and the economic
impact. Do not test against other people's agents or wallets.
