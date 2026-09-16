# Economic intents

An `EconomicIntent` is the unit of authorization. It is what gets signed, and it
is the only thing a settlement adapter is allowed to act on. Everything the
executor may do is inside the struct; anything not stated is forbidden.

## Fields

| Field | Meaning |
| --- | --- |
| `intentId` | derived from the content — the same request compiled twice is one intent |
| `version` | protocol version; a change to the signed layout requires a bump |
| `buyerAgentId` / `providerAgentId` | the two parties; they must differ |
| `service` | human-readable service identifier |
| `serviceHash` | hash of the full work request the provider must perform |
| `maxSpend` | hard ceiling on everything leaving the buyer, **in settlement-asset atomic units**, fees included |
| `minReceive` | floor on what the provider must receive, in settlement-asset atomic units |
| `settlementAsset` | the asset; substituting it invalidates the authorization |
| `allowedRails` | the rails this authorization permits |
| `maxFxSlippageBps` | tolerated drift from the quoted received amount |
| `maxNetworkFee` | ceiling on gas/network fees |
| `evaluator` | who decides whether the work passed |
| `deadline` | latest second the work may be performed |
| `nonce` | 32 bytes; single use |
| `createdAt` / `expiresAt` | authorization window |
| `chainId` | binds the signature to one chain |
| `verifyingContract` | binds the signature to one contract |
| `destination` | exact payout destination |
| `network` | the network the payout must occur on |

## Replay resistance

Four distinct mechanisms, because each closes a different door:

1. **Nonce.** Burned on acceptance, keyed by
   `(signer, chainId, verifyingContract, nonce)`. Never released, including on
   cancellation — releasing a burned nonce would reopen the window it exists to
   close.
2. **Chain binding.** `chainId` is inside the EIP-712 domain, so a signature
   produced for Arc is meaningless on any other chain.
3. **Contract binding.** `verifyingContract` is in the domain too, so a
   signature for one verifier cannot be replayed into another.
4. **Expiry.** `expiresAt` is checked at submission and again at execution, and
   the work `deadline` must fall inside the authorization window — otherwise a
   provider could deliver work that can no longer be paid for.

## Signing

Intents are signed as EIP-712 typed data. The encoder lives in
`packages/core/src/intent/eip712.ts` and is written out explicitly rather than
derived from whatever fields happen to be on the object, so the struct the UI
shows, the struct we hash, and the struct a contract decodes are the same
struct.

One conversion happens during compilation, and it is deliberate: free-form
identifiers (agent ids, asset symbol, evaluator, destination, network, rail
list) are `keccak256`-hashed into `bytes32`. Truncating them into 32 bytes would
let `agent_184a` and `agent_184b` collide.

Amounts need no conversion. An intent already carries them as atomic units of
its settlement asset — `0.025` USDC is parsed as `25000` at compile time, and
`1` RLUSD as `1e18` — which is exactly what a contract moves. A single shared
dollar scale would have made those two identical. Parsing is **exact**; an
amount the rail cannot represent fails compilation rather than being rounded,
and an intent in an unregistered asset cannot be compiled at all, because
without a registered scale the number means nothing.

The rail allowlist is canonicalized (deduplicated and sorted) before hashing, so
`["X402","MULEDGER"]` and `["MULEDGER","X402"]` are the same authorization and
produce the same digest.

## Deterministic parity

`packages/core/test/intent.test.ts` asserts that this encoder and viem's
independent `hashTypedData` produce byte-identical digests. If they ever
diverge, a wallet would be signing something other than what the interface
displayed — the failure this whole layer exists to prevent.

The same test asserts that changing *any* economic field changes the digest:
amount, destination, asset, network, nonce, deadline, expiry, evaluator,
provider, slippage, chain id and verifying contract.

## The off-chain hash is not the on-chain digest

`intentHash()` is a domain-separated SHA-256 over the canonical JSON document,
used for storage, audit and deduplication. `hashIntent()` is the EIP-712 digest
a wallet signs. They are different commitments to the same document and must
never be confused; the test suite asserts they differ.

## Lifecycle

```
compile ──► AWAITING_SIGNATURE ──► relay accepts ──► OPEN
                                                      │
                             ┌────────────────────────┼───────────────┐
                             ▼                        ▼               ▼
                          CONSUMED               CANCELLED        EXPIRED
```

The nonce is burned on acceptance and stays burned in all three terminal
states.
