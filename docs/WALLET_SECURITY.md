# Wallet security

Two rules, and everything else follows from them.

1. **This platform never holds a private key or a seed phrase for customer
   funds.** It does not ask for one, and there is no column to put one in.
2. **An address is a claim until someone proves they control it.**

## Why the second rule matters

Before it existed, binding a wallet took an address string. So anyone could
name an address they did not control as their agent's wallet. Two things follow
from that, and both are bad:

- The wallets page would show a stranger's balance as yours.
- More seriously, the relay resolves a provider's **payout destination** from
  its bound wallet. An unproved binding is a way to point a payment at an
  address whose owner never agreed to receive it.

## The proof

`packages/core/src/wallet/ownership.ts` — pure, tested against real signatures.

The message follows EIP-4361 (Sign-In with Ethereum) in shape, because wallets
render that format legibly and people have learned to read it. It is hashed per
EIP-191 `personal_sign`.

**The prefix is the point.** `\x19Ethereum Signed Message:\n<len>` cannot begin
an RLP-encoded transaction, so a signature collected here can never be replayed
as one. The user is signing a sentence, not a transfer, and that is structurally
true rather than a promise.

The message names four things, and a proof is worthless if any of them differ:

| Field | Stops |
| --- | --- |
| `domain` | a proof collected by another site |
| `Chain ID` | a proof collected for another chain |
| `Nonce` | replay of a proof already used |
| `Resources: - acor:agent:<id>` | a proof collected for another agent |

Every field is validated as printable ASCII before the message is built. A
newline in the domain or the statement would forge the lines below it — the
classic way to make a signed message say something other than what was read.

## The exchange

```
POST /api/v1/agents/{id}/wallets/challenge   → { nonce, message, expiresAt }
   wallet: personal_sign(message)
POST /api/v1/agents/{id}/wallets             → { bound: true, verified: true }
```

The challenge is stored server-side (`wallet_challenges`), single-use, and
expires in ten minutes.

**Consuming happens before verifying.** The row is claimed with a conditional
`UPDATE ... WHERE consumed_at IS NULL` that exactly one caller can win; only
then is the signature checked. Verifying first and burning afterwards would let
two concurrent requests both verify against an unconsumed row.

A failed signature leaves the challenge consumed. One challenge is one attempt,
so a wrong signature cannot be used to probe.

An unknown nonce, an already-used nonce, and a nonce issued for a different
agent all return the same `CHALLENGE_UNKNOWN`. Distinguishing them would let
someone probe for live nonces.

## Custody models

| Custody | Proof | Can sign | Can receive a payout |
| --- | --- | --- | --- |
| `external` | Required | Yes | Yes |
| `readonly` | None | No | No |
| `circle` | The provider's, once wired | — | — |

A `readonly` binding is accepted without proof and stored **unverified**, so an
address can be watched without claiming it. The API returns `verified` as an
explicit boolean rather than leaving it to be inferred from a null timestamp: a
consumer that ignores the field should not accidentally treat a claim as a
proved binding. The wallets page marks it UNVERIFIED.

## What the relay does with this

`apps/web/src/lib/relay/index.ts`:

- `authorizeSigner` requires a bound wallet **whose `verified_at` is set**. A
  valid signature from an unbound wallet proves someone signed; it does not make
  them entitled to this agent's balance. A binding without proof is no better.
- `lookupProvider` resolves a payout destination only from a verified wallet on
  that network. No verified wallet means not payable, rather than payable to
  whatever was typed in.

## The browser flow

`apps/web/src/components/wallets/connect.tsx` uses the injected EIP-1193
provider: `eth_requestAccounts`, then `personal_sign`.

The component's claim about which address it connected is not trusted — the
server re-derives the address from the signature and compares it to the address
the challenge was issued for.

WalletConnect needs a Reown project id. Without `NEXT_PUBLIC_REOWN_PROJECT_ID`
the page says so and offers only a browser-injected wallet, rather than showing
a button that cannot work.

## Signature rules

Shared with intent authorization, in `packages/core/src/crypto/ecdsa.ts`. One
implementation, so the rules hold identically in both places — two
implementations means two sets of rules eventually.

- 65 bytes, `r ‖ s ‖ v`, with `v` as 27/28 or 0/1.
- `r` and `s` non-zero.
- **Low `s` only.** Every `(r, s)` has a valid complementary `(r, n - s)`.
  Accepting both would give one authorization two distinct encodings, and
  anything keyed on the signature bytes would see two different things.

## Verification

`packages/core/test/wallet-ownership.test.ts` — 14 tests with real secp256k1
signatures from viem: a stranger's key, a proof moved to another agent, another
chain, another domain, an expired challenge, a clock-skewed one, malformed
signatures, and a deliberately malleated high-`s` signature.

`e2e/wallets.spec.ts` — the exchange through the real API: binding refused with
no proof, accepted with one, refused with a stranger's signature, refused on
replay, refused when moved to another agent, refused across organizations, and
a watch-only address stored unverified.

## Not yet built

- WalletConnect / Reown (needs a project id).
- XRPL wallet binding (a different signature scheme — see docs/XRPL.md).
- Circle programmable wallets (needs credentials).
- Rotating a bound wallet, which should require a fresh session as well as a
  proof.
