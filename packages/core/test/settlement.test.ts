/**
 * Receipts, capabilities, routing, procurement, reputation and job lifecycle.
 */

import { describe, expect, it } from "vitest";

import { unwrap } from "../src/errors/index";
import {
  ProtocolCapabilityEngine,
  type CapabilityId,
} from "../src/capability/index";
import { matchProviders, normalizeProvider, type RawProviderRecord } from "../src/discovery/index";
import { applyTransition, allowedTransitions, isTerminal } from "../src/jobs/lifecycle";
import { commitmentHash, resolveAuction } from "../src/procurement/auction";
import {
  DEFAULT_WEIGHTS,
  explainRanking,
  rankProviders,
  selectProvider,
} from "../src/procurement/index";
import {
  assertReceiptUnchanged,
  createReceipt,
  receiptHash,
  ReceiptRegistry,
  type EconomicReceipt,
} from "../src/receipts/index";
import { computeReputation, type ReputationEvent } from "../src/reputation/index";
import { usd } from "../src/units/money";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const T1 = new Date("2026-03-01T00:00:04.000Z");

// --------------------------------------------------------------------------
// Receipts
// --------------------------------------------------------------------------

const draft = {
  buyerAgentId: "agent_buyer",
  providerAgentId: "agent_provider",
  intentId: "intent_abc",
  jobId: null,
  service: "research.summarize",
  quotedPrice: usd("0.021"),
  finalPrice: usd("0.021"),
  network: "ARC",
  settlementRail: "X402",
  settlementAsset: "USDC",
  transactionReference: "0xdeadbeef",
  resultHash: "0xfeedface",
  evaluator: "evaluator.default.v1",
  evaluationResult: "PASS" as const,
  startedAt: T0,
  completedAt: T1,
};

describe("economic receipts", () => {
  it("creates a receipt with a content-derived id", () => {
    const receipt = unwrap(createReceipt(draft));
    expect(receipt.receiptId).toMatch(/^receipt_[0-9a-f]{32}$/);
    expect(receipt.reputationEffect).toBe(1);
  });

  it("hashes canonically and stably", () => {
    const a = unwrap(createReceipt(draft));
    const b = unwrap(createReceipt(draft));
    expect(receiptHash(a)).toBe(receiptHash(b));
  });

  it("ATTACK: settling above the quoted price is refused", () => {
    const result = createReceipt({ ...draft, finalPrice: usd("0.5") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("MAX_SPEND_EXCEEDED");
  });

  it("ATTACK: a passing receipt with no result hash is refused", () => {
    expect(createReceipt({ ...draft, resultHash: "" }).ok).toBe(false);
  });

  it("ATTACK: editing an issued receipt is detected", () => {
    const receipt = unwrap(createReceipt(draft));
    const edited: EconomicReceipt = { ...receipt, finalPrice: usd("0.001") };
    const check = assertReceiptUnchanged(receipt, edited);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.violations[0]?.code).toBe("RECEIPT_IMMUTABLE");
  });

  it("ATTACK: one settlement cannot produce two receipts", () => {
    const registry = new ReceiptRegistry();
    const first = unwrap(createReceipt(draft));
    const second = unwrap(createReceipt({ ...draft, service: "research.other" }));
    unwrap(registry.record(first));
    const duplicate = registry.record(second);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.violations[0]?.code).toBe("DUPLICATE_SETTLEMENT");
  });

  it("recording the same receipt twice is idempotent", () => {
    const registry = new ReceiptRegistry();
    const receipt = unwrap(createReceipt(draft));
    unwrap(registry.record(receipt));
    expect(unwrap(registry.record(receipt)).receiptId).toBe(receipt.receiptId);
    expect(registry.all()).toHaveLength(1);
  });

  it("penalises failures and disputes more than it rewards successes", () => {
    const failed = unwrap(createReceipt({ ...draft, evaluationResult: "FAIL" }));
    const disputed = unwrap(createReceipt({ ...draft, evaluationResult: "DISPUTED" }));
    expect(failed.reputationEffect).toBeLessThan(0);
    expect(disputed.reputationEffect).toBeLessThan(failed.reputationEffect);
  });
});

// --------------------------------------------------------------------------
// Capability engine
// --------------------------------------------------------------------------

