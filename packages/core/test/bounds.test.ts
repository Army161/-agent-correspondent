/**
 * Fail-closed execution bounds, written as attacks.
 *
 * Each test is a way an executor, a relay, a compromised rail adapter or a
 * prompt-injected model might try to move money differently from what was
 * signed. All of them must fail.
 */

import { describe, expect, it } from "vitest";

import { enforceBounds, type ExecutionPlan } from "../src/bounds/index";
import { compileIntent, type CompileIntentRequest } from "../src/intent/compile";
import { unwrap } from "../src/errors/index";
import { usd } from "../src/units/money";

const NOW = new Date("2026-03-01T12:00:00.000Z");

const request: CompileIntentRequest = {
  buyerAgentId: "agent_buyer",
  providerAgentId: "agent_provider",
  service: "research.summarize",
  servicePayload: { q: "summarize" },
  maxSpend: "0.025",
  minReceive: "0.020",
  settlementAsset: "USDC",
  allowedRails: ["X402"],
  network: "ARC",
  destination: "0x00000000000000000000000000000000000000c1",
  evaluator: "evaluator.default.v1",
  chainId: 5042,
  verifyingContract: "0x000000000000000000000000000000000000dEaD",
  maxFxSlippageBps: 25,
  maxNetworkFee: "0.002",
  ttlSeconds: 300,
};

const intent = unwrap(compileIntent(request, NOW));

const honestPlan: ExecutionPlan = {
  totalSpend: usd("0.023"),
  providerReceives: usd("0.021"),
  railFee: usd("0.001"),
  networkFee: usd("0.001"),
  asset: "USDC",
  network: "ARC",
  destination: "0x00000000000000000000000000000000000000c1",
  rail: "X402",
  quotedReceive: usd("0.021"),
  quotedAt: NOW,
};

function codes(plan: ExecutionPlan, at: Date = NOW): string[] {
  return enforceBounds(intent, plan, at).violations.map((v) => v.code);
}

