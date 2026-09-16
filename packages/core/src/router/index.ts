/**
 * The economic router.
 *
 * Given what needs to happen economically, decide *how*: which funding source
 * is debited, on which network, through which mechanism, into which payout.
 *
 * The rule that shapes this module: **a payment can only be made from money
 * that is already on the rail making it.** XRPL pathfinding converts and routes
 * assets already on XRPL; it cannot debit an Arc wallet. An Arc contract cannot
 * reach an XRPL account. Presenting a movement across two independent ledgers as
 * one atomic payment is not a routing decision, it is a false statement about
 * settlement risk — so it is refused, and a **rebalance** is proposed instead as
 * a separate, explicitly non-atomic operation.
 *
 * Three facts go in, and they are kept apart:
 *
 *   payout     — what the provider must receive, in which asset, on which network
 *   inventory  — what is actually held, per network and per asset, right now
 *   capability — which primitives have been verified live on those networks
 *
 * Routing logic lives here, never in a React component and never in a prompt.
 * The function is pure, so a routing decision can be replayed during an incident.
 */

import {
  addAmounts,
  formatAmount,
  subtractAmounts,
  zeroAmount,
  type AssetAmount,
} from "../assets/amount";
import { assetDefinition, canonicalAssetId, type AssetId } from "../assets/registry";
import { violation, type EconomicViolation } from "../errors/index";
import type { SettlementRail } from "../intent/schema";
import type { NetworkId } from "../mandate/schema";
import type { CapabilityId, ProtocolCapabilityEngine } from "../capability/index";

export type ContractMechanism =
  | "DIRECT_TRANSFER"
  | "HTTP_402"
  | "ERC8183_JOB"
  | "XRPL_ESCROW"
  | "LEDGER_OBLIGATION";

export type ValidationStrategy = "NONE" | "EVALUATOR_BEFORE_PAYMENT" | "EVALUATOR_AFTER_PAYMENT";

export type SettlementTiming = "IMMEDIATE" | "ON_DELIVERY" | "NEXT_CLEARING_CYCLE";

/**
 * What the treasury actually holds on one rail.
 *
 * `reserved` is inventory already committed to in-flight payments or escrow.
 * Only the unreserved remainder can fund a new payment; ignoring it is how a
 * treasury double-spends the same balance across two concurrent routes.
 */
export interface TreasuryHolding {
  readonly network: NetworkId;
  readonly amount: AssetAmount;
  readonly reserved?: AssetAmount;
  readonly custody: "PLATFORM" | "AGENT" | "EXTERNAL";
}

/** What the provider must end up with. */
export interface PayoutTarget {
  readonly amount: AssetAmount;
  readonly destination: string;
}

export interface RoutingRequest {
  readonly buyerAgentId: string;
  readonly providerAgentId: string;
  readonly payout: PayoutTarget;
  /** Everything the buyer can actually draw on, per rail. */
  readonly inventory: readonly TreasuryHolding[];
  /** True when the work is long-running and the result arrives later. */
  readonly asynchronous: boolean;
  /** True when payment should depend on an evaluator verdict. */
  readonly requiresEvaluation: boolean;
  /** True when buyer and provider already have an open bilateral relationship. */
  readonly recurringCounterparty: boolean;
  readonly counterpartyVerified: boolean;
}

export interface RouterConfig {
  /** At or below this, an on-chain transaction costs more than the payment is worth. */
  readonly nanopaymentCeilingUsd: bigint;
  /** At or above this, escrow and evaluation are worth their overhead. */
  readonly escrowFloorUsd: bigint;
  /** Obligations at or below this accumulate on the μLedger instead of settling. */
  readonly ledgerAccrualCeilingUsd: bigint;
  /** Preferred rail order when several are eligible. */
  readonly railPreference: readonly SettlementRail[];
  /**
   * Networks Circle Gateway is known — at runtime, from Circle — to support.
   *
   * Empty by default, and empty means "not established". USDC existing on a
   * chain is not evidence that Gateway covers it, so an empty list means
   * Gateway is never proposed.
   */
  readonly gatewaySupportedNetworks: readonly NetworkId[];
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  nanopaymentCeilingUsd: 10_000_000n, // $0.01
  escrowFloorUsd: 1_000_000_000n, // $1.00
  ledgerAccrualCeilingUsd: 1_000_000n, // $0.001
  railPreference: [
    "MULEDGER",
    "X402",
    "CIRCLE_NANOPAYMENT",
    "ERC8183_ESCROW",
    "XRPL_PAYMENT",
    "XRPL_PATHFINDING",
    "XRPL_ESCROW",
  ],
  gatewaySupportedNetworks: [],
};

