/**
 * Asset identity, asset-native amounts, and USD valuation.
 *
 * The property under test throughout: **a quantity of an asset is not a number
 * of dollars.** One XRP is one XRP. It becomes a dollar figure only when a
 * registered peg policy or a live oracle says so, and never because a symbol
 * looked familiar.
 */

import { describe, expect, it } from "vitest";

import {
  addAmounts,
  amountFromAtomic,
  ARC_USDC,
  assetDefinition,
  canonicalAssetId,
  compareAmounts,
  formatAmount,
  isUsdPegged,
  parseAmount,
  registerAsset,
  XRPL_RLUSD,
  XRPL_XRP,
  type AssetAmount,
} from "../src/assets/index";
import { valueInUsd, type PriceQuote } from "../src/assets/valuation";
import { unwrap } from "../src/errors/index";
import { usd } from "../src/units/money";

const NOW = new Date("2026-03-01T12:00:00.000Z");

describe("asset identity", () => {
  it("scopes an asset to its network, so two USDCs are not one asset", () => {
    expect(canonicalAssetId("ARC", "USDC")).not.toBe(canonicalAssetId("XRPL", "USDC"));
  });

  it("scopes an XRPL issued currency to its issuer", () => {
    const a = canonicalAssetId("XRPL", "RLUSD", "rIssuerOne");
    const b = canonicalAssetId("XRPL", "RLUSD", "rIssuerTwo");
    expect(a).not.toBe(b);
  });

  it("knows the real decimal scale of each registered asset", () => {
    expect(assetDefinition(ARC_USDC)?.decimals).toBe(6);
    expect(assetDefinition(XRPL_XRP)?.decimals).toBe(6); // drops
    expect(assetDefinition(XRPL_RLUSD)?.decimals).toBe(15); // XRPL issued-currency precision
  });

  it("returns undefined for an unregistered asset rather than guessing", () => {
    expect(assetDefinition(canonicalAssetId("ARC", "SCAMCOIN"))).toBeUndefined();
  });
});

describe("peg policy", () => {
  it("treats USDC and RLUSD as USD-par, because that is registered explicitly", () => {
    expect(isUsdPegged(ARC_USDC)).toBe(true);
    expect(isUsdPegged(XRPL_RLUSD)).toBe(true);
  });

  it("does NOT treat XRP as a dollar", () => {
    expect(isUsdPegged(XRPL_XRP)).toBe(false);
  });

  it("does NOT treat EURC as a dollar — it tracks a different currency", () => {
    expect(isUsdPegged(canonicalAssetId("ARC", "EURC"))).toBe(false);
  });

  it("does not infer a peg from a familiar-looking symbol", () => {
    const impostor = registerAsset({
      symbol: "USDC",
      network: "ARC",
      decimals: 6,
      kind: "ERC20",
      contract: "0x00000000000000000000000000000000000000ff",
      peg: { kind: "NONE", note: "unregistered contract calling itself USDC" },
    });
    expect(isUsdPegged(impostor.id)).toBe(false);
  });
});

