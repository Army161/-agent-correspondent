# XRPL

XRPL is the cross-currency and cross-border rail: native XRP, RLUSD, and USDC
where supported, with pathfinding for atomic conversion and escrow for
conditional delivery.

## Configuration

| Variable | Purpose |
| --- | --- |
| `XRPL_WS_URL` | node WebSocket endpoint |
| `XRPL_NETWORK` | `testnet` to mark this deployment as testnet |
| `XRPL_RLUSD_ISSUER` | RLUSD issuing account |
| `XRPL_SOURCE_TAG` | source tag applied to outgoing payments |

## Amendment gating

Most of what XRPL can do is amendment-gated, and amendments are not uniform
across networks. The adapter probes the connected node and writes what it finds
into the capability engine:

| Capability | Amendment |
| --- | --- |
| `XRPL.PAYMENT_CHANNELS` | PayChan |
| `XRPL.MPT` | MPTokensV1 |
| `XRPL.CREDENTIALS` | Credentials |
| `XRPL.DID` | DID |
| `XRPL.PRICE_ORACLE` | PriceOracle |
| `XRPL.LENDING` | LendingProtocol |
| `XRPL.PERMISSION_DELEGATION` | PermissionDelegation |
| `XRPL.SPONSOR` | FeeSponsor |
| `XRPL.BATCH` | Batch |
| `XRPL.PERMISSIONED_DEX` | PermissionedDEX |

Payments, pathfinding and escrow are core protocol and are marked live wherever
a node answers `server_info`.

The `feature` command is admin-only on many nodes. When it is unavailable, every
amendment-gated capability stays `UNKNOWN` — the honest answer — and the router
will not route through any of them. It does not assume "probably enabled".

RLUSD requires a configured issuer: without one we cannot form a valid
issued-currency amount, so the capability stays `UNKNOWN`.

## Balances

`account_info` gives the XRP balance in drops; `account_lines` gives issued
currencies, with 40-character hex currency codes decoded to symbols.

**XRP is not a dollar.** The reading carries the XRP amount; converting it to a
dollar figure needs a price oracle this deployment does not have, so the UI
shows the XRP balance and no USD equivalent rather than inventing a rate.

## Settlement

Preparation and validation are implemented. Submission requires a funded,
key-bearing XRPL account, and this process holds no seeds — see
[SECURITY.md](./SECURITY.md). Payments are prepared here and signed by the
configured wallet provider.

## Future work

Payment channels, MPT, credentials, DID, price oracle, lending, permission
delegation, sponsored fees and the permissioned DEX all route through
`ProtocolCapabilityEngine`. None executes until a live probe confirms the
amendment is enabled on the connected network.
