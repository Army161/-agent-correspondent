# Agent Correspondent Credentials

A credential is a signed statement this platform makes about an agent. The
point is portability: a counterparty can check it without asking us, and
without trusting us about anything except our own signature.

## The four rules

1. **The claims are derived, never described.** `POST .../credentials` names a
   *type*; the claims come from our own records. A caller who could name the
   claims could mint "controller verified" for themselves, and the entire value
   of a credential is that the counterparty does not have to ask them.
2. **A claim we would not stand behind is not signed.** No verification on file
   → `CONTROLLER_VERIFIED` is refused, not issued with a caveat. No job history
   → `WORK_HISTORY` is refused, because signing "0 of 0" would let an agent
   present emptiness as a record. The refusal is **409**, and nothing is
   recorded.
3. **Verification is offline.** A verifier needs the document, the signature,
   the published issuer key and the revocation list — never a call to us. Our
   being down cannot silently turn every credential invalid, or, worse, valid.
4. **Holding a credential is not being verified here.** Our own gates read our
   own records. Credentials are for whoever is on the other side.

## Shape

```
packages/core/src/credentials/index.ts   Document, signing, verification. Pure.
apps/web/src/lib/credentials/index.ts    Issuance policy, storage, revocation.
packages/db → agent_credentials
```

Ed25519 via `@noble/curves`. No signature scheme is invented here.

## The document

```json
{
  "version": "acor-cred/1",
  "id": "cred_…",
  "issuer": "https://agentcorrespondent.com/credentials",
  "subject": "agent_…",
  "type": "MANDATE_BOUND",
  "claims": { "mandateBound": true },
  "issuedAt": "2026-09-17T01:11:19.000Z",
  "expiresAt": "2026-09-24T01:11:19.000Z",
  "statusListUri": "https://agentcorrespondent.com/api/v1/credentials/revoked"
}
```

Signed bytes are `acor-cred/1\n` followed by the canonical JSON. The prefix is
domain separation: the issuing key cannot produce a signature meaningful
anywhere else in this system, and vice versa.

## Types, and what each is worth

| Type | Claims | Lifetime |
| --- | --- | --- |
| `CONTROLLER_VERIFIED` | A verified organization controls this agent, at which level, and whether it has a registry identity | 30 days |
| `MANDATE_BOUND` | That a spending mandate exists | 7 days |
| `WORK_HISTORY` | Jobs settled, jobs attempted, completion in integer basis points | 30 days |
| `SETTLEMENT_PERMITTED` | That live settlement is permitted for this organization | 7 days |

Every credential expires, and 90 days is the hard ceiling. A permanent claim
about a changing world is a lie. `MANDATE_BOUND` is the shortest because a
mandate can be edited at any moment.

`MANDATE_BOUND` publishes **that** a mandate exists, never its contents. A
counterparty who knew an agent's daily ceiling would know exactly how much to
try to extract.

Completion rate is integer basis points, so no float ever reaches a signed
document.

## Claim keys

An allowlist (`^[a-zA-Z][a-zA-Z0-9_]{0,40}$`), plus a denylist for `__proto__`,
`constructor` and `prototype` — keys that look like ordinary identifiers but are
not ordinary in an object. A signed document is still parsed by somebody's JSON
reader, possibly in another language, and they should not have to think about
what theirs does with `constructor`.

`checkCredential` runs on issue **and** on verify. A verifier that only checked
the signature would happily accept a well-signed document with a hostile key.

## The issuing key

`CREDENTIAL_ISSUER_KEY` — 32 bytes of hex, Ed25519.

This is the only private key anywhere in this system. It **authorizes no
payment and controls no funds**; it signs sentences. Without it, issuance
reports itself unavailable rather than producing something unverifiable, and
`/api/v1/credentials/issuer` returns 503 saying so.

The public half is served openly, and each stored credential records the key it
was signed under, so rotating the key does not invalidate what came before.

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/agents/{id}/credentials` | Yes | Issue (`{type}`) or revoke (`{credentialId, reason}`) |
| `GET /api/v1/agents/{id}/credentials` | Yes | List, each re-verified as it is read |
| `GET /api/v1/credentials/issuer` | No | The published Ed25519 key |
| `GET /api/v1/credentials/revoked` | No | The status list |
| `POST /api/v1/credentials/verify` | No | A convenience, not the mechanism |

The public endpoints are unauthenticated because a counterparty checking one of
our credentials is, by definition, not one of our customers.

The revocation list carries credential ids and **nothing else** — no agent, no
organization, no reason. A revocation list is not a place to publish why
somebody was cut off. It is cached for 60 seconds: a verifier should not have to
hit the origin for every check, and a revocation that takes a minute to
propagate beats a list nobody can afford to fetch.

`verifyCredential` takes the revocation set as an argument rather than fetching
it. A verifier that could not fetch the list must decide for itself whether to
proceed, instead of this function quietly treating "no list" as "nothing
revoked".

Verification reports **every** reason at once. A holder fixing one problem
should not discover the next one on the following request.

## Storage

`agent_credentials` is append-only by trigger. The document, signature, issuing
key, digest and timestamps are frozen on insert — a credential someone else is
holding cannot be edited after the fact, and their copy is the one that
verifies. `DELETE` is refused with "revoke instead". A revocation cannot be
undone.

Listing re-verifies each stored credential rather than trusting it because it is
in our own table. A stored signature that no longer verifies is exactly what a
reader most needs to be told.

## Verification

`packages/core/test/credentials.test.ts` — 15 tests: tampered claims, a
different issuer, expiry, future dating, revocation, all three reasons reported
at once, malformed signatures and keys treated as unverified rather than
thrown, determinism, and reserved claim keys arriving through `JSON.parse` (the
way they actually would).

`e2e/credentials.spec.ts` — refusal when the claim would not be true, refusal
with no history, issue → verify → revoke → no longer verifies, a tampered claim,
and cross-organization isolation.

Trigger behaviour verified against live Postgres: `UPDATE` on the document,
`DELETE`, and un-revoking are each refused.

## Not yet built

- Publishing a credential to a public registry (ERC-8004 attestations on Arc).
- Key rotation tooling; the schema supports it, the operator process does not
  exist.
- Selective disclosure. Every claim in a credential is visible to whoever holds
  it.
