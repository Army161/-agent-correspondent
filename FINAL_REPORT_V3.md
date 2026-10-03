# Final report — v3

Agent Correspondent, branch `claude/agent-correspondent-spec-wggst1`, covering
the continuous-execution handoff that began at `9db1557`. This report states
what was built, what was verified and how, what was found broken along the
way, and what is blocked or needs a decision. `FINAL_REPORT.md` (v1) and
`docs/RELEASE_READINESS.md` (the repository owner's operational status)
remain accurate for what they cover.

**No pull request has been opened.** The handoff says not to until the full
implementable scope is complete; the rail integrations below are not, because
they are blocked on credentials and network access, not on code.

---

## Verification

Run on Node.js 22, PostgreSQL 16, against production builds (`next start`),
on the tree that includes the owner's Node 22 release commits.

| Gate | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass — 5 packages (`core`, `db`, `adapters`, `sdk`, `web`) |
| `pnpm test` | pass — **504 unit tests** |
| `pnpm build` | pass |
| e2e, with PostgreSQL 16 | **216 passed**, 6 skipped (the no-database group), desktop + mobile |
| e2e, no database | **88 passed**, 134 skipped (the database group), desktop + mobile |
| Migrations | all 23 apply to an empty database via `pnpm --filter @acor/db migrate` |

The PostgreSQL browser matrix is the run `docs/RELEASE_READINESS.md` lists as
pending. Hosted CI exists (`.github/workflows/ci.yml`: checks, e2e with a
Postgres service, e2e without) but has not run on GitHub: per the owner's
notes, hosted Actions are refused by an account billing lock.

---

## Delivered, by handoff item

| Item | Status | Where |
| --- | --- | --- |
| Sentinel-5 wired to the live submit path | done | `docs/SENTINEL_5.md` |
| — sensors, incidents with frozen evidence, audit trail | done | `lib/security/*` |
| — agent / wallet / rail / global kill switches; provider quarantine | done | kill-switch log, append-only |
| — reversible automatic containment (CRITICAL → agent freeze) | done | |
| — self-service freeze **control** in the UI | done (this pass) | agent page, Containment panel |
| — API-key / session revocation hooks | done (this pass) | `revokePrincipal` now has real callers |
| — security LLM cannot sign, settle, move funds, merge, deploy; no hack-back | holds by construction | no tool reaches those paths |
| — patch generation into an isolated branch/PR | **policy, not automation** | fixes are committed and pushed for human review; nothing opens or merges PRs |
| Convoy Mode | done | `docs/CONVOY_MODE.md` |
| PQ crypto-agility (ML-DSA-65 secondary attestation) | done, additive only | `docs/POST_QUANTUM_READINESS.md` |
| Jobs: create, fund from a signed intent, settle | done | `lib/jobs.ts`, `docs/MULEDGER.md` |
| Immutable receipt, reputation event, transaction record on settlement | done, one DB transaction | |
| μLedger obligation creation; clearing execution (OPEN → NETTED) | done; **never marks SETTLED** | `lib/clearing.ts` |
| TypeScript SDK | done | `packages/sdk` |
| Webhooks (outbound, signed, revocable) | done | `docs/WEBHOOKS.md` |
| API keys (issue, list, revoke) | done (this pass) | Developers page; `/api/v1/api-keys` |
| CI/CD | workflow done; hosted run blocked (billing lock) | `.github/workflows/ci.yml` |
| Error reporting / observability | done; real-Sentry delivery unverified (no DSN) | `docs/OBSERVABILITY.md` |
| Threat model, runbooks | done | `docs/THREAT_MODEL.md`, `docs/RUNBOOKS.md` |
| Adversarial suite | extended (below) | `e2e/*`, `*.test.ts` |
| Arc/Circle, x402, live XRPL, Kaleido, BlockDAG | **blocked** | see below |

---

## Defects found and fixed during this handoff

Each was found by writing a test, reading code against its own claims, or
running the product — not reported by anyone.

1. **SSRF in outbound webhooks** (introduced earlier in this handoff). Tenants
   could aim server-side deliveries at `127.0.0.1`, `169.254.169.254` or
   private hosts and read status codes as a probe. Now resolved and checked
   at subscription and before each delivery, redirects not followed, https
   required in production. Six live attempts refused.
2. **Form-based CSRF.** A `text/plain` form carrying JSON created an agent
   same-site (demonstrated, 201); SameSite was the only barrier. JSON routes
   now require `application/json`. Tested cross-site (401) and same-site (400)
   against a legitimate-request control.
3. **API keys could be verified but never issued**, so the SDK only worked on
   public endpoints and Sentinel-5's key-revocation hook had no caller.
4. **The jobs path was not atomic**, despite its docstring: settlement's
   ledger entry, receipt, transaction and reputation event were separate
   writes. Now one transaction; webhooks fire only after commit.
5. **Mandate reserve floor ignored `creditAllowed`**, so no agent could make a
   first μLedger payment.
6. **Kill-switch listing hid an owner's own frozen agents** (its comment only
   meant other tenants'). A test now proves other tenants' stay hidden.
7. **Jobs accepted another organization's agent as provider** — creatable,
   never fundable, since the relay, ledger and clearing are single-tenant.
8. **`/developers` overflowed phones** (667px on a 412px screen), and the
   mobile test could not see it: emulated Chromium widens the layout viewport
   to fit overflow. The check now compares against `screen.width`.
9. **The Developers page listed three endpoints that do not exist.**
10. **`onRequestError` did not await delivery**, which this Next version's own
    docs say can lose the report.
11. Smaller: bigint serialization 500s in job routes and clearing; a jsonb
    bigint write failure in clearing; a stale `SECURITY.md` claim that nothing
    is rate-limited in-app; three pre-existing broken e2e assertions.

---

## Adversarial coverage added

- `auth-boundary.spec.ts` — every route under `app/api/v1` is **discovered
  from the filesystem** and must refuse no credentials and an unknown API key,
  except a commented public allowlist. Mutation-checked.
- `csrf.spec.ts` — both CSRF layers, with a control.
- `api-keys.spec.ts` — a key cannot mint a key; revocation is immediate; a
  leaked key can revoke itself; cross-tenant revocation refused.
- `webhooks.spec.ts`, `target.test.ts` (38 SSRF cases incl. IPv4-mapped and
  NAT64 spellings) — signing, revocation, cross-tenant refusal.
- `jobs.spec.ts` — double-fund, under-authorization, cross-tenant job access.
- `sentinel.spec.ts` — UI freeze, listing isolation.
- `instrumentation.test.ts` — tokens in query strings never reach Sentry.

---

## Blocked — what unblocks each

| Item | Blocked on |
| --- | --- |
| Arc / Circle testnet payment, x402 / nanopayments | `ARC_RPC_URL`, `ARC_USDC_ADDRESS`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` and a funded testnet wallet |
| XRPL testnet XRP/RLUSD, pathfinding, x402, credential-gated payment | `XRPL_WS_URL`, **and** network access: this environment resets connections to the testnet's RPC/WebSocket ports (51233/51234). Allow `s.altnet.rippletest.net` in the cloud environment's network settings. Also needs a decided signing model — the app deliberately holds no keys |
| Kaleido | `KALEIDO_BASE_URL`, `KALEIDO_API_KEY` |
| BlockDAG | `BLOCKDAG_RPC_URL` |
| Hosted CI | the GitHub account billing lock |
| Real Sentry delivery | a `SENTRY_DSN` |
| Marking clearing cycles SETTLED | a rail with signing authority; until then netting stops at NETTED by design |

While checking XRPL reachability, one request to the public testnet faucet
created a throwaway, valueless testnet account. Nothing else touched a
third-party system.

---

## Decisions for the owner

1. **Cross-organization trade.** Discovery, the relay, the ledger and
   clearing are single-tenant, and jobs now are too. Opening a marketplace is
   a product decision with security preconditions — chiefly, PASS/REJECT and
   dispute resolution must stop being open to "either side", or a provider in
   another org could pass its own work and settle (`docs/MULEDGER.md`).
2. **Operator action on a single tenant.** Operators can stop a rail or the
   platform but not one tenant's agent, nor revoke its credentials
   (`docs/RUNBOOKS.md`).
3. **Key rotation.** The credential issuer has one key and no key ids;
   `WEBHOOK_ENCRYPTION_KEY` has no re-encryption path. Both make rotation a
   reissue-everything event.
4. **API key scopes** exist in the schema and are not enforced; keys are full
   organization access.

---

## Audit readiness — where the evidence is

| Question an auditor will ask | Answer lives in |
| --- | --- |
| Can a model move money? | `docs/SECURITY.md` "central property"; `lib/ai/tools.ts` |
| What is DB-enforced vs. convention? | append-only triggers in `packages/db/migrations` (`0001`, `0007`, `0013`, `0016`, `0019`); asset-identity triggers in `0004` |
| How is a spend authorized end to end? | `docs/ECONOMIC_INTENTS.md`, `docs/ECONOMIC_MANDATES.md`, `docs/SENTINEL_5.md` |
| What happens in an incident? | `docs/RUNBOOKS.md`; incidents and kill-switch history are append-only |
| Who can reach which route? | `e2e/auth-boundary.spec.ts` (enumerated) |
| What is known to be weak? | `docs/THREAT_MODEL.md` "Open" column; `docs/SECURITY.md` "Known gaps" |
| What is live vs. claimed? | `GET /api/v1/manifest`, `GET /api/health` — no rail reports LIVE |

Before production, `docs/RUNBOOKS.md` § "Before production" is the checklist.
