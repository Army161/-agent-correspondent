/**
 * Mandate engine tests, written as attacks.
 *
 * Each case is an attempt to get money out of an agent that its human owner did
 * not authorize. The test passes when the attack fails.
 */

import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/canonical/json";
import { evaluateMandate, type MandateContext } from "../src/mandate/engine";
import { economicMandateSchema, DEFAULT_MANDATE } from "../src/mandate/schema";
import { usd } from "../src/units/money";

const mandate = economicMandateSchema.parse({
  dailySpendLimitUsd: "100",
  maxTransactionUsd: "5",
  minimumReserveUsd: "20",
  unverifiedCounterpartyLimitUsd: "0.05",
  humanApprovalAboveUsd: "50",
  creditAllowed: false,
  tokenTradingAllowed: false,
  allowedAssets: ["USDC", "RLUSD"],
  allowedNetworks: ["ARC", "XRPL"],
});

const healthy: MandateContext = {
  availableBalance: usd("500"),
  spentToday: usd("10"),
};

const baseRequest = {
  amount: usd("1"),
  asset: "USDC",
  network: "ARC" as const,
  counterpartyVerified: true,
};

function codes(decision: ReturnType<typeof evaluateMandate>): string[] {
  return decision.violations.map((v) => v.code);
}

describe("mandate engine — the happy path exists", () => {
  it("allows a spend that satisfies every rule", () => {
    const decision = evaluateMandate(mandate, baseRequest, healthy);
    expect(decision.decision).toBe("ALLOW");
    expect(decision.violations).toHaveLength(0);
  });

  it("returns a complete rule trace for the audit log", () => {
    const decision = evaluateMandate(mandate, baseRequest, healthy);
    const rules = decision.checks.map((check) => check.rule);
    expect(rules).toContain("transaction.max");
    expect(rules).toContain("daily.limit");
    expect(rules).toContain("reserve.floor");
    expect(rules).toContain("counterparty.unverifiedLimit");
  });

  it("is deterministic: the same inputs produce the same decision", () => {
    const a = evaluateMandate(mandate, baseRequest, healthy);
    const b = evaluateMandate(mandate, baseRequest, healthy);
    expect(canonicalize(a as never)).toBe(canonicalize(b as never));
  });
});

describe("ATTACK: overspend", () => {
  it("blocks a single transaction above the per-transaction ceiling", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, amount: usd("5.01") }, healthy);
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("MAX_TRANSACTION_EXCEEDED");
  });

  it("blocks a spend that would breach the daily budget", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, amount: usd("5") }, {
      ...healthy,
      spentToday: usd("99"),
    });
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("DAILY_LIMIT_EXCEEDED");
  });

  it("blocks a spend one nanodollar over the daily budget", () => {
    const decision = evaluateMandate(
      mandate,
      { ...baseRequest, amount: usd("1") + 1n },
      { ...healthy, spentToday: usd("99") },
    );
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("DAILY_LIMIT_EXCEEDED");
  });

  it("allows a spend that lands exactly on the daily limit", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, amount: usd("1") }, {
      ...healthy,
      spentToday: usd("99"),
    });
    expect(decision.decision).toBe("ALLOW");
  });

  it("blocks a spend that would breach the minimum reserve", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, amount: usd("5") }, {
      ...healthy,
      availableBalance: usd("24.99"),
    });
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("MINIMUM_RESERVE_BREACHED");
  });

  it("permits breaching the reserve when the mandate explicitly allows credit", () => {
    // Dipping below the reserve floor is taking on credit. A mandate that
    // says so explicitly is allowed to; one that does not is denied exactly
    // as the case above -- this must never happen on its own.
    const creditMandate = { ...mandate, creditAllowed: true };
    const decision = evaluateMandate(creditMandate, { ...baseRequest, amount: usd("5") }, {
      ...healthy,
      availableBalance: usd("24.99"),
    });
    expect(decision.decision).toBe("ALLOW");
    expect(codes(decision)).not.toContain("MINIMUM_RESERVE_BREACHED");
  });

  it("still enforces every other limit when credit is allowed", () => {
    // Credit is not a blanket exemption: it only ever concerns the reserve
    // floor. A spend that would also blow the daily limit is still denied.
    const creditMandate = { ...mandate, creditAllowed: true, dailySpendLimitUsd: usd("3") };
    const decision = evaluateMandate(creditMandate, { ...baseRequest, amount: usd("5") }, {
      ...healthy,
      availableBalance: usd("24.99"),
    });
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("DAILY_LIMIT_EXCEEDED");
    expect(codes(decision)).not.toContain("MINIMUM_RESERVE_BREACHED");
  });

  it("blocks zero and negative amounts", () => {
    expect(evaluateMandate(mandate, { ...baseRequest, amount: 0n }, healthy).decision).toBe("DENY");
    expect(evaluateMandate(mandate, { ...baseRequest, amount: -usd("1") }, healthy).decision).toBe(
      "DENY",
    );
  });
});