describe("protocol capability engine", () => {
  it("treats UNKNOWN as unusable — never as probably fine", () => {
    const engine = new ProtocolCapabilityEngine({ production: true });
    const result = engine.assertAvailable("XRPL.MPT");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("CAPABILITY_UNKNOWN");
  });

  it("allows a capability once a live probe confirms it", () => {
    const engine = new ProtocolCapabilityEngine({ production: true });
    engine.set("XRPL.PAYMENTS", "AVAILABLE", "live", "probed via server_info");
    expect(engine.isAvailable("XRPL.PAYMENTS")).toBe(true);
    expect(engine.get("XRPL.PAYMENTS").checkedAt).toBeInstanceOf(Date);
  });

  it("ATTACK: a testnet-only capability cannot execute in production", () => {
    const production = new ProtocolCapabilityEngine({ production: true });
    production.set("ARC.ERC8183", "TESTNET_ONLY", "config");
    expect(production.assertAvailable("ARC.ERC8183").ok).toBe(false);

    const staging = new ProtocolCapabilityEngine({ production: false });
    staging.set("ARC.ERC8183", "TESTNET_ONLY", "config");
    expect(staging.assertAvailable("ARC.ERC8183").ok).toBe(true);
  });

  it("gates experimental capabilities behind an explicit opt-in", () => {
    const off = new ProtocolCapabilityEngine({ production: false });
    expect(off.assertAvailable("MULEDGER.MULTILATERAL_NETTING").ok).toBe(false);
    const on = new ProtocolCapabilityEngine({ production: false, allowExperimental: true });
    expect(on.assertAvailable("MULEDGER.MULTILATERAL_NETTING").ok).toBe(true);
  });

  it("treats an unregistered capability as unknown rather than throwing", () => {
    const engine = new ProtocolCapabilityEngine({ production: true });
    expect(engine.get("NOT.A.CAPABILITY" as CapabilityId).state).toBe("UNKNOWN");
  });

  it("ships nothing network-dependent as AVAILABLE by default", () => {
    const engine = new ProtocolCapabilityEngine({ production: true });
    const available = engine.list().filter((record) => record.state === "AVAILABLE");
    expect(available.map((record) => record.id)).toEqual(["MULEDGER.BILATERAL_NETTING"]);
  });
});

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------
//
// Routing moved to `routing.test.ts` when the router gained explicit funding
// sources, treasury inventory and rebalancing. Every property this block
// asserted is carried there — rail selection by size and delivery model,
// capability gating, rejected-route reporting, determinism and the refusal of
// non-positive amounts — plus the cross-network cases this API could not
// express, because it had no concept of where the money actually was.

// --------------------------------------------------------------------------
// Discovery + procurement
// --------------------------------------------------------------------------

const rawProviders: RawProviderRecord[] = [
  {
    agentId: "agent_cheap",
    displayName: "Cheap & Unreliable",
    source: "X402",
    verified: false,
    reputation: 41,
    destination: "0x00000000000000000000000000000000000000a1",
    settlementAssets: ["usdc"],
    networks: ["arc"],
    successRate: 0.55,
    completedJobs: 4,
    capabilities: [
      { capabilityId: "summarize", category: "summarization", price: "0.004", latencyMs: 9000, validationSupported: false },
    ],
  },
  {
    agentId: "agent_184",
    displayName: "Provider 184",
    source: "ERC8004",
    verified: true,
    reputation: 96,
    destination: "0x00000000000000000000000000000000000000b2",
    settlementAssets: ["USDC"],
    networks: ["ARC"],
    successRate: 0.98,
    completedJobs: 240,
    capabilities: [
      { capabilityId: "summarize", category: "summarization", price: "0.021", latencyMs: 3400, validationSupported: true },
    ],
  },
  {
    agentId: "agent_no_price",
    source: "MCP",
    destination: "0x00000000000000000000000000000000000000c3",
    capabilities: [{ capabilityId: "summarize", category: "summarization" }],
  },
  {
    agentId: "agent_no_destination",
    source: "A2A",
    capabilities: [{ capabilityId: "summarize", price: "0.001" }],
  },
];