describe("asset-native amounts", () => {
  it("parses at the asset's own scale, not at a dollar scale", () => {
    const oneXrp = unwrap(parseAmount("1", XRPL_XRP));
    expect(oneXrp.atomic).toBe(1_000_000n); // one million drops
    expect(oneXrp.decimals).toBe(6);
    expect(formatAmount(oneXrp)).toBe("1 XRP");
  });

  it("is self-describing, so it survives a database round trip", () => {
    const amount = unwrap(parseAmount("0.021", ARC_USDC));
    expect(amount).toMatchObject({
      assetId: ARC_USDC,
      symbol: "USDC",
      network: "ARC",
      atomic: 21_000n,
      decimals: 6,
    });
  });

  it("refuses to add two different assets", () => {
    const xrp = unwrap(parseAmount("1", XRPL_XRP));
    const usdc = unwrap(parseAmount("1", ARC_USDC));
    const result = addAmounts(xrp, usdc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("ASSET_MISMATCH");
  });

  it("refuses to compare two different assets", () => {
    const xrp = unwrap(parseAmount("1", XRPL_XRP));
    const usdc = unwrap(parseAmount("1", ARC_USDC));
    expect(compareAmounts(xrp, usdc).ok).toBe(false);
  });

  it("adds and compares same-asset amounts exactly", () => {
    const a = unwrap(parseAmount("0.021", ARC_USDC));
    const b = unwrap(parseAmount("0.004", ARC_USDC));
    expect(unwrap(addAmounts(a, b)).atomic).toBe(25_000n);
    expect(unwrap(compareAmounts(a, b))).toBe(1);
  });

  it("rejects precision an asset cannot carry", () => {
    expect(parseAmount("0.0000001", ARC_USDC).ok).toBe(false);
  });
});

describe("USD valuation", () => {
  const xrp = (value: string): AssetAmount => unwrap(parseAmount(value, XRPL_XRP));

  it("values a USD-pegged asset by its registered peg, with no oracle", () => {
    const value = unwrap(valueInUsd(unwrap(parseAmount("0.021", ARC_USDC)), { now: NOW }));
    expect(value.nanos).toBe(usd("0.021"));
    expect(value.source.kind).toBe("PEG");
  });

  it("ATTACK: refuses to value XRP without a price, rather than calling it $1", () => {
    const result = valueInUsd(xrp("1"), { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("VALUATION_UNAVAILABLE");
  });

  it("ATTACK: refuses to value EURC as USD without a rate", () => {
    const eurc = unwrap(parseAmount("1", canonicalAssetId("ARC", "EURC")));
    expect(valueInUsd(eurc, { now: NOW }).ok).toBe(false);
  });

  it("values a non-pegged asset from a fresh oracle quote", () => {
    const quote: PriceQuote = {
      assetId: XRPL_XRP,
      usdNanosPerUnit: usd("2.50"),
      asOf: NOW,
      source: "test-oracle",
    };
    const value = unwrap(valueInUsd(xrp("4"), { now: NOW, quote }));
    expect(value.nanos).toBe(usd("10.00"));
    expect(value.source.kind).toBe("ORACLE");
    expect(value.source).toMatchObject({ kind: "ORACLE", name: "test-oracle" });
  });

  it("ATTACK: refuses a stale quote rather than using yesterday's price", () => {
    const quote: PriceQuote = {
      assetId: XRPL_XRP,
      usdNanosPerUnit: usd("2.50"),
      asOf: new Date(NOW.getTime() - 3_600_000),
      source: "test-oracle",
    };
    const result = valueInUsd(xrp("4"), { now: NOW, quote, maxQuoteAgeSeconds: 60 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("VALUATION_STALE");
  });

  it("ATTACK: refuses a quote for a different asset", () => {
    const quote: PriceQuote = {
      assetId: ARC_USDC,
      usdNanosPerUnit: usd("1"),
      asOf: NOW,
      source: "test-oracle",
    };
    const result = valueInUsd(xrp("4"), { now: NOW, quote });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("ASSET_MISMATCH");
  });

  it("ATTACK: refuses a non-positive price", () => {
    for (const price of [0n, -1n]) {
      const quote: PriceQuote = {
        assetId: XRPL_XRP,
        usdNanosPerUnit: price,
        asOf: NOW,
        source: "test-oracle",
      };
      expect(valueInUsd(xrp("4"), { now: NOW, quote }).ok).toBe(false);
    }
  });

  it("values a quantity with a fractional price without float error", () => {
    // 3 XRP at $0.333333333 is $0.999999999 exactly — not $1.
    const quote: PriceQuote = {
      assetId: XRPL_XRP,
      usdNanosPerUnit: usd("0.333333333"),
      asOf: NOW,
      source: "test-oracle",
    };
    expect(unwrap(valueInUsd(xrp("3"), { now: NOW, quote })).nanos).toBe(usd("0.999999999"));
  });

  it("rounds a sub-nanodollar valuation down, never up, for a spend", () => {
    // 1 drop of XRP at $2.50 is $0.0000025 — representable. Half a nanodollar
    // is not, and must not be rounded in the payer's disfavour.
    const quote: PriceQuote = {
      assetId: XRPL_XRP,
      usdNanosPerUnit: 1n, // $0.000000001 per XRP
      asOf: NOW,
      source: "test-oracle",
    };
    const value = unwrap(valueInUsd(amountFromAtomic(1n, XRPL_XRP), { now: NOW, quote }));
    expect(value.nanos).toBe(0n);
  });

  it("carries the valuation timestamp and source for the audit trail", () => {
    const value = unwrap(valueInUsd(unwrap(parseAmount("1", ARC_USDC)), { now: NOW }));
    expect(value.asOf).toEqual(NOW);
    expect(value.source).toMatchObject({ kind: "PEG" });
  });
});
