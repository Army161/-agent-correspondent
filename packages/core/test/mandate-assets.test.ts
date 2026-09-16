/**
 * Mandate enforcement over asset-native amounts.
 *
 * Mandates are denominated in USD, which is a deliberate choice: an operator
 * reasons about "a dollar a day", not about drops and wei. The consequence is
 * that a spend in a non-USD asset can only be checked once it has been valued,
 * and a spend that cannot be valued cannot be checked — so it is denied.
 *
 * These tests exist because the obvious wrong implementation (treat one XRP as
 * one dollar because the number looks like a number) passes every USD test.
 */

import { describe, expect, it } from "vitest";

import {
  amountFromAtomic,
  ARC_USDC,
  canonicalAssetId,
  parseAmount,
  XRPL_RLUSD,
  XRPL_XRP,
} from "../src/assets/index";
import type { PriceQuote } from "../src/assets/valuation";
import { unwrap } from "../src/errors/index";
import { evaluateMandate, type MandateContext } from "../src/mandate/engine";
import { economicMandateSchema } from "../src/mandate/schema";
import { usd } from "../src/units/money";

const NOW = new Date("2026-03-01T12:00:00.000Z");

const mandate = economicMandateSchema.parse({
  dailySpendLimitUsd: "100",
  maxTransactionUsd: "5",
  minimumReserveUsd: "0",
  unverifiedCounterpartyLimitUsd: "0.05",
  humanApprovalAboveUsd: "50",
  creditAllowed: false,
  tokenTradingAllowed: false,
  allowedAssets: ["USDC", "RLUSD", "XRP"],
  allowedNetworks: ["ARC", "XRPL"],
});

const context: MandateContext = {
  availableBalance: usd("500"),
  spentToday: 0n,
  now: NOW,
};

const verified = { counterpartyVerified: true } as const;

describe("USD-pegged assets need no oracle", () => {
  it("allows a USDC spend inside every limit, valued by its registered peg", () => {
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("1.00", ARC_USDC)), ...verified },
      context,
    );
    expect(decision.decision).toBe("ALLOW");
    expect(decision.valuation?.source.kind).toBe("PEG");
  });

  it("values RLUSD on XRPL at its 15-decimal scale without losing the peg", () => {
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("2.50", XRPL_RLUSD)), ...verified },
      context,
    );
    expect(decision.decision).toBe("ALLOW");
    expect(decision.valuation?.nanos).toBe(usd("2.50"));
  });

  it("still enforces the per-transaction ceiling on a pegged asset", () => {
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("5.01", ARC_USDC)), ...verified },
      context,
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.violations.map((v) => v.code)).toContain("MAX_TRANSACTION_EXCEEDED");
  });
});

describe("ATTACK: treating a non-USD asset as dollars", () => {
  it("DENIES an XRP spend when no price is available, rather than calling 1 XRP $1", () => {
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("1", XRPL_XRP)), ...verified },
      context,
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.violations.map((v) => v.code)).toContain("VALUATION_UNAVAILABLE");
    expect(decision.valuation).toBeUndefined();
  });

  it("DENIES an XRP spend that is small in XRP but large in dollars", () => {
    // 3 XRP at $2.50 is $7.50 — above the $5 per-transaction ceiling. An
    // implementation that read "3" as "$3" would have allowed it.
    const quote: PriceQuote = {
      assetId: XRPL_XRP,
      usdNanosPerUnit: usd("2.50"),
      asOf: NOW,
      source: "test-oracle",
    };
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("3", XRPL_XRP)), quote, ...verified },
      context,
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.violations.map((v) => v.code)).toContain("MAX_TRANSACTION_EXCEEDED");
    expect(decision.valuation?.nanos).toBe(usd("7.50"));
  });

  it("ALLOWS the same XRP quantity when the price makes it small in dollars", () => {
    const quote: PriceQuote = {
      assetId: XRPL_XRP,
      usdNanosPerUnit: usd("0.50"),
      asOf: NOW,
      source: "test-oracle",
    };
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("3", XRPL_XRP)), quote, ...verified },
      context,
    );
    expect(decision.decision).toBe("ALLOW");
    expect(decision.valuation?.nanos).toBe(usd("1.50"));
  });

  it("DENIES on a stale price rather than spending against yesterday's rate", () => {
    const quote: PriceQuote = {
      assetId: XRPL_XRP,
      usdNanosPerUnit: usd("0.50"),
      asOf: new Date(NOW.getTime() - 3_600_000),
      source: "test-oracle",
    };
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("3", XRPL_XRP)), quote, ...verified },
      context,
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.violations.map((v) => v.code)).toContain("VALUATION_STALE");
  });

  it("DENIES EURC without a rate, because EURC is not a dollar", () => {
    const eurcMandate = economicMandateSchema.parse({
      ...mandate,
      dailySpendLimitUsd: "100",
      maxTransactionUsd: "5",
      minimumReserveUsd: "0",
      unverifiedCounterpartyLimitUsd: "0.05",
      humanApprovalAboveUsd: "50",
      allowedAssets: ["EURC"],
      allowedNetworks: ["ARC"],
    });
    const decision = evaluateMandate(
      eurcMandate,
      { amount: unwrap(parseAmount("1", canonicalAssetId("ARC", "EURC"))), ...verified },
      context,
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.violations.map((v) => v.code)).toContain("VALUATION_UNAVAILABLE");
  });
});

describe("allowlists apply to the asset's identity, not its symbol", () => {
  it("denies an asset whose symbol is allowed but whose network is not", () => {
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("1", canonicalAssetId("ARC_TESTNET", "USDC"))), ...verified },
      context,
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.violations.map((v) => v.code)).toContain("NETWORK_NOT_ALLOWED");
  });

  it("denies an unregistered look-alike token even though its symbol matches", () => {
    const impostor = amountFromAtomic(1_000_000n, ARC_USDC);
    const decision = evaluateMandate(
      mandate,
      {
        amount: { ...impostor, assetId: "ARC:USDC:0xbad", contract: "0xbad" },
        ...verified,
      },
      context,
    );
    expect(decision.decision).toBe("DENY");
    // Unregistered means unpegged, so it cannot be valued and cannot be spent.
    expect(decision.violations.map((v) => v.code)).toContain("VALUATION_UNAVAILABLE");
  });
});

describe("fail-closed still holds over the new model", () => {
  it("denies a zero or negative asset amount", () => {
    for (const value of ["0", "-1"]) {
      const decision = evaluateMandate(
        mandate,
        { amount: unwrap(parseAmount(value, ARC_USDC)), ...verified },
        context,
      );
      expect(decision.decision).toBe("DENY");
    }
  });

  it("denies when the balance is unknown", () => {
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("1", ARC_USDC)), ...verified },
      { ...context, availableBalance: null },
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.violations.map((v) => v.code)).toContain("CONTEXT_INCOMPLETE");
  });

  it("denies when today's spend is unknown", () => {
    const decision = evaluateMandate(
      mandate,
      { amount: unwrap(parseAmount("1", ARC_USDC)), ...verified },
      { ...context, spentToday: null },
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.violations.map((v) => v.code)).toContain("CONTEXT_INCOMPLETE");
  });
});