describe("discovery normalization", () => {
  it("normalizes casing and clamps out-of-range values", () => {
    const provider = normalizeProvider(rawProviders[0] as RawProviderRecord);
    expect(provider?.settlementAssets).toEqual(["USDC"]);
    expect(provider?.networks).toEqual(["ARC"]);
  });

  it("drops providers that cannot actually be transacted with", () => {
    expect(normalizeProvider(rawProviders[2] as RawProviderRecord)).toBeNull();
    expect(normalizeProvider(rawProviders[3] as RawProviderRecord)).toBeNull();
  });

  it("does not invent a reputation for an agent with no history", () => {
    const provider = normalizeProvider({
      agentId: "agent_new",
      source: "MCP",
      destination: "0xabc",
      capabilities: [{ capabilityId: "x", price: "0.001" }],
    });
    expect(provider?.reputation).toBeNull();
    expect(provider?.successRate).toBeNull();
  });
});

describe("procurement", () => {
  const providers = rawProviders
    .map(normalizeProvider)
    .filter((p): p is NonNullable<typeof p> => p !== null);

  it("prices risk and latency into the comparison, not just the sticker price", () => {
    const matches = matchProviders(providers, { category: "summarization" });
    const ranked = rankProviders(matches);
    const cheap = ranked.find((r) => r.agentId === "agent_cheap") as NonNullable<
      (typeof ranked)[number]
    >;
    const reliable = ranked.find((r) => r.agentId === "agent_184") as NonNullable<
      (typeof ranked)[number]
    >;

    // On sticker price the cheap provider is 5.25x cheaper. Once its 55%
    // success rate, 9s latency and unverified counterparty are priced in, the
    // gap collapses to well under 2x — which is the entire point of ranking on
    // effective cost rather than price.
    expect((reliable.price * 100n) / cheap.price).toBe(525n);
    expect((reliable.effectiveCost * 100n) / cheap.effectiveCost).toBeLessThan(200n);
    expect(cheap.effectiveCost).toBeGreaterThan(cheap.price * 4n);
    expect(reliable.effectiveCost).toBeLessThan((reliable.price * 130n) / 100n);
  });

  it("flips to the reliable provider when latency is expensive", () => {
    // Weights are configuration, not an opinion baked into the engine. An
    // operator who values a second of agent latency at a cent gets a different
    // — and equally deterministic — winner.
    const matches = matchProviders(providers, { category: "summarization" });
    const latencySensitive = rankProviders(matches, {
      weights: { ...DEFAULT_WEIGHTS, latencyCostPerSecond: usd("0.01") },
    });
    expect(latencySensitive[0]?.agentId).toBe("agent_184");
  });

  it("explains every component of the ranking", () => {
    const matches = matchProviders(providers, { category: "summarization" });
    const best = unwrap(selectProvider(matches));
    const explanation = explainRanking(best);
    for (const part of ["price", "latency", "failure risk", "validation", "counterparty"]) {
      expect(explanation).toContain(part);
    }
    const c = best.components;
    expect(c.price + c.latencyPenalty + c.failureRisk + c.validationCost + c.counterpartyRisk).toBe(
      best.effectiveCost,
    );
  });

  it("charges an unverified counterparty a risk premium", () => {
    const matches = matchProviders(providers, { category: "summarization" });
    const ranked = rankProviders(matches);
    const cheap = ranked.find((r) => r.agentId === "agent_cheap");
    expect(cheap?.components.counterpartyRisk).toBeGreaterThan(0n);
  });

  it("respects a hard spending ceiling", () => {
    const matches = matchProviders(providers, { category: "summarization" });
    const ranked = rankProviders(matches, { maxSpend: usd("0.005") });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.agentId).toBe("agent_cheap");
  });

  it("returns a violation rather than a fallback when nothing qualifies", () => {
    const matches = matchProviders(providers, { category: "summarization", maxPrice: 1n });
    const result = selectProvider(matches);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("NO_ELIGIBLE_PROVIDER");
  });

  it("filters on verification, validation support and latency", () => {
    expect(matchProviders(providers, { requireVerified: true })).toHaveLength(1);
    expect(matchProviders(providers, { requireValidation: true })).toHaveLength(1);
    expect(matchProviders(providers, { maxLatencyMs: 4000 })).toHaveLength(1);
  });

  it("is deterministic when two providers tie", () => {
    const tied = [
      { provider: providers[0] as NonNullable<(typeof providers)[number]>, capability: (providers[0] as NonNullable<(typeof providers)[number]>).capabilities[0] as never },
      { provider: providers[0] as NonNullable<(typeof providers)[number]>, capability: (providers[0] as NonNullable<(typeof providers)[number]>).capabilities[0] as never },
    ];
    expect(rankProviders(tied)[0]?.agentId).toBe(rankProviders(tied)[1]?.agentId);
  });
});