/** The funding leg: which holding is debited, and how much of it. */
export interface FundingSource {
  readonly network: NetworkId;
  readonly amount: AssetAmount;
  readonly custody: TreasuryHolding["custody"];
}

export interface RoutePlan {
  readonly counterpartyAgentId: string;
  /** Where the money comes from. Always on the same network as the payment. */
  readonly source: FundingSource;
  /** What the provider receives. */
  readonly payout: PayoutTarget;
  readonly mechanism: ContractMechanism;
  readonly network: NetworkId;
  readonly rail: SettlementRail;
  /** Present only when the source and payout assets differ *on the same ledger*. */
  readonly fxRoute: { readonly from: string; readonly to: string; readonly via: string } | null;
  readonly validation: ValidationStrategy;
  readonly timing: SettlementTiming;
  readonly requiredCapability: CapabilityId;
  /**
   * Always false. A plan that needed a rebalance is not a plan — the rebalance
   * is a separate operation that must complete first. The field exists so the
   * property is stated rather than implied.
   */
  readonly rebalanceRequired: false;
  readonly rationale: string;
}

export type RebalanceMechanism =
  | "CIRCLE_GATEWAY"
  | "MANUAL_TREASURY_TRANSFER"
  | "EXTERNAL_BRIDGE";

/**
 * Moving inventory from one rail to another so a future payment can be made.
 *
 * Never part of a payment. Two independent ledgers have no shared commit, so a
 * rebalance is its own operation with its own confirmation, its own failure
 * modes and its own audit record — and the payment it unlocks cannot be
 * attempted until it has settled.
 */
export interface RebalanceProposal {
  readonly from: { readonly network: NetworkId; readonly assetId: AssetId };
  readonly to: { readonly network: NetworkId; readonly assetId: AssetId };
  readonly amount: AssetAmount;
  readonly mechanism: RebalanceMechanism;
  /** The capability that must be live to execute this, when one applies. */
  readonly requiredCapability: CapabilityId | null;
  /** Always false. Stated explicitly because the opposite claim is the hazard. */
  readonly atomicWithPayment: false;
  readonly rationale: string;
}

export interface RejectedRoute {
  readonly rail: SettlementRail;
  readonly reason: string;
}

export interface RouteDecision {
  readonly plan: RoutePlan;
  readonly rejected: readonly RejectedRoute[];
}

export type RoutingResult =
  | { readonly ok: true; readonly decision: RouteDecision }
  | {
      readonly ok: false;
      readonly violations: readonly EconomicViolation[];
      /** How the treasury could be made able to pay. Never executed automatically. */
      readonly rebalances: readonly RebalanceProposal[];
      /** How much is missing, in the asset that is short. */
      readonly shortfall: AssetAmount | null;
      readonly rejected: readonly RejectedRoute[];
    };

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** Unreserved inventory of one asset on one network. */
export function availableInventory(
  inventory: readonly TreasuryHolding[],
  assetId: AssetId,
): AssetAmount {
  let total = zeroAmount(assetId);
  for (const holding of inventory) {
    if (holding.amount.assetId !== assetId) continue;
    const net = holding.reserved
      ? subtractAmounts(holding.amount, holding.reserved)
      : { ok: true as const, value: holding.amount };
    if (!net.ok) continue;
    const sum = addAmounts(total, net.value);
    if (!sum.ok) continue;
    total = sum.value;
  }
  return total;
}

