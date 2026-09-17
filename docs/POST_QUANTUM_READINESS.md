# Post-quantum readiness

What this document is not: a claim that anything in this product is
"quantum-proof" or "quantum-safe". No such claim is made anywhere in this
codebase — the word "proof" does not appear in `packages/core/src/pq/`, and
this document exists partly to make that claim structurally hard to make by
accident.

What it is: an honest account of what is, and is not, resistant to a
cryptographically relevant quantum computer today, and one concrete,
additive step taken toward crypto-agility.

## The honest inventory

| Where a signature is used | Algorithm | Post-quantum? |
| --- | --- | --- |
| Wallet-signed `EconomicIntent` authorizations | secp256k1 ECDSA (EIP-712) | No |
| XRPL wallet ownership proofs | ed25519 or secp256k1 | No |
| EVM wallet ownership proofs | secp256k1 ECDSA | No |
| Agent Correspondent Credentials, primary signature | Ed25519 | No |
| Agent Correspondent Credentials, secondary attestation | ML-DSA-65 (FIPS 204) | **Yes** |
| TLS to this deployment | Whatever the hosting platform terminates with | Not controlled by this codebase |

The first four rows are **not changed by this work and cannot be**, for a
structural reason: an `EconomicIntent` is signed by whatever a user's wallet
supports — MetaMask, a hardware wallet, Xaman — and every wallet that exists
today signs with secp256k1 or ed25519. There is no post-quantum signature
scheme a real wallet can produce, so making intent authorization "post-quantum"
would mean either inventing a wallet nobody has, or silently downgrading
security by accepting an algorithm the actual signer never used. Neither is
acceptable, and this codebase does neither.

What *can* change without breaking wallet compatibility is a statement
*this platform* signs on its own — which is exactly what a credential is.

## What is actually built: a secondary attestation

`packages/core/src/pq/index.ts` — a small, explicit algorithm registry plus
ML-DSA-65 (FIPS 204, security category 3) sign/verify, via
`@noble/post-quantum` — the same audited family as `@noble/curves`, already
used for every other signature in this codebase. No cryptographic primitive
is implemented in this file; nothing here is custom cryptography.

Wired into Agent Correspondent Credentials (docs/AGENT_CREDENTIALS.md):
alongside its required Ed25519 signature, a credential can carry a **second,
independent signature over the identical bytes**, produced with ML-DSA.

### Purely additive, never a replacement

- A credential issued with no `CREDENTIAL_ISSUER_MLDSA_SEED` configured has
  `secondaryAttestation: null`, and is **exactly as valid** as one issued
  before this module existed.
- The credential's overall `valid` field is, and remains, governed by the
  required Ed25519 signature alone. A secondary attestation's own pass/fail
  is reported in its own field, never folded into `valid` — a broken
  secondary attestation is worth surfacing, but it must never look like the
  primary signature failed when it did not, or vice versa.
- Verifying it is entirely optional for a caller of
  `POST /api/v1/credentials/verify`: omit `secondaryAttestation` and nothing
  about the response changes.

### What it buys

If classical elliptic-curve cryptography is later broken by a
cryptographically relevant quantum computer — which has not happened, and
this codebase predicts neither when nor whether it will — a credential
carrying a secondary attestation remains independently verifiable through an
algorithm not vulnerable to the same attack. That is the entire claim. It is
not a claim about intent signing, wallet security, TLS, or anything else in
this system.

## Configuration

`CREDENTIAL_ISSUER_MLDSA_SEED` — 32 bytes of hex. The keypair is derived
fresh from the seed each time the process starts (`generateMlDsaKeypair`),
rather than a raw ~4KB secret key being held directly — one 32-byte value is
the operational surface, matching every other seed-based key in this
deployment.

Published at `GET /api/v1/credentials/issuer` alongside the primary key,
labelled with its exact standard (`"ML-DSA-65"`, `"FIPS 204"`) — never with
adjectives.

## Verification

`packages/core/test/pq.test.ts` — 11 tests: real keygen/sign/verify
round-trips, determinism from a fixed seed, a tampered message failing, a
signature checked against the wrong key failing, malformed input failing
rather than throwing, and that the registry's own algorithm descriptions
never use guarantee-shaped language.

`e2e/credentials.spec.ts` — a full round trip through the real issuance and
public verification endpoints (an issued credential's secondary attestation
verifies; the same document verifies with `valid: true` whether or not the
secondary attestation is supplied at all), and a check that the published
issuer endpoint names the exact standard rather than a marketing claim.

## Not yet built

- **ML-KEM** (FIPS 203, key encapsulation) — there is no encryption-at-rest
  or key-exchange use case in this codebase today that a KEM would improve;
  `@noble/post-quantum` also implements it, so adding it is a matter of need,
  not availability.
- **Hybrid transport** (a PQ KEM alongside classical TLS key exchange) — not
  controlled by this application; it is a property of the hosting platform's
  TLS termination.
- **A post-quantum wallet-signing path for `EconomicIntent`** — not possible
  without a wallet ecosystem that can produce one; see "the honest inventory"
  above.
- **SLH-DSA** (FIPS 205) as a second algorithm option — the registry
  (`ALGORITHMS`) is designed to make adding one an addition, not a rewrite,
  but nothing in the product currently needs a third scheme.
