# XRPL native Credentials

XLS-70 gives the XRPL its own credential primitive: an issuer creates a
credential for a subject, the subject accepts it, and a Permissioned Domain
(XLS-80) admits only holders of accepted credentials from named issuers.

`packages/adapters/src/xrpl-credentials.ts`.

## Two credential systems, deliberately

| | Agent Correspondent Credentials | XRPL Credentials |
| --- | --- | --- |
| Where | Off-ledger, signed Ed25519 | On the XRPL |
| Who verifies | Anyone, offline | The ledger, in consensus |
| Cost | None | A transaction fee, and a reserve |
| Revocable | Status list | `CredentialDelete` |
| Detail | Several claims per credential | A type code |
| Permanent | No — they expire | **Yes** |

The off-ledger one carries the detail. The on-ledger one is a *pointer*: it says
an agent holds a standing, so a Permissioned Domain or a counterparty's contract
can gate on it without reading anything about who is behind it.

## Nothing personal goes on a ledger

The XRPL is permanent and world-readable. There is no delete that un-publishes.

- `CredentialType` is an enumeration — `ACOR_CONTROLLER_VERIFIED`,
  `ACOR_SETTLEMENT_PERMITTED`, `ACOR_MANDATE_BOUND` — never free text.
- `URI` passes `checkLedgerUri()`, which accepts exactly two shapes: a bare
  `sha256:<hex>` digest, or an `https` URL with **no query string, no fragment
  and no userinfo**. `?email=` in a permanent record is not a mistake that can
  be undone.

## This module builds; it does not sign

Every function returns an unsigned transaction and a one-line summary for the
human approving it. Signing authority is not held by this process. A builder
that could submit would be a builder that could spend.

## What each transaction refuses

`CredentialCreate`
- A self-issued credential. It proves nothing and clutters a permanent ledger.
- A credential type this platform does not publish.
- An expiration that is not positive integer Ripple-epoch seconds.
- A `CredentialType` over 64 bytes or a `URI` over 256 — the field limits, so a
  node does not reject the transaction after a fee has been paid.

`CredentialAccept`
- Anything where `Account` is not the subject. Acceptance is the subject's and
  only the subject's — the ledger making the same distinction this codebase
  makes between a claim and a proof.

`CredentialDelete`
- Any account that is neither the issuer nor the subject.

`PermissionedDomainSet`
- An empty accepted list. A domain admitting nobody is a deletion, not a
  configuration, and building one by accident locks everyone out.
- Duplicates, and more than the ten entries XLS-80 allows.

## Reading

`readCredentials(client, account)` returns what the ledger says, **including
credentials issued but never accepted**, flagged rather than filtered.
"Issued to you but not accepted" is a meaningful state, and hiding it would
misrepresent the ledger.

`accepted` reads the `lsfAccepted` flag (`0x00010000`) rather than inferring
anything.

## Capability state

`XRPL.CREDENTIALS` is set by the adapter's live probe of the node's amendment
list. Amendments are not uniform across networks, so it is `AVAILABLE`,
`TESTNET_ONLY`, `DISABLED` or `UNKNOWN` from what the node actually reports —
never assumed. Where `feature` is an admin command the node will not answer, the
honest result is `UNKNOWN`, not "enabled".

## Not yet built

Submission. It needs a funded XRPL account and a signer, and this deployment has
neither — `XRPL_WS_URL` is unset. The builders and the reader are complete and
tested; nothing has been broadcast.

Also missing: reconciling an on-ledger credential against the off-ledger one it
points at, and re-issuing on-ledger when the off-ledger credential is revoked.

## Verification

`packages/adapters/test/xrpl-credentials.test.ts` — 14 tests, concentrated on
the refusals: every URI shape that could carry a person onto the ledger, a
self-issued credential, an acceptance signed by the wrong party, a deletion by a
stranger, and a domain that would admit nobody.