describe("bounds — the authorized path executes", () => {
  it("authorizes a plan that respects every bound", () => {
    const result = enforceBounds(intent, honestPlan, NOW);
    expect(result.authorized).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("authorizes a plan that lands exactly on every ceiling", () => {
    const exact: ExecutionPlan = {
      ...honestPlan,
      totalSpend: usd("0.025"),
      providerReceives: usd("0.02"),
      railFee: usd("0.003"),
      networkFee: usd("0.002"),
      quotedReceive: usd("0.02"),
    };
    expect(enforceBounds(intent, exact, NOW).authorized).toBe(true);
  });
});

describe("ATTACK: amount mutation", () => {
  it("blocks spending one nanodollar more than authorized", () => {
    expect(
      codes({
        ...honestPlan,
        totalSpend: usd("0.025") + 1n,
        providerReceives: usd("0.021") + 1n,
        quotedReceive: usd("0.021") + 1n,
      }),
    ).toContain("MAX_SPEND_EXCEEDED");
  });

  it("blocks the $1-authorized / $10-executed mutation outright", () => {
    expect(
      codes({ ...honestPlan, totalSpend: usd("10"), providerReceives: usd("9.998") }),
    ).toContain("MAX_SPEND_EXCEEDED");
  });

  it("blocks shorting the provider below minReceive", () => {
    expect(
      codes({
        ...honestPlan,
        providerReceives: usd("0.019"),
        railFee: usd("0.003"),
        totalSpend: usd("0.023"),
        quotedReceive: usd("0.019"),
      }),
    ).toContain("MIN_RECEIVE_NOT_MET");
  });

  it("blocks a plan whose components do not reconcile to its total", () => {
    // Skimming: the buyer is charged the authorized total, but the parts do not
    // add up, so someone is taking a cut that is not declared.
    expect(codes({ ...honestPlan, railFee: usd("0.005") })).toContain("MAX_FEE_EXCEEDED");
  });
});

describe("ATTACK: fee inflation", () => {
  it("blocks a network fee above the authorized ceiling", () => {
    expect(
      codes({
        ...honestPlan,
        networkFee: usd("0.003"),
        railFee: 0n,
        totalSpend: usd("0.024"),
        providerReceives: usd("0.021"),
      }),
    ).toContain("MAX_NETWORK_FEE_EXCEEDED");
  });
});

describe("ATTACK: substitution", () => {
  it("blocks paying in a different asset", () => {
    expect(codes({ ...honestPlan, asset: "RLUSD" })).toContain("ASSET_SUBSTITUTION");
  });

  it("blocks settling on a different network", () => {
    expect(codes({ ...honestPlan, network: "ARC_TESTNET" })).toContain("NETWORK_SUBSTITUTION");
  });

  it("blocks redirecting the payout to another destination", () => {
    expect(
      codes({ ...honestPlan, destination: "0x00000000000000000000000000000000000000ff" }),
    ).toContain("DESTINATION_SUBSTITUTION");
  });

  it("tolerates only address checksum casing, nothing else", () => {
    const checksummed = {
      ...honestPlan,
      destination: "0x00000000000000000000000000000000000000C1",
    };
    expect(enforceBounds(intent, checksummed, NOW).authorized).toBe(true);
  });

  it("blocks executing on a rail the intent did not authorize", () => {
    expect(codes({ ...honestPlan, rail: "XRPL_PAYMENT" })).toContain("NO_ELIGIBLE_ROUTE");
  });
});

describe("ATTACK: timing", () => {
  it("blocks execution after the authorization expires", () => {
    const late = new Date(NOW.getTime() + 301_000);
    expect(codes(honestPlan, late)).toContain("AUTHORIZATION_EXPIRED");
  });

  it("blocks execution after the work deadline", () => {
    const late = new Date(NOW.getTime() + 299_000);
    const codesOut = codes({ ...honestPlan, quotedAt: late }, late);
    expect(codesOut).not.toContain("AUTHORIZATION_EXPIRED");
    // Deadline equals expiry for this fixture, so at 299s the work deadline is
    // still live; push past it to confirm the separate check fires.
    const past = new Date(NOW.getTime() + 400_000);
    expect(codes({ ...honestPlan, quotedAt: past }, past)).toContain("INTENT_EXPIRED");
  });

  it("blocks execution against a stale quote", () => {
    const later = new Date(NOW.getTime() + 120_000);
    expect(
      enforceBounds(intent, { ...honestPlan, quotedAt: NOW }, later).violations.map((v) => v.code),
    ).toContain("QUOTE_STALE");
  });
});

describe("ATTACK: FX slippage", () => {
  it("blocks a received amount that drifted beyond the authorized slippage", () => {
    // Quoted $0.021, delivering $0.0205 is ~238 bps of drift against a 25 bps
    // authorization.
    expect(
      codes({
        ...honestPlan,
        providerReceives: usd("0.0205"),
        railFee: usd("0.0015"),
        quotedReceive: usd("0.021"),
      }),
    ).toContain("FX_SLIPPAGE_EXCEEDED");
  });

  it("permits drift inside the authorized slippage", () => {
    // 20 bps of drift against a 25 bps authorization.
    const plan: ExecutionPlan = {
      ...honestPlan,
      providerReceives: usd("0.0209580"),
      railFee: usd("0.001042"),
      networkFee: usd("0.001"),
      totalSpend: usd("0.023"),
      quotedReceive: usd("0.021"),
    };
    const result = enforceBounds(intent, plan, NOW);
    expect(result.violations.map((v) => v.code)).not.toContain("FX_SLIPPAGE_EXCEEDED");
  });
});

describe("bounds reporting", () => {
  it("reports every violation at once rather than the first", () => {
    const hostile: ExecutionPlan = {
      ...honestPlan,
      totalSpend: usd("10"),
      providerReceives: usd("0.001"),
      asset: "XRP",
      network: "XRPL",
      destination: "0x0000000000000000000000000000000000000bad",
      rail: "XRPL_PAYMENT",
    };
    const result = enforceBounds(intent, hostile, NOW);
    expect(result.authorized).toBe(false);
    expect(new Set(result.violations.map((v) => v.code))).toEqual(
      new Set([
        "MAX_SPEND_EXCEEDED",
        "MIN_RECEIVE_NOT_MET",
        "ASSET_SUBSTITUTION",
        "NETWORK_SUBSTITUTION",
        "DESTINATION_SUBSTITUTION",
        "NO_ELIGIBLE_ROUTE",
        "MAX_FEE_EXCEEDED",
        "FX_SLIPPAGE_EXCEEDED",
      ]),
    );
  });
});
