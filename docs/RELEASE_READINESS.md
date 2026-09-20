# Release readiness

This document is an operational status report, not a launch claim. A surface is
only described as live after the corresponding account, endpoint, and
end-to-end path have been independently verified.

## Verified in the current recovery pass

| Area | Status | Evidence |
| --- | --- | --- |
| Unit suite | verified | 451 tests in 28 suites pass on Node.js 22.12 in a clean short-path checkout. |
| CI runtime | updated | GitHub Actions now uses Node.js 22.12, the runtime that supports the locked Vite/XRPL dependency graph. |
| Static checks and production build | verified | Lint, strict typecheck, and the Next.js production build pass on Node.js 22.12 in the same checkout. |
| Browser suite with PostgreSQL 16 | partial | The signed-in agent-creation flow passed in desktop and mobile Playwright runs. The full matrix is pending a responsive Docker/PostgreSQL 16 engine; data-bearing cases cannot be called green while that service is unavailable. |
| Browser suite without a database | partial | Public/auth boundary cases pass and database-dependent cases skip when `/api/health` reports `NOT_CONNECTED`; a complete rerun remains pending after the configured run. |
| Database migration | verified | The non-interactive Drizzle migration completed against a fresh PostgreSQL 16 database under Node.js 22 using the `tsx` runner. |
| Vercel project | verified | `agent-correspondent` is connected to `Army161/-agent-correspondent`, uses `apps/web`, Node.js 22, and deploys from `claude/agent-correspondent-spec-wggst1`. |
| Vercel deployment | verified | The canonical Vercel hostname serves the app. Its health endpoint is intentionally `DEGRADED`; no database or auth secret is configured, and `ACOR_ENV` is currently unset so the deployment reports development mode. |
| Public capability status | verified | The production manifest reports zero `LIVE` rails; μLedger is `INTEGRATING` until independently verified rather than being promoted from code alone. |
| Financial safeguards | verified in code | Intent bounds, Sentinel-5, kill switches, quarantine, wallet ownership proofs, and fail-closed capability states remain present. |
| ACOR positioning | verified in code | Utility-only; no deployed contract address, stock exposure, yield, dividends, revenue sharing, price support, or market-making. |

## Not yet verified or live

| Area | Status | Required gate |
| --- | --- | --- |
| Canonical domain | verified | `https://agentcorrespondent.com` returns HTTPS 200, and `www.agentcorrespondent.com` returns a permanent redirect to the canonical apex. |
| Hosted GitHub Actions | blocked externally | The hosted jobs are refused before startup because the account has a billing lock. Local Node.js 22.12/PostgreSQL 16 equivalents have passed; resolving the billing lock is still required for hosted CI. |
| OAuth, email, Paddle production billing | configuration-only | Provider credentials, callback URLs, signed-webhook checks, and negative-path validation. |
| Arc, Circle, XRPL, Kaleido, BlockDAG | non-live | Authenticated provider access and a controlled end-to-end test. No agent has executed a cross-border transaction. |
| Robinhood | not integrated | A separately authorized and suitable broker integration; no credentials or implementation are present. |
| Tolly | not integrated | Verified venue account and a legal/product review before any token-launch work. |
| RWA or tokenized securities | not started | Jurisdiction, securities counsel, licensed issuer/custodian/broker partners, KYC/AML, transfer controls, disclosures, and audit approval. |

## Production promotion checklist

1. Run lint, strict typecheck, production build, and both Playwright suites in
   the Node 22.12/PostgreSQL 16 CI environment.
2. Confirm a Vercel preview has truthful health and capability states, with
   unconfigured services visibly disabled rather than simulated.
3. Verify authentication, OAuth provider availability, billing-disabled state,
   and webhook rejection paths without exposing secrets.
4. Verify ownership of `agentcorrespondent.com`, configure HTTPS, and redirect
   only verified owned aliases to the canonical hostname.
5. Promote only after the checks above pass; do not merge or open a release PR
   before that point.