function custodyFor(
  inventory: readonly TreasuryHolding[],
  assetId: AssetId,
): TreasuryHolding["custody"] {
  return inventory.find((holding) => holding.amount.assetId === assetId)?.custody ?? "PLATFORM";
}

/** Assets held on a given network, in a deterministic order. */
function assetsOnNetwork(
  inventory: readonly TreasuryHolding[],
  network: NetworkId,
): readonly AssetId[] {
  return [
    ...new Set(
      inventory
        .filter((holding) => holding.amount.network === network && holding.amount.atomic > 0n)
        .map((holding) => holding.amount.assetId),
    ),
  ].sort();
}

// ---------------------------------------------------------------------------
// Candidate routes
// ---------------------------------------------------------------------------

interface Candidate {
  readonly rail: SettlementRail;
  readonly mechanism: ContractMechanism;
  readonly network: NetworkId;
  readonly capability: CapabilityId;
  readonly timing: SettlementTiming;
  /** The asset that must be debited to fund this route. */
  readonly sourceAssetId: AssetId;
  /** Present when the route converts between two assets on the same ledger. */
  readonly fx: boolean;
  readonly rationale: string;
}

const ARC_NETWORKS: readonly NetworkId[] = ["ARC", "ARC_TESTNET"];
const XRPL_NETWORKS: readonly NetworkId[] = ["XRPL", "XRPL_TESTNET"];

/**
 * Enumerate routes that are structurally valid, before checking inventory or
 * whether the underlying primitives are live.
 *
 * Every candidate names the asset it must be funded from, and that asset is
 * always on the same network as the payment. There is deliberately no candidate
 * whose funding network differs from its payout network.
 */
function candidates(request: RoutingRequest, config: RouterConfig): Candidate[] {
  const out: Candidate[] = [];
  const payoutAsset = request.payout.amount.assetId;
  const network = request.payout.amount.network;
  const usdScale = usdMagnitude(request.payout.amount);

  // Tiny, repeated obligations between the same two agents: nothing moves, so
  // no inventory is needed. Accrue and clear later.
  if (
    network === "MULEDGER" &&
    request.recurringCounterparty &&
    !request.asynchronous &&
    (usdScale === null || usdScale <= config.ledgerAccrualCeilingUsd)
  ) {
    out.push({
      rail: "MULEDGER",
      mechanism: "LEDGER_OBLIGATION",
      network: "MULEDGER",
      capability: "MULEDGER.BILATERAL_NETTING",
      timing: "NEXT_CLEARING_CYCLE",
      sourceAssetId: payoutAsset,
      fx: false,
      rationale: `${formatAmount(request.payout.amount)} to a recurring counterparty is below the accrual ceiling; recorded as an obligation and netted on the next clearing cycle`,
    });
  }

  if (ARC_NETWORKS.includes(network)) {
    const small = usdScale !== null && usdScale <= config.nanopaymentCeilingUsd;
    const large = usdScale === null || usdScale >= config.escrowFloorUsd;

    if (small && !request.asynchronous) {
      out.push({
        rail: "X402",
        mechanism: "HTTP_402",
        network,
        capability: "ARC.X402",
        timing: "IMMEDIATE",
        sourceAssetId: payoutAsset,
        fx: false,
        rationale: `${formatAmount(request.payout.amount)} is a synchronous sub-cent call; settled inline over x402`,
      });
      out.push({
        rail: "CIRCLE_NANOPAYMENT",
        mechanism: "DIRECT_TRANSFER",
        network,
        capability: "ARC.CIRCLE_NANOPAYMENT",
        timing: "IMMEDIATE",
        sourceAssetId: payoutAsset,
        fx: false,
        rationale: `${formatAmount(request.payout.amount)} settled as a Circle nanopayment`,
      });
    }

    if (large || request.asynchronous || request.requiresEvaluation) {
      out.push({
        rail: "ERC8183_ESCROW",
        mechanism: "ERC8183_JOB",
        network,
        capability: "ARC.ERC8183",
        timing: "ON_DELIVERY",
        sourceAssetId: payoutAsset,
        fx: false,
        rationale: request.requiresEvaluation
          ? "payment is conditional on an evaluator verdict, so funds are escrowed in an ERC-8183 job"
          : `${formatAmount(request.payout.amount)} of asynchronous work is escrowed until delivery`,
      });
    }
  }

  if (XRPL_NETWORKS.includes(network)) {
    // Same asset, same ledger: a plain payment.
    if (request.requiresEvaluation || request.asynchronous) {
      out.push({
        rail: "XRPL_ESCROW",
        mechanism: "XRPL_ESCROW",
        network,
        capability: "XRPL.ESCROW",
        timing: "ON_DELIVERY",
        sourceAssetId: payoutAsset,
        fx: false,
        rationale: "asynchronous XRPL settlement is held in escrow until delivery",
      });
    } else {
      out.push({
        rail: "XRPL_PAYMENT",
        mechanism: "DIRECT_TRANSFER",
        network,
        capability: "XRPL.PAYMENTS",
        timing: "IMMEDIATE",
        sourceAssetId: payoutAsset,
        fx: false,
        rationale: "direct XRPL payment to the provider's account",
      });
    }

    // Different asset, *same ledger*: pathfinding can convert atomically,
    // because both sides of the conversion live on XRPL. Every other asset
    // held on this XRPL network is a candidate source.
    for (const sourceAssetId of assetsOnNetwork(request.inventory, network)) {
      if (sourceAssetId === payoutAsset) continue;
      out.push({
        rail: "XRPL_PATHFINDING",
        mechanism: "DIRECT_TRANSFER",
        network,
        capability: "XRPL.PATHFINDING",
        timing: "IMMEDIATE",
        sourceAssetId,
        fx: true,
        rationale: `converting ${assetDefinition(sourceAssetId)?.symbol ?? sourceAssetId} into ${request.payout.amount.symbol} within XRPL, which pathfinding performs in one transaction`,
      });
    }
  }

  return out;
}

