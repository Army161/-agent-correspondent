# Identity verification

Two rules shape the whole design.

1. **No raw documents.** This system stores a level, a status, the provider's
   reference and a digest. A passport scan is the most damaging thing a breach
   could hand over, and the way not to lose it is never to hold it.
2. **Fail closed.** Unknown, stale and unreadable all deny. A verification
   system that approves when it cannot tell is worse than none, because it is
   trusted.

## Shape

```
packages/core/src/identity/verification.ts   Levels, statuses, the gate. Pure.
apps/web/src/lib/identity/index.ts           Storage, the provider seam.
apps/web/src/lib/identity/gates.ts           Where it is enforced.
packages/db → identity_verifications
```

The policy is separate from the vendor so the answer to "may this account do
this?" does not depend on which vendor happens to be wired up.

## Levels

Ordered; each implies the ones before it.

| Level | Means |
| --- | --- |
| `NONE` | An email address that received a link. |
| `INDIVIDUAL` | A natural person, checked against a document. |
| `BUSINESS` | A legal entity, its registration, and a beneficial owner. |

## Effective level

`effectiveLevel(record, now)` is what the account actually holds:

- Anything other than `APPROVED` → `NONE`.
- `APPROVED` past its `expiresAt` → `NONE`, **whatever the stored status says**.
  The row still reads `APPROVED` because the provider never sent anything else,
  but time passed, and an expired approval is not an approval.

The record is not rewritten on expiry — a caller may legitimately want to see
that it was once approved — but the level it confers is `NONE`.

## Requirements

| Requirement | Level | Protects |
| --- | --- | --- |
| `NONE` | `NONE` | Reading, building agents, μLedger obligations — nothing external moves. |
| `LIVE_SETTLEMENT` | `INDIVIDUAL` | Anything that can move value on a public network. |
| `ORGANIZATION_CONTROLS` | `BUSINESS` | Acting for a legal entity, and entity-level limits. |

## Where it is enforced

`apps/web/src/lib/identity/gates.ts` — one module, so "what needs KYC?" is a
list you can read rather than something to be found by grepping.

Today: `POST /api/v1/intents/submit` calls `canAuthorizeOn()` before the relay
sees the signed intent. On a network where value actually moves, an unverified
organization gets **403 VERIFICATION_REQUIRED**.

"Moves real value" means: not the μLedger (which records obligations and moves
nothing), and not a `_TESTNET` network.

This gate is about *who is behind the account*. The relay's checks are about
*the intent*. Answering the cheaper, clearer question first is deliberate.

## The provider seam

A provider can do exactly two things: start a case, and report a decision.

There is **no manual approval path**, and that is not an oversight. A manual
approval path is the first thing an attacker with a database connection reaches
for. `provider: "manual"` is not a value this system writes.

There is also no path by which a request body sets a verification status. A
client that could post its own KYC state would make every gate downstream
decorative.

No provider is configured in this repository. `verificationProvider()` reports
that, the gate denies, and `/settings/security` says which variables would
change it — rather than a stub that approves.

## Evidence

`checkEvidence()` requires a 64-character hex SHA-256 and a non-empty provider
reference. The digest lets a later dispute establish that the record was not
altered, without this system ever holding the document it summarises. A payload
pasted in by mistake fails the shape check rather than being stored.

`rejection_code` holds a provider's machine-readable reason. It never holds free
text about a person.

## Verification

`packages/core/test/verification.test.ts` — 12 tests: level ordering, every
non-approved status collapsing to `NONE`, an `APPROVED` row that has aged out,
the three distinguishable remedies (in progress, rejected, expired), and
evidence-shape refusal.

## Not yet built

- A concrete provider adapter (Persona, Sumsub, Stripe Identity — each needs
  credentials and each has its own webhook signature scheme).
- The `BUSINESS` flow end to end; the level and the gate exist, the collection
  does not.
- Re-verification reminders before an approval expires.
