# The money model

The single most important type distinction in this system:

> **A quantity of an asset is not a number of dollars.**

One XRP is one XRP. It becomes a dollar figure only when a registered peg policy
or a live price says so — and when neither exists, there is no dollar figure and
the system says so rather than inventing one.

This document describes the two types that encode that distinction and the rules
that govern converting between them.

## The two types

### `AssetAmount` — a quantity

```ts
interface AssetAmount {
  assetId: AssetId;      // "ARC:USDC", "XRPL:RLUSD:rIssuer..."
  symbol: string;        // "USDC"
  network: NetworkId;    // "ARC"
  atomic: bigint;        // integer count of the smallest unit
  decimals: number;      // that unit's scale
  issuer?: string;       // XRPL issuing account
  contract?: string;     // EVM contract address
}
```

It is **self-describing**: symbol, network, scale and issuer travel with the
number, so it survives a database round trip, a JSON payload or a queue without
a registry lookup on the far side. An atomic quantity without its scale is
meaningless, and a quantity without its asset is how one XRP becomes one dollar.

Arithmetic between different assets is refused, not coerced. Adding XRP to USDC
is a category error, not a rounding question.

### `UsdValue` — an opinion about a quantity

```ts
interface UsdValue {
  nanos: Nanos;            // integer nanodollars
  asOf: Date;              // when this was true
  source: ValuationSource; // PEG | ORACLE | MANUAL
  staleAfterSeconds?: number;
}
```

A `UsdValue` is always *about* an `AssetAmount`, never a substitute for it. The
two are separate types precisely so they cannot be confused.

## Asset identity

An asset is identified by network, symbol **and** issuer or contract:

```
ARC:USDC                      — USDC on Arc
ARC_TESTNET:USDC              — a different asset entirely
XRPL:RLUSD                    — RLUSD as an XRPL issued currency
XRPL:RLUSD:rSomeOtherIssuer   — someone else's token called RLUSD
```

Two USDCs on two networks are two assets with different issuers and different
failure modes. A contract that merely *calls itself* USDC is a third thing.

## Peg policy

A peg is a **registered policy**, never an inference from a symbol:

```ts
{ kind: "USD_PAR", authority: "Circle", note: "..." }   // one unit is one dollar
{ kind: "NONE",    note: "requires a price" }           // no dollar figure without an oracle
```

| Asset | Peg | Why |
| --- | --- | --- |
| `ARC:USDC` | USD_PAR (Circle) | full-reserve USD stablecoin |
| `ARC:RLUSD`, `XRPL:RLUSD` | USD_PAR (Ripple) | USD stablecoin |
| `ARC:EURC` | NONE | **tracks the euro.** A USD figure needs a EUR/USD rate |
| `XRPL:XRP` | NONE | floating price; there is no peg |
| unregistered token | NONE | a symbol is not a peg |

`isUsdPegged("ARC:USDC")` is true because a line in the registry says so, with an
attributable authority. An unknown token named `USDC` gets nothing.

## Valuation rules

`valueInUsd(amount, { now, quote, maxQuoteAgeSeconds })`:

1. **A registered peg wins over a quote.** A peg is a deliberate policy
   decision; a quote is a market observation that can be manipulated. An oracle
   price for USDC would be a way to talk the system into a different number for
   a dollar.
2. **No peg and no quote → `VALUATION_UNAVAILABLE`.** Not zero, not a guess.
3. **A quote for the wrong asset → `ASSET_MISMATCH`.**
4. **A quote older than the limit → `VALUATION_STALE`.** Default 60 seconds.
5. **A non-positive price → refused.**
6. **Truncation is toward zero**, so a valuation never rounds up in the payer's
   disfavour.

## Consequences for mandates

Mandate limits are dollar figures, because operators reason in dollars: "a
dollar a day", not "a million drops a day". So a spend must become a dollar
figure before it can be tested — and **a spend that cannot be valued cannot be
checked, so it is denied.**

```
3 XRP, no price          → DENY  VALUATION_UNAVAILABLE
3 XRP @ $2.50            → DENY  MAX_TRANSACTION_EXCEEDED ($7.50 > $5)
3 XRP @ $0.50            → ALLOW ($1.50)
3 XRP @ $2.50, an hour old → DENY VALUATION_STALE
1 EURC, no rate          → DENY  VALUATION_UNAVAILABLE
```

The middle case is the one that matters: an implementation that read "3" as "$3"
would have allowed a $7.50 spend against a $5 ceiling.

The engine accepts either form. `AssetMandateRequest` carries an `AssetAmount`
and is valued by the engine; `UsdMandateRequest` carries nanodollars the caller
has already established — used where the amount genuinely originates in dollars,
such as an operator asking "could this agent spend five dollars?".

## Consequences for intents

An intent's `maxSpend`, `minReceive` and `maxNetworkFee` are **atomic units of
its settlement asset**, not dollars:

```
0.025 USDC  → 25_000              (6 decimals)
1 RLUSD     → 1_000_000_000_000_000_000  (18 decimals on Arc)
1 XRP       → 1_000_000           (drops)
```

A single shared dollar scale would have made the first two identical. The
EIP-712 message carries these numbers unchanged, because they are exactly what a
contract moves — which also means the digest for a USDC intent is byte-identical
to what it was before this model existed.

Compiling an intent in an unregistered asset is refused: without a registered
scale, `25000` could mean any quantity.

## The μLedger's scale

μLedger accounting assets (`MULEDGER:USD`, `MULEDGER:USDC`, `MULEDGER:RLUSD`)
carry **9 decimals**, finer than any rail. That is the point: a 40-nanodollar
obligation is 0.04 of a single USDC atomic unit and is not representable on Arc
at all until many of them have been netted together.

## Database representation

Every amount is stored as a triple, and a USD valuation as another:

```
<x>_atomic     numeric(78,0)   -- uint256 needs 78 digits
<x>_asset_id   varchar(128)
<x>_decimals   integer

<x>_usd_nanos  numeric(38,0)
<x>_usd_source varchar(128)    -- "PEG:Circle", "ORACLE:name", "MIGRATION:..."
<x>_usd_as_of  timestamptz
```

Two database-level controls, because convention is not a control
(`0004_require_asset_identity.sql`):

- An INSERT without the full asset triple is rejected.
- A USD figure without a source and a timestamp is rejected: a dollar figure
  with no provenance is indistinguishable from one that was invented.

The legacy `*_nanos` columns are retained and deprecated. Migration `0003`
backfills the new columns by rescaling from 9 decimals to each asset's real
scale, and **only carries the old USD figure over for USD-par assets** — a row
recording 1 XRP held `1000000000` in a column labelled nanodollars, and carrying
that over would have asserted that one XRP is one dollar.

## Exact decimal conversion

`parseDecimalToAtomic` and `formatAtomic` are pure bigint. There is no float
path, deliberately. The pattern they replace —

```ts
BigInt(Math.round(Number(amount) * 10 ** decimals))
```

— is wrong three times over: `Number` loses precision above 2^53 (an 18-decimal
token exceeds it at about 0.009 tokens), the multiplication introduces binary
rounding error, and `Math.round` conceals both.

Excess precision is an error, not a rounding opportunity. Rounding requires an
explicit direction: `"down"` toward negative infinity, `"up"` toward positive
infinity, so a fee rounded up is always at least the true fee and a payout
rounded down never exceeds it.