/**
 * Approximate USD magnitude, used only to pick a size band.
 *
 * Returns null for an asset with no registered peg: without a price we do not
 * know whether this is a sub-cent call or a large payment, so the size-banded
 * rails (nanopayment, μLedger accrual) are not offered and only the
 * size-agnostic ones remain. The mandate engine is what actually refuses an
 * unvaluable spend; this is only route shaping.
 */
function usdMagnitude(amount: AssetAmount): bigint | null {
  const definition = assetDefinition(amount.assetId);
  if (definition?.peg.kind !== "USD_PAR") return null;
  const scale = 10n ** BigInt(amount.decimals);
  return (amount.atomic * 1_000_000_000n) / scale;
}

// ---------------------------------------------------------------------------
// Rebalancing
// ---------------------------------------------------------------------------

/**
 * Propose how the treasury could be made able to pay.
 *
 * Every proposal is explicitly not atomic with the payment. Circle Gateway is
 * offered only when the capability is live **and** the runtime configuration
 * lists both networks as supported — a list that is empty until it has been
 * read from Circle, because assuming coverage is how a payment gets routed into
 * a bridge that does not exist.
 */
export function proposeRebalances(
  request: RoutingRequest,
  capabilities: ProtocolCapabilityEngine,
  config: RouterConfig,
  shortfall: AssetAmount,
): RebalanceProposal[] {
  const target = request.payout.amount;
  const proposals: RebalanceProposal[] = [];

  // Inventory that exists somewhere else, in descending usefulness order.
  const elsewhere = [
    ...new Set(
      request.inventory
        .filter((holding) => holding.amount.assetId !== target.assetId && holding.amount.atomic > 0n)
        .map((holding) => holding.amount.assetId),
    ),
  ].sort();

  for (const sourceAssetId of elsewhere) {
    const source = assetDefinition(sourceAssetId);
    if (!source) continue;

    const gatewayCovers =
      config.gatewaySupportedNetworks.includes(source.network) &&
      config.gatewaySupportedNetworks.includes(target.network) &&
      capabilities.isAvailable("CIRCLE.GATEWAY");

    const mechanism: RebalanceMechanism = gatewayCovers
      ? "CIRCLE_GATEWAY"
      : source.network === target.network
        ? "MANUAL_TREASURY_TRANSFER"
        : "EXTERNAL_BRIDGE";

    proposals.push({
      from: { network: source.network, assetId: source.id },
      to: { network: target.network, assetId: target.assetId },
      amount: shortfall,
      mechanism,
      requiredCapability: mechanism === "CIRCLE_GATEWAY" ? "CIRCLE.GATEWAY" : null,
      atomicWithPayment: false,
      rationale:
        mechanism === "CIRCLE_GATEWAY"
          ? `Circle Gateway is configured as covering both ${source.network} and ${target.network}; moving ${formatAmount(shortfall)} would make this payment routable`
          : mechanism === "MANUAL_TREASURY_TRANSFER"
            ? `${source.symbol} and ${target.symbol} are both on ${target.network}; a treasury conversion of ${formatAmount(shortfall)} would make this payment routable`
            : `${source.network} and ${target.network} are independent ledgers with no configured bridge; moving ${formatAmount(shortfall)} is a separate operation that must settle before this payment can be attempted`,
    });
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export function routePayment(
  request: RoutingRequest,
  capabilities: ProtocolCapabilityEngine,
  config: RouterConfig = DEFAULT_ROUTER_CONFIG,
): RoutingResult {
  const payout = request.payout.amount;

  if (payout.atomic <= 0n) {
    return {
      ok: false,
      violations: [violation("INVALID_AMOUNT", "routing requires a positive payout amount")],
      rebalances: [],
      shortfall: null,
      rejected: [],
    };
  }

  const structural = candidates(request, config);
  if (structural.length === 0) {
    return {
      ok: false,
      violations: [
        violation(
          "NO_ELIGIBLE_ROUTE",
          `no rail serves a ${payout.symbol} payout on ${payout.network} with this delivery model`,
          { assetId: payout.assetId, network: payout.network },
        ),
      ],
      rebalances: [],
      shortfall: null,
      rejected: [],
    };
  }

  const rejected: RejectedRoute[] = [];
  const live: Candidate[] = [];
  let anyCapabilityLive = false;
  let worstShortfall: AssetAmount | null = null;

  for (const candidate of structural) {
    const available = capabilities.assertAvailable(candidate.capability);
    if (!available.ok) {
      rejected.push({
        rail: candidate.rail,
        reason: available.violations[0]?.message ?? "capability unavailable",
      });
      continue;
    }
    anyCapabilityLive = true;

    // The μLedger records an obligation; nothing moves, so nothing is needed.
    if (candidate.rail === "MULEDGER") {
      live.push(candidate);
      continue;
    }

    // Everything else must be funded from inventory *on the paying network*.
    const held = availableInventory(request.inventory, candidate.sourceAssetId);
    const required = candidate.fx ? null : payout;

    if (required && held.atomic < required.atomic) {
      const missing = subtractAmounts(required, held);
      if (missing.ok && (worstShortfall === null || missing.value.atomic > worstShortfall.atomic)) {
        worstShortfall = missing.value;
      }
      rejected.push({
        rail: candidate.rail,
        reason: `treasury holds ${formatAmount(held)} on ${candidate.network}, short of the ${formatAmount(required)} this payout needs`,
      });
      continue;
    }

    // A conversion route needs *some* balance of the source asset. How much is
    // required depends on the exchange rate, which is a quote the executor
    // obtains — the router only establishes that the rail could be funded.
    if (candidate.fx && held.atomic <= 0n) {
      rejected.push({
        rail: candidate.rail,
        reason: `treasury holds no ${assetDefinition(candidate.sourceAssetId)?.symbol ?? candidate.sourceAssetId} on ${candidate.network} to convert from`,
      });
      continue;
    }

    live.push(candidate);
  }

  if (live.length === 0) {
    const violations: EconomicViolation[] = [];

    // The inventory gap is computed independently of why candidate evaluation
    // stopped. A treasury that holds none of the payout asset has an inventory
    // problem worth surfacing even when a capability was also missing, and an
    // operator needs to see both rather than only whichever check ran first.
    const heldPayoutAsset = availableInventory(request.inventory, payout.assetId);
    const gap = subtractAmounts(payout, heldPayoutAsset);
    const payoutShortfall = gap.ok && gap.value.atomic > 0n ? gap.value : null;

    if (payoutShortfall) {
      violations.push(
        violation(
          "INSUFFICIENT_INVENTORY",
          `no rail can fund this payout: ${
            rejected.map((route) => route.reason).join("; ") ||
            `treasury holds ${formatAmount(heldPayoutAsset)} on ${payout.network}`
          }`,
          { required: formatAmount(payout), shortfall: formatAmount(payoutShortfall) },
        ),
      );
    }

    if (!anyCapabilityLive) {
      violations.push(
        violation(
          "NO_ELIGIBLE_ROUTE",
          "every structurally valid route depends on a primitive that is not verified live",
          { considered: structural.map((candidate) => candidate.rail).join(",") },
        ),
      );
      for (const route of rejected) {
        violations.push(violation("CAPABILITY_UNAVAILABLE", `${route.rail}: ${route.reason}`));
      }
    } else if (!payoutShortfall && worstShortfall === null) {
      violations.push(
        violation(
          "NO_ELIGIBLE_ROUTE",
          `no live rail can serve a ${payout.symbol} payout on ${payout.network}`,
          { considered: structural.map((candidate) => candidate.rail).join(",") },
        ),
      );
    }

    const shortfall = payoutShortfall ?? worstShortfall;

    return {
      ok: false,
      violations,
      rebalances: shortfall
        ? proposeRebalances(request, capabilities, config, shortfall)
        : [],
      shortfall,
      rejected,
    };
  }

  // Preference order is configuration, not an opinion expressed at call time.
  live.sort((a, b) => {
    const ai = config.railPreference.indexOf(a.rail);
    const bi = config.railPreference.indexOf(b.rail);
    const rank = (index: number): number => (index === -1 ? Number.MAX_SAFE_INTEGER : index);
    if (rank(ai) !== rank(bi)) return rank(ai) - rank(bi);
    return a.sourceAssetId < b.sourceAssetId ? -1 : a.sourceAssetId > b.sourceAssetId ? 1 : 0;
  });

  const chosen = live[0] as Candidate;

  const validation: ValidationStrategy = request.requiresEvaluation
    ? chosen.timing === "IMMEDIATE"
      ? "EVALUATOR_AFTER_PAYMENT"
      : "EVALUATOR_BEFORE_PAYMENT"
    : "NONE";

  const sourceAsset = assetDefinition(chosen.sourceAssetId);

  const plan: RoutePlan = {
    counterpartyAgentId: request.providerAgentId,
    source: {
      network: chosen.network,
      // For a same-asset route the source debit equals the payout. For a
      // conversion the debited quantity depends on a rate the executor quotes,
      // so the plan records the asset and leaves the quantity to that quote.
      amount: chosen.fx
        ? zeroAmount(chosen.sourceAssetId)
        : payout,
      custody: custodyFor(request.inventory, chosen.sourceAssetId),
    },
    payout: request.payout,
    mechanism: chosen.mechanism,
    network: chosen.network,
    rail: chosen.rail,
    fxRoute: chosen.fx
      ? {
          from: sourceAsset?.symbol ?? chosen.sourceAssetId,
          to: payout.symbol,
          via: chosen.rail === "XRPL_PATHFINDING" ? "XRPL_DEX" : "DIRECT",
        }
      : null,
    validation,
    timing: chosen.timing,
    requiredCapability: chosen.capability,
    rebalanceRequired: false,
    rationale: chosen.rationale,
  };

  return { ok: true, decision: { plan, rejected } };
}

/** Canonical asset id for a (network, symbol) pair, re-exported for callers. */
export { canonicalAssetId };
