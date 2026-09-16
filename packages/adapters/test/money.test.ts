/**
 * Adapter money handling.
 *
 * The rail boundary is where a quantity stops being a number and starts being
 * a claim about someone's wallet, so these tests hold two properties:
 *
 *  1. Amounts are parsed exactly, with bigint arithmetic, at the asset's own
 *     scale. No `Number`, no `Math.round`, no silent truncation.
 *  2. A quantity of an asset is never reported as a quantity of dollars unless
 *     a registered peg says so.
 */

import { describe, expect, it } from "vitest";

import {
  amountToDecimalString,
  ARC_USDC,
  canonicalAssetId,
  formatAmount,
} from "@acor/core";

import { normalizeCircleBalances, type CircleBalancesPayload } from "../src/circle";
import { decodeCurrency } from "../src/xrpl";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function payload(
  ...tokens: { symbol: string; amount: string; decimals?: number; tokenAddress?: string }[]
): CircleBalancesPayload {
  return {
    data: {
      tokenBalances: tokens.map((token) => ({
        amount: token.amount,
        token: {
          symbol: token.symbol,
          ...(token.decimals !== undefined ? { decimals: token.decimals } : {}),
          ...(token.tokenAddress ? { tokenAddress: token.tokenAddress } : {}),
        },
      })),
    },
  };
}

const options = { address: "0xwallet", network: "ARC" as const, wanted: [], now: NOW };

describe("Circle balance normalization", () => {
  it("parses a USDC balance exactly, at USDC's scale", () => {
    const [reading] = normalizeCircleBalances(payload({ symbol: "USDC", amount: "12.345678" }), options);
    expect(reading?.amount.assetId).toBe(ARC_USDC);
    expect(reading?.amount.atomic).toBe(12_345_678n);
    expect(amountToDecimalString(reading!.amount)).toBe("12.345678");
  });

  it("does not lose the low digits of a balance beyond Number.MAX_SAFE_INTEGER", () => {
    // 9,007,199,254.740993 USDC is 9007199254740993 atomic units — one more
    // than Number.MAX_SAFE_INTEGER, so the float path cannot represent it.
    const [reading] = normalizeCircleBalances(
      payload({ symbol: "USDC", amount: "9007199254.740993" }),
      options,
    );
    expect(reading?.amount.atomic).toBe(9_007_199_254_740_993n);
    expect(reading?.amount.atomic).not.toBe(
      BigInt(Math.round(Number("9007199254.740993") * 10 ** 6)),
    );
  });

  it("handles the boundary values without drift", () => {
    for (const [amount, atomic] of [
      ["0", 0n],
      ["0.000001", 1n],
      ["1.000001", 1_000_001n],
      ["999999999999.999999", 999_999_999_999_999_999n],
    ] as const) {
      const [reading] = normalizeCircleBalances(payload({ symbol: "USDC", amount }), options);
      expect(reading?.amount.atomic, amount).toBe(atomic);
    }
  });

  it("drops a balance with more precision than the asset can hold, rather than rounding it", () => {
    // Rounding here would report a balance the wallet does not have.
    expect(normalizeCircleBalances(payload({ symbol: "USDC", amount: "1.0000001" }), options)).toHaveLength(0);
  });

  it("drops malformed and negative balances instead of coercing them", () => {
    for (const amount of ["", "abc", "1e6", "1,000", "-5"]) {
      expect(
        normalizeCircleBalances(payload({ symbol: "USDC", amount }), options),
        amount,
      ).toHaveLength(0);
    }
  });

  it("values USDC by its registered peg", () => {
    const [reading] = normalizeCircleBalances(payload({ symbol: "USDC", amount: "2.5" }), options);
    expect(reading?.usdValue?.nanos).toBe(2_500_000_000n);
    expect(reading?.usdValue?.source.kind).toBe("PEG");
  });

  it("ATTACK: reports an unregistered token's quantity but refuses to value it", () => {
    const [reading] = normalizeCircleBalances(
      payload({
        symbol: "USDX",
        amount: "1000",
        decimals: 18,
        tokenAddress: "0x00000000000000000000000000000000000000ff",
      }),
      options,
    );
    expect(reading?.amount.atomic).toBe(1000n * 10n ** 18n);
    // A symbol is not a peg. Nothing in this pipeline may decide that an
    // unknown contract is worth a thousand dollars.
    expect(reading?.usdValue).toBeNull();
  });

  it("ATTACK: does not treat a testnet balance as a mainnet one", () => {
    const [reading] = normalizeCircleBalances(payload({ symbol: "USDC", amount: "1" }), {
      ...options,
      network: "ARC_TESTNET",
    });
    expect(reading?.amount.assetId).toBe(canonicalAssetId("ARC_TESTNET", "USDC"));
    expect(reading?.amount.assetId).not.toBe(ARC_USDC);
  });

  it("filters to the requested assets", () => {
    const readings = normalizeCircleBalances(
      payload({ symbol: "USDC", amount: "1" }, { symbol: "EURC", amount: "2" }),
      { ...options, wanted: ["USDC"] },
    );
    expect(readings).toHaveLength(1);
    expect(readings[0]?.amount.symbol).toBe("USDC");
  });

  it("ATTACK: reports EURC as euros-denominated and refuses to call it dollars", () => {
    const [reading] = normalizeCircleBalances(payload({ symbol: "EURC", amount: "100" }), options);
    expect(formatAmount(reading!.amount)).toBe("100 EURC");
    expect(reading?.usdValue).toBeNull();
  });
});

describe("XRPL currency codes", () => {
  it("passes through standard three-character codes", () => {
    expect(decodeCurrency("USD")).toBe("USD");
    expect(decodeCurrency("xrp")).toBe("XRP");
  });

  it("decodes 40-character hex codes", () => {
    // "RLUSD" padded to 20 bytes.
    const hex = Buffer.from("RLUSD").toString("hex").padEnd(40, "0").toUpperCase();
    expect(decodeCurrency(hex)).toBe("RLUSD");
  });
});
