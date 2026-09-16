/**
 * Cross-network routing.
 *
 * The bug these tests exist to prevent: the router used to treat "the provider
 * is on XRPL" as licence to select XRPL pathfinding, regardless of where the
 * buyer's money actually was. XRPL pathfinding can convert and route assets
 * that are **already on XRPL**. It cannot debit an Arc wallet. Nothing in this
 * system may present a cross-network movement as a single atomic payment unless
 * a mechanism that genuinely provides that is configured and live.
 *
 * So routing now takes three separate facts — where the money is, where it must
 * end up, and what is actually held on each rail — and a rebalance is a
 * separate, explicitly non-atomic operation.
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
import { ProtocolCapabilityEngine, type CapabilityId } from "../src/capability/index";
import { unwrap } from "../src/errors/index";
import {
  DEFAULT_ROUTER_CONFIG,
  routePayment,
  type RoutingRequest,
  type TreasuryHolding,
} from "../src/router/index";

function engineWith(...ids: CapabilityId[]): ProtocolCapabilityEngine {
  const engine = new ProtocolCapabilityEngine({ production: false });
  for (const id of ids) engine.set(id, "AVAILABLE", "test");
  return engine;
}

function holding(value: string, assetId: string): TreasuryHolding {
  const amount = unwrap(parseAmount(value, assetId));
  return { network: amount.network, amount, custody: "PLATFORM" };
}

function request(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    buyerAgentId: "agent_buyer",
    providerAgentId: "agent_provider",
    payout: {
      amount: unwrap(parseAmount("0.004", ARC_USDC)),
      destination: "0x00000000000000000000000000000000000000c1",
    },
    inventory: [holding("100", ARC_USDC)],
    asynchronous: false,
    requiresEvaluation: false,
    recurringCounterparty: false,
    counterpartyVerified: true,
    ...overrides,
  };
}

describe("same-network routing", () => {
  it("routes a sub-cent Arc payout to a nanopayment rail, funded from Arc", () => {
    const result = routePayment(request(), engineWith("ARC.X402"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.plan.rail).toBe("X402");
    expect(result.decision.plan.source.network).toBe("ARC");
    expect(result.decision.plan.source.amount.assetId).toBe(ARC_USDC);
    expect(result.decision.plan.rebalanceRequired).toBe(false);
  });

  it("routes an XRPL payout from XRPL inventory", () => {
    const result = routePayment(
      request({
        payout: {
          amount: unwrap(parseAmount("2", XRPL_XRP)),
          destination: "rProviderAccount",
        },
        inventory: [holding("500", XRPL_XRP)],
      }),
      engineWith("XRPL.PAYMENTS"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.plan.rail).toBe("XRPL_PAYMENT");
    expect(result.decision.plan.source.network).toBe("XRPL");
  });

  it("uses XRPL pathfinding only to convert between assets already on XRPL", () => {
    const result = routePayment(
      request({
        payout: {
          amount: unwrap(parseAmount("2", XRPL_RLUSD)),
          destination: "rProviderAccount",
        },
        // Funded in XRP on XRPL, paying out RLUSD on XRPL: a conversion the
        // ledger can genuinely perform inside one transaction.
        inventory: [holding("500", XRPL_XRP)],
      }),
      engineWith("XRPL.PATHFINDING"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.plan.rail).toBe("XRPL_PATHFINDING");
    expect(result.decision.plan.source.amount.assetId).toBe(XRPL_XRP);
    expect(result.decision.plan.fxRoute).toMatchObject({ from: "XRP", to: "RLUSD" });
  });
});

describe("ATTACK: presenting a cross-network movement as an atomic payment", () => {
  const arcFundedXrplPayout = request({
    payout: {
      amount: unwrap(parseAmount("2", XRPL_RLUSD)),
      destination: "rProviderAccount",
    },
    inventory: [holding("100", ARC_USDC)],
  });

  it("refuses to route an XRPL payout from Arc inventory, however many rails are live", () => {
    const result = routePayment(
      arcFundedXrplPayout,
      engineWith(
        "XRPL.PAYMENTS",
        "XRPL.PATHFINDING",
        "ARC.X402",
        "ARC.CIRCLE_NANOPAYMENT",
        "ARC.ERC8183",
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("INSUFFICIENT_INVENTORY");
  });

  it("proposes a rebalance instead, marked as not atomic with the payment", () => {
    const result = routePayment(arcFundedXrplPayout, engineWith("XRPL.PAYMENTS"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rebalances.length).toBeGreaterThan(0);
    for (const rebalance of result.rebalances) {
      expect(rebalance.atomicWithPayment).toBe(false);
      expect(rebalance.to.network).toBe("XRPL");
      expect(rebalance.from.network).toBe("ARC");
    }
  });

  it("does not offer Circle Gateway for a network Gateway is not known to support", () => {
    // The default configuration lists no Gateway-supported networks, because
    // support has not been read from Circle at runtime. USDC existing on a
    // chain is not evidence that Gateway covers it.
    const result = routePayment(
      arcFundedXrplPayout,
      engineWith("XRPL.PAYMENTS", "CIRCLE.GATEWAY"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rebalances.some((r) => r.mechanism === "CIRCLE_GATEWAY")).toBe(false);
  });

  it("offers Circle Gateway only when the runtime says it covers both networks", () => {
    const result = routePayment(
      request({
        payout: {
          amount: unwrap(parseAmount("2", canonicalAssetId("ARC_TESTNET", "USDC"))),
          destination: "0x00000000000000000000000000000000000000c1",
        },
        inventory: [holding("100", ARC_USDC)],
      }),
      engineWith("ARC.X402", "CIRCLE.GATEWAY"),
      {
        ...DEFAULT_ROUTER_CONFIG,
        gatewaySupportedNetworks: ["ARC", "ARC_TESTNET"],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rebalances.some((r) => r.mechanism === "CIRCLE_GATEWAY")).toBe(true);
  });
});

describe("treasury inventory gates every route", () => {
  it("refuses a payout larger than the inventory held on the paying rail", () => {
    const result = routePayment(
      request({
        payout: {
          amount: unwrap(parseAmount("50", ARC_USDC)),
          destination: "0x00000000000000000000000000000000000000c1",
        },
        inventory: [holding("1", ARC_USDC)],
      }),
      engineWith("ARC.X402", "ARC.ERC8183"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("INSUFFICIENT_INVENTORY");
    expect(result.violations[0]?.message).toContain("1 USDC");
  });

  it("reports the shortfall in the asset that is short", () => {
    const result = routePayment(
      request({
        payout: {
          amount: unwrap(parseAmount("50", ARC_USDC)),
          destination: "0x00000000000000000000000000000000000000c1",
        },
        inventory: [holding("20", ARC_USDC)],
      }),
      engineWith("ARC.X402", "ARC.ERC8183"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfall?.symbol).toBe("USDC");
    expect(result.shortfall?.atomic).toBe(30_000_000n);
  });

  it("ignores inventory held on a different network", () => {
    const result = routePayment(
      request({
        payout: {
          amount: unwrap(parseAmount("2", ARC_USDC)),
          destination: "0x00000000000000000000000000000000000000c1",
        },
        // Plenty of USDC, but on the testnet — a different asset on a
        // different network.
        inventory: [holding("100", canonicalAssetId("ARC_TESTNET", "USDC"))],
      }),
      engineWith("ARC.X402", "ARC.ERC8183"),
    );
    expect(result.ok).toBe(false);
  });

  it("counts only unreserved inventory", () => {
    const available = unwrap(parseAmount("10", ARC_USDC));
    const reserved = unwrap(parseAmount("9.5", ARC_USDC));
    const result = routePayment(
      request({
        payout: {
          amount: unwrap(parseAmount("1", ARC_USDC)),
          destination: "0x00000000000000000000000000000000000000c1",
        },
        inventory: [{ network: "ARC", amount: available, reserved, custody: "PLATFORM" }],
      }),
      engineWith("ARC.X402", "ARC.ERC8183"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("INSUFFICIENT_INVENTORY");
  });
});

describe("the μLedger needs no inventory, because nothing moves", () => {
  it("records a tiny recurring obligation without touching a rail", () => {
    const result = routePayment(
      request({
        payout: {
          amount: amountFromAtomic(400_000n, canonicalAssetId("MULEDGER", "USDC")),
          destination: "agent_provider",
        },
        inventory: [],
        recurringCounterparty: true,
      }),
      engineWith("MULEDGER.BILATERAL_NETTING"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.plan.rail).toBe("MULEDGER");
    expect(result.decision.plan.timing).toBe("NEXT_CLEARING_CYCLE");
    expect(result.decision.plan.source.network).toBe("MULEDGER");
  });
});

describe("capability gating still applies", () => {
  it("refuses every route whose primitive is not verified live", () => {
    const result = routePayment(request(), new ProtocolCapabilityEngine({ production: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("NO_ELIGIBLE_ROUTE");
  });

  it("reports the routes it rejected and why", () => {
    const result = routePayment(request(), engineWith("ARC.X402"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.rejected.map((r) => r.rail)).toContain("CIRCLE_NANOPAYMENT");
  });

  it("is deterministic across repeated calls", () => {
    const engine = engineWith("ARC.X402", "ARC.CIRCLE_NANOPAYMENT");
    const a = routePayment(request(), engine);
    const b = routePayment(request(), engine);
    expect(a.ok && b.ok && a.decision.plan.rail).toBe(b.ok ? b.decision.plan.rail : null);
  });

  it("refuses a non-positive payout", () => {
    const result = routePayment(
      request({
        payout: {
          amount: amountFromAtomic(0n, ARC_USDC),
          destination: "0x00000000000000000000000000000000000000c1",
        },
      }),
      engineWith("ARC.X402"),
    );
    expect(result.ok).toBe(false);
  });
});

describe("escrow and evaluation", () => {
  it("routes evaluated asynchronous work on Arc to ERC-8183 escrow", () => {
    const result = routePayment(
      request({
        payout: {
          amount: unwrap(parseAmount("5", ARC_USDC)),
          destination: "0x00000000000000000000000000000000000000c1",
        },
        inventory: [holding("100", ARC_USDC)],
        asynchronous: true,
        requiresEvaluation: true,
      }),
      engineWith("ARC.ERC8183"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.plan.rail).toBe("ERC8183_ESCROW");
    expect(result.decision.plan.validation).toBe("EVALUATOR_BEFORE_PAYMENT");
  });
});