describe("sealed-bid auctions (commit/reveal)", () => {
  const windows = {
    commitClosesAt: new Date("2026-03-01T00:01:00.000Z"),
    revealClosesAt: new Date("2026-03-01T00:02:00.000Z"),
  };

  it("resolves to the lowest valid bid", () => {
    const commitments = [
      { auctionId: "a1", bidderAgentId: "p1", commitmentHash: commitmentHash("a1", "p1", usd("0.01"), "s1"), committedAt: T0 },
      { auctionId: "a1", bidderAgentId: "p2", commitmentHash: commitmentHash("a1", "p2", usd("0.008"), "s2"), committedAt: T0 },
    ];
    const reveals = [
      { auctionId: "a1", bidderAgentId: "p1", bid: usd("0.01"), salt: "s1", revealedAt: T1 },
      { auctionId: "a1", bidderAgentId: "p2", bid: usd("0.008"), salt: "s2", revealedAt: T1 },
    ];
    const result = unwrap(resolveAuction("a1", commitments, reveals, windows, usd("0.05")));
    expect(result.winnerAgentId).toBe("p2");
    expect(result.runnerUpBid).toBe(usd("0.01"));
  });

  it("ATTACK: a bidder cannot change their bid after seeing the others", () => {
    const commitments = [
      { auctionId: "a1", bidderAgentId: "p1", commitmentHash: commitmentHash("a1", "p1", usd("0.01"), "s1"), committedAt: T0 },
      { auctionId: "a1", bidderAgentId: "p2", commitmentHash: commitmentHash("a1", "p2", usd("0.02"), "s2"), committedAt: T0 },
    ];
    const reveals = [
      { auctionId: "a1", bidderAgentId: "p1", bid: usd("0.01"), salt: "s1", revealedAt: T1 },
      // p2 tries to undercut with a bid it never committed to.
      { auctionId: "a1", bidderAgentId: "p2", bid: usd("0.009"), salt: "s2", revealedAt: T1 },
    ];
    const result = unwrap(resolveAuction("a1", commitments, reveals, windows, usd("0.05")));
    expect(result.winnerAgentId).toBe("p1");
    expect(result.discardedReveals).toContainEqual({
      bidderAgentId: "p2",
      reason: "commitment mismatch",
    });
  });

  it("ATTACK: a commitment cannot be replayed into another auction", () => {
    expect(commitmentHash("a1", "p1", usd("0.01"), "s1")).not.toBe(
      commitmentHash("a2", "p1", usd("0.01"), "s1"),
    );
  });

  it("discards late reveals and bids above the reserve", () => {
    const commitments = [
      { auctionId: "a1", bidderAgentId: "p1", commitmentHash: commitmentHash("a1", "p1", usd("1"), "s1"), committedAt: T0 },
      { auctionId: "a1", bidderAgentId: "p2", commitmentHash: commitmentHash("a1", "p2", usd("0.01"), "s2"), committedAt: T0 },
    ];
    const reveals = [
      { auctionId: "a1", bidderAgentId: "p1", bid: usd("1"), salt: "s1", revealedAt: T1 },
      { auctionId: "a1", bidderAgentId: "p2", bid: usd("0.01"), salt: "s2", revealedAt: new Date("2026-03-01T01:00:00.000Z") },
    ];
    const result = resolveAuction("a1", commitments, reveals, windows, usd("0.05"));
    expect(result.ok).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Reputation
// --------------------------------------------------------------------------

function event(
  kind: ReputationEvent["kind"],
  counterparty: string,
  value = usd("1"),
  at = T0,
): ReputationEvent {
  return {
    eventId: `evt_${Math.random()}`,
    agentId: "agent_provider",
    counterpartyAgentId: counterparty,
    kind,
    value,
    occurredAt: at,
    receiptId: null,
  };
}

describe("reputation", () => {
  const now = new Date("2026-03-02T00:00:00.000Z");

  it("returns null — not 50 — for an agent with no history", () => {
    const snapshot = computeReputation("agent_provider", [], now);
    expect(snapshot.score).toBeNull();
    expect(snapshot.successRate).toBeNull();
  });

  it("rewards a broad, successful, well-paid history", () => {
    const events = [
      event("JOB_COMPLETED", "buyer_1", usd("10")),
      event("JOB_COMPLETED", "buyer_2", usd("20")),
      event("JOB_COMPLETED", "buyer_3", usd("30")),
      event("JOB_COMPLETED", "buyer_1", usd("15")),
    ];
    const snapshot = computeReputation("agent_provider", events, now);
    expect(snapshot.score).toBeGreaterThan(70);
    expect(snapshot.distinctCounterparties).toBe(3);
    expect(snapshot.repeatCustomers).toBe(1);
  });

  it("ATTACK: a single counterparty cannot farm a top score", () => {
    const farmed = Array.from({ length: 50 }, () => event("JOB_COMPLETED", "buyer_1", usd("0.001")));
    const diverse = [
      event("JOB_COMPLETED", "buyer_1", usd("10")),
      event("JOB_COMPLETED", "buyer_2", usd("10")),
      event("JOB_COMPLETED", "buyer_3", usd("10")),
      event("JOB_COMPLETED", "buyer_4", usd("10")),
    ];
    expect(computeReputation("agent_provider", farmed, now).score).toBeLessThan(
      computeReputation("agent_provider", diverse, now).score as number,
    );
  });

  it("penalises disputes heavily and visibly", () => {
    const clean = [event("JOB_COMPLETED", "b1"), event("JOB_COMPLETED", "b2")];
    const disputed = [...clean, event("JOB_DISPUTED", "b3")];
    const snapshot = computeReputation("agent_provider", disputed, now);
    expect(snapshot.score).toBeLessThan(
      computeReputation("agent_provider", clean, now).score as number,
    );
    expect(snapshot.evidence.some((e) => e.factor === "disputes")).toBe(true);
  });

  it("weights recent behaviour above old behaviour", () => {
    const old = new Date("2024-01-01T00:00:00.000Z");
    const recentFailure = [
      event("JOB_COMPLETED", "b1", usd("1"), old),
      event("JOB_FAILED", "b2", usd("1"), now),
    ];
    const oldFailure = [
      event("JOB_COMPLETED", "b1", usd("1"), now),
      event("JOB_FAILED", "b2", usd("1"), old),
    ];
    expect(computeReputation("agent_provider", recentFailure, now).score).toBeLessThan(
      computeReputation("agent_provider", oldFailure, now).score as number,
    );
  });

  it("ignores events belonging to other agents", () => {
    const events = [{ ...event("JOB_COMPLETED", "b1"), agentId: "someone_else" }];
    expect(computeReputation("agent_provider", events, now).score).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Job lifecycle
// --------------------------------------------------------------------------

describe("ERC-8183 job lifecycle", () => {
  it("walks the specified happy path", () => {
    let state = unwrap(applyTransition("DRAFT", "QUOTE"));
    expect(state).toBe("QUOTED");
    state = unwrap(applyTransition(state, "FUND"));
    state = unwrap(applyTransition(state, "START"));
    state = unwrap(applyTransition(state, "SUBMIT"));
    state = unwrap(applyTransition(state, "EVALUATE"));
    state = unwrap(applyTransition(state, "PASS"));
    expect(state).toBe("COMPLETE");
    expect(unwrap(applyTransition(state, "SETTLE"))).toBe("SETTLED");
  });

  it("ATTACK: work cannot start before escrow is funded", () => {
    const result = applyTransition("QUOTED", "START");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("ILLEGAL_JOB_TRANSITION");
  });

  it("ATTACK: a job cannot settle before it completes", () => {
    expect(applyTransition("IN_PROGRESS", "SETTLE").ok).toBe(false);
    expect(applyTransition("SUBMITTED", "SETTLE").ok).toBe(false);
  });

  it("ATTACK: a settled job cannot be settled again", () => {
    expect(applyTransition("SETTLED", "SETTLE").ok).toBe(false);
    expect(isTerminal("SETTLED")).toBe(true);
  });

  it("ATTACK: a funded job cannot be unilaterally cancelled", () => {
    expect(applyTransition("FUNDED", "CANCEL").ok).toBe(false);
    expect(allowedTransitions("FUNDED")).toContain("DISPUTE");
  });

  it("resolves disputes in either direction", () => {
    expect(unwrap(applyTransition("DISPUTED", "RESOLVE_FOR_PROVIDER"))).toBe("COMPLETE");
    expect(unwrap(applyTransition("DISPUTED", "RESOLVE_FOR_BUYER"))).toBe("REJECTED");
  });

  it("names the legal transitions when it refuses one", () => {
    const result = applyTransition("DRAFT", "SETTLE");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.detail?.allowed).toContain("QUOTE");
  });
});
