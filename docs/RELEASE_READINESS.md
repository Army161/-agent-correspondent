# Release readiness

This document is an operational status report, not a launch claim. A surface is
only described as live after the corresponding account, endpoint, and
end-to-end path have been independently verified.

## Verified in the current recovery pass

| Area | Status | Evidence |
| --- | --- | --- |
| Unit suite | verified | 450 tests in 28 suites pass on Node.js 22.12 in a clean short-path checkout. |
| CI runtime | updated | GitHub Actions now uses Node.js 22.12, the runtime that supports the locked Vite/XRPL dependency graph. |
| Static checks and production build | verified | Lint, strict typecheck, and the Next.js production build pass on Node.js 22.12 in the same checkout. |
| Browser suite without a database | verified | The complete Playwright matrix passed with no `DATABASE_URL`; data-bearing cases skip and every unconfigured surface remains fail-closed. |
| Financial safeguards | verified in code | Intent bounds, Sentinel-5, kill switches, quarantine, wallet ownership proofs, and fail-closed capability states remain present. |
| ACOR positioning | verified in code | Utility-only; no deployed contract address, stock exposure, yield, dividends, revenue sharing, price support, or market-making. |

## Not yet verified or live

| Area | Status | Required gate |
| --- | --- | --- |
| Vercel project and `agentcorrespondent.com` | blocked | Authenticated Vercel account, project inspection, domain ownership/DNS verification, then preview validation. |
| Browser suite with PostgreSQL 16 | blocked on this host | Docker Desktop was started but its engine pipe did not become available. The configured GitHub Actions job remains required before preview or production. |
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
