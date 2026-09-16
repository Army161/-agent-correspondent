# ACOR

| Field | Value |
| --- | --- |
| Token name | Agent Correspondent |
| Ticker | ACOR |
| Network | Arc |
| Launch venue | Tolly |
| Contract address | **not yet deployed** |

## The contract address

There is no ACOR contract address yet. Any address you are shown anywhere — a
website, a DM, a reply, a group chat — is not ACOR.

The `/acor` page reads `NEXT_PUBLIC_ACOR_CONTRACT_ADDRESS` from configuration,
validates its shape, and displays **CONTRACT NOT YET DEPLOYED** when it is
absent. No address is hard-coded anywhere in this repository, and
`e2e/marketing.spec.ts` asserts that no 40-hex string appears on that page.

Fabricating an address would be the single most harmful thing this codebase
could do: an address on a token page is read as canonical, and anyone who sends
funds to a wrong one loses them.

After a verified deployment, set the variable to the canonical address. Do not
edit the page to hard-code it.

## Positioning

ACOR is an ecosystem and community utility token associated with Agent
Correspondent. The platform does not require it, and the product does not exist
to support it.

## Potential utility

Subject to implementation and legal review. None of it is committed:

- ecosystem access
- developer incentives
- agent incentives
- product testing
- future service discounts
- future platform utility

## What ACOR is not

- equity or any ownership interest in any entity
- dividends, revenue share, or profit participation
- guaranteed yield, return, or token appreciation
- redemption rights or a claim on any asset
- backing by stock, securities, or any company balance sheet
- exposure to NVIDIA or any other company
- approved, registered or endorsed by any regulator

## Risk disclosures

- Tokens can lose all of their value. You may lose everything you put in.
- Liquidity may be thin or disappear entirely; you may be unable to sell.
- Smart contracts can contain bugs that result in total, irreversible loss.
- Regulatory treatment of tokens varies by jurisdiction and can change.
- Impersonation and address-poisoning scams are common. Verify everything.

Nothing here or on the site is an offer, a solicitation, or financial,
investment, legal or tax advice.

## How to verify

1. Only trust a contract address published on agentcorrespondent.com and on
   [@AgentCorrespondent](https://x.com/AgentCorrespondent).
2. ACOR is intended to exist on Arc. An address on another chain claiming to be
   ACOR is not ACOR.
3. Compare the whole address, character by character. Address-poisoning attacks
   use lookalikes that match at the start and the end.
4. Nobody from Agent Correspondent will DM you a contract address, a sale, or an
   allocation.
5. Treat any link asking you to connect a wallet to claim ACOR as hostile.