describe("ATTACK: asset and network substitution", () => {
  it("blocks an asset outside the allowlist", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, asset: "XRP" }, healthy);
    expect(codes(decision)).toContain("ASSET_NOT_ALLOWED");
  });

  it("blocks a network outside the allowlist", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, network: "ARC_TESTNET" }, healthy);
    expect(codes(decision)).toContain("NETWORK_NOT_ALLOWED");
  });

  it("does not accept a lookalike asset symbol", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, asset: "USDC.e" }, healthy);
    expect(codes(decision)).toContain("ASSET_NOT_ALLOWED");
  });
});

describe("ATTACK: unverified counterparty", () => {
  it("blocks a meaningful payment to an unverified counterparty", () => {
    const decision = evaluateMandate(
      mandate,
      { ...baseRequest, amount: usd("1"), counterpartyVerified: false },
      healthy,
    );
    expect(codes(decision)).toContain("UNVERIFIED_COUNTERPARTY_LIMIT");
  });

  it("permits a trivial payment to an unverified counterparty within the probe limit", () => {
    const decision = evaluateMandate(
      mandate,
      { ...baseRequest, amount: usd("0.05"), counterpartyVerified: false },
      healthy,
    );
    expect(decision.decision).toBe("ALLOW");
  });
});

describe("ATTACK: structural permissions", () => {
  it("blocks taking on credit when credit is disabled", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, incursCredit: true }, healthy);
    expect(codes(decision)).toContain("CREDIT_NOT_ALLOWED");
  });

  it("blocks token trading when token trading is disabled", () => {
    const decision = evaluateMandate(mandate, { ...baseRequest, isTokenTrade: true }, healthy);
    expect(codes(decision)).toContain("TOKEN_TRADING_NOT_ALLOWED");
  });
});

describe("ATTACK: bypass the human", () => {
  it("requires human approval above the threshold", () => {
    const decision = evaluateMandate(
      mandate,
      { ...baseRequest, amount: usd("4.99") },
      { ...healthy, spentToday: 0n },
    );
    expect(decision.decision).toBe("ALLOW");

    const bigMandate = economicMandateSchema.parse({
      ...DEFAULT_MANDATE,
      dailySpendLimitUsd: "1000",
      maxTransactionUsd: "100",
      humanApprovalAboveUsd: "50",
      allowedAssets: ["USDC"],
      allowedNetworks: ["ARC"],
    });
    const needsHuman = evaluateMandate(
      bigMandate,
      { ...baseRequest, amount: usd("50.01") },
      { availableBalance: usd("500"), spentToday: 0n },
    );
    expect(needsHuman.decision).toBe("REQUIRE_HUMAN_APPROVAL");
    expect(codes(needsHuman)).toContain("HUMAN_APPROVAL_REQUIRED");
  });

  it("does not let an approval flag rescue a spend that violates a hard limit", () => {
    // A compromised or over-eager agent setting humanApprovalGranted must not
    // thereby clear the per-transaction ceiling.
    const decision = evaluateMandate(
      mandate,
      { ...baseRequest, amount: usd("500"), humanApprovalGranted: true },
      healthy,
    );
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("MAX_TRANSACTION_EXCEEDED");
  });
});

describe("ATTACK: fail-closed on missing context", () => {
  it("denies when the agent has no mandate at all", () => {
    const decision = evaluateMandate(null, baseRequest, healthy);
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("MANDATE_MISSING");
  });

  it("denies when the balance is unknown rather than assuming funds exist", () => {
    const decision = evaluateMandate(mandate, baseRequest, {
      ...healthy,
      availableBalance: null,
    });
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("CONTEXT_INCOMPLETE");
  });

  it("denies when today's spend is unknown rather than assuming zero", () => {
    const decision = evaluateMandate(mandate, baseRequest, { ...healthy, spentToday: null });
    expect(decision.decision).toBe("DENY");
    expect(codes(decision)).toContain("CONTEXT_INCOMPLETE");
  });
});

describe("mandate schema", () => {
  it("parses decimal strings into exact nanos", () => {
    const parsed = economicMandateSchema.parse(DEFAULT_MANDATE);
    expect(parsed.maxTransactionUsd).toBe(usd("0.025"));
  });

  it("rejects negative limits", () => {
    expect(
      economicMandateSchema.safeParse({ ...DEFAULT_MANDATE, maxTransactionUsd: "-1" }).success,
    ).toBe(false);
  });

  it("rejects an empty asset or network allowlist — a mandate must be explicit", () => {
    expect(economicMandateSchema.safeParse({ ...DEFAULT_MANDATE, allowedAssets: [] }).success).toBe(
      false,
    );
    expect(
      economicMandateSchema.safeParse({ ...DEFAULT_MANDATE, allowedNetworks: [] }).success,
    ).toBe(false);
  });

  it("rejects an unknown asset rather than passing it through", () => {
    expect(
      economicMandateSchema.safeParse({ ...DEFAULT_MANDATE, allowedAssets: ["SCAMCOIN"] }).success,
    ).toBe(false);
  });
});
