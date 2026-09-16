# Arc

Arc is the initial application and agent-contract rail: chain id **5042**, USDC
as the gas asset, ERC-8004 for agent identity and ERC-8183 for job workflow.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ARC_RPC_URL` | mainnet RPC endpoint |
| `ARC_CHAIN_ID` | defaults to 5042 |
| `ARC_USDC_ADDRESS` | USDC contract |
| `ARC_ERC8004_ADDRESS` | identity registry |
| `ARC_ERC8183_ADDRESS` | job registry |
| `ARC_INTENT_VERIFIER_ADDRESS` | the EIP-712 verifying contract |
| `ARC_NETWORK` | set to `testnet` to use the testnet variables below |

Testnet uses entirely separate variables — `ARC_TESTNET_RPC_URL`,
`ARC_TESTNET_USDC_ADDRESS`, `ARC_TESTNET_ERC8004_ADDRESS`,
`ARC_TESTNET_ERC8183_ADDRESS`, `ARC_TESTNET_INTENT_VERIFIER_ADDRESS` — never the
same field with a flag. `assertNetworkSeparation()` refuses to start a
production deployment pointed at testnet, and refuses a production chain id that
is not 5042.

## Probing

The adapter verifies rather than assumes:

1. Read the chain id from the RPC. If it disagrees with `ARC_CHAIN_ID`, the
   adapter reports `ERROR` and refuses the endpoint entirely.
2. Check that the configured USDC address has contract code. No code means
   `ARC.USDC_GAS` is `DISABLED`.
3. Check the identity and job registries the same way. An unconfigured address
   leaves the capability `UNKNOWN` — which the router treats as unusable.

Nothing is marked `AVAILABLE` because an address appears in an environment
variable.

## ERC-8004 — identity and reputation

Used for agent identity and reputation primitives:

```
agentId  owner  identityURI  wallet bindings
service endpoints  capabilities  reputation evidence
```

The platform's own reputation engine builds a higher-level score on top of
successful and failed jobs, paid value, disputes, evaluator results,
counterparty diversity, repeat customers and settlement completion — see
[ARCHITECTURE.md](./ARCHITECTURE.md).

**Raw ERC-8004 feedback is never rewritten.** It is an input the platform reads.

## ERC-8183 — job workflow

```
CREATE → FUND → WORK → SUBMIT → EVALUATE → COMPLETE/REJECT → SETTLE
```

Used for conditional and asynchronous work. **Not** used for every sub-cent API
call: the router sends those to a nanopayment rail or the μLedger, because an
on-chain job for a $0.0004 call costs more than the call.

The state machine is enforced in `packages/core/src/jobs/lifecycle.ts`, not
implied by which button the UI renders. Work cannot start before escrow is
funded, a job cannot settle before it completes, a settled job cannot settle
again, and a funded job cannot be unilaterally cancelled — the exit is a
dispute.

## Circle

Circle tooling is integrated where supported: agent wallets, programmable wallet
policies, USDC, x402, nanopayments. Credentials stay server-side.

**This is an integration against a public API. It does not imply endorsement,
affiliation or partnership.**
