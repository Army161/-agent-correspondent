/**
 * The economic router (PRODUCT_SPEC §19).
 *
 * Given what needs to happen economically, decide *how*: which counterparty,
 * which contract mechanism, which network, which rail, which asset, which FX
 * route, which validation strategy, and when settlement occurs.
 *
 * The routing rules live here, not in a React component and not in a prompt.
 * The router is a pure function of (request, capabilities, config) so that the
 * same request always routes the same way, and so a routing decision can be
 * replayed during an incident.
 *
 * The shape of the decision:
 *
 *   sub-cent, synchronous, trusted      → x402 / nanopayment
 *   small, recurring, same counterparty → mu-ledger, settle on the next cycle
 *   dollar-scale, asynchronous, needs evaluation → ERC-8183 escrow
 *   cross-currency or cross-network     → XRPL payment / pathfinding
 */

import { fail, ok, violation, type Outcome } from "../errors/index";
import type { SettlementRail } from "../intent/schema";
import type { NetworkId } from "../mandate/schema";
import { formatUsd, type Nanos } from "../units/money";
import type { CapabilityId, ProtocolCapabilityEngine } from "../capability/index";

export type ContractMechanism =
  | "DIRECT_TRANSFER"
  | "HTTP_402"
  | "ERC8183_JOB"
  | "XRPL_ESCROW"
  | "LEDGER_OBLIGATION";

export type ValidationStrategy = "NONE" | "EVALUATOR_BEFORE_PAYMENT" | "EVALUATOR_AFTER_PAYMENT";

export type SettlementTiming = "IMMEDIATE" | "ON_DELIVERY" | "NEXT_CLEARING_CYCLE";

export interface RoutingRequest {
  readonly buyerAgentId: string;
  readonly providerAgentId: string;
  readonly amount: Nanos;
  readonly settlementAsset: string;
  /** Asset the provider wants to be paid in, when it differs from the buyer's. */
  readonly providerAsset?: string;
  readonly buyerNetwork: NetworkId;
  readonly providerNetwork: NetworkId;
  /** True when the work is long-running and the result arrives later. */
  readonly asynchronous: boolean;
  /** True when payment should depend on an evaluator verdict. */
  readonly requiresEvaluation: boolean;
  /** True when buyer and provider already have an open bilateral relationship. */
  readonly recurringCounterparty: boolean;
  readonly counterpartyVerified: boolean;
}

export interface RouterConfig {
  /**
   * At or below this, an on-chain transaction costs more than the payment is
   * worth, so it goes to a nanopayment rail or the mu-ledger.
   */
  readonly nanopaymentCeiling: Nanos;
  /** At or above this, escrow and evaluation are worth their overhead. */
  readonly escrowFloor: Nanos;
  /** Obligations at or below this accumulate on the mu-ledger instead of settling. */
  readonly ledgerAccrualCeiling: Nanos;
  /** Preferred rail order when several are eligible. */
  readonly railPreference: readonly SettlementRail[];
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  nanopaymentCeiling: 10_000_000n, // $0.01
  escrowFloor: 1_000_000_000n, // $1.00
  ledgerAccrualCeiling: 1_000_000n, // $0.001
  railPreference: [
    "MULEDGER",
    "X402",
    "CIRCLE_NANOPAYMENT",
    "ERC8183_ESCROW",
    "XRPL_PAYMENT",
    "XRPL_PATHFINDING",
    "XRPL_ESCROW",
  ],
};

export interface RoutePlan {
  readonly counterpartyAgentId: string;
  readonly mechanism: ContractMechanism;
  readonly network: NetworkId;
  readonly rail: SettlementRail;
  readonly settlementAsset: string;
  /** Present only when buyer and provider assets differ. */
  readonly fxRoute: { readonly from: string; readonly to: string; readonly via: string } | null;
  readonly validation: ValidationStrategy;
  readonly timing: SettlementTiming;
  /** Capability that must be live for this route to execute. */
  readonly requiredCapability: CapabilityId;
  /** Human-readable reason, shown in the chat card and stored in the audit log. */
  readonly rationale: string;
}

interface Candidate {
  readonly rail: SettlementRail;
  readonly mechanism: ContractMechanism;
  readonly network: NetworkId;
  readonly capability: CapabilityId;
  readonly timing: SettlementTiming;
  readonly rationale: string;
}

/**
 * Enumerate the routes that are structurally valid for this request, before
 * checking whether the underlying primitives are actually live.
 */
function candidates(request: RoutingRequest, config: RouterConfig): Candidate[] {
  const out: Candidate[] = [];
  const crossNetwork = request.buyerNetwork !== request.providerNetwork;
  const crossCurrency =
    request.providerAsset !== undefined &&
    request.providerAsset.toUpperCase() !== request.settlementAsset.toUpperCase();

  // Tiny, repeated obligations between the same two agents: do not touch a
  // chain at all. Accrue and clear later.
  if (
    request.amount <= config.ledgerAccrualCeiling &&
    request.recurringCounterparty &&
    !request.asynchronous &&
    !crossNetwork
  ) {
    out.push({
      rail: "MULEDGER",
      mechanism: "LEDGER_OBLIGATION",
      network: "MULEDGER",
      capability: "MULEDGER.BILATERAL_NETTING",
      timing: "NEXT_CLEARING_CYCLE",
      rationale: `${formatUsd(request.amount, { symbol: true })} to a recurring counterparty is below the ${formatUsd(config.ledgerAccrualCeiling, { symbol: true })} accrual ceiling; recorded as an obligation and netted on the next clearing cycle`,
    });
  }

  // Sub-cent synchronous calls: nanopayment rails.
  if (request.amount <= config.nanopaymentCeiling && !request.asynchronous && !crossNetwork) {
    if (request.buyerNetwork === "ARC" || request.buyerNetwork === "ARC_TESTNET") {
      out.push({
        rail: "X402",
        mechanism: "HTTP_402",
        network: request.buyerNetwork,
        capability: "ARC.X402",
        timing: "IMMEDIATE",
        rationale: `${formatUsd(request.amount, { symbol: true })} is a synchronous sub-cent call; settled inline over x402`,
      });
      out.push({
        rail: "CIRCLE_NANOPAYMENT",
        mechanism: "DIRECT_TRANSFER",
        network: request.buyerNetwork,
        capability: "ARC.CIRCLE_NANOPAYMENT",
        timing: "IMMEDIATE",
        rationale: `${formatUsd(request.amount, { symbol: true })} settled as a USDC nanopayment`,
      });
    }
  }

  // Dollar-scale or evaluated asynchronous work: escrow it.
  if (
    (request.amount >= config.escrowFloor || request.asynchronous || request.requiresEvaluation) &&
    (request.buyerNetwork === "ARC" || request.buyerNetwork === "ARC_TESTNET") &&
    !crossNetwork
  ) {
    out.push({
      rail: "ERC8183_ESCROW",
      mechanism: "ERC8183_JOB",
      network: request.buyerNetwork,
      capability: "ARC.ERC8183",
      timing: "ON_DELIVERY",
      rationale: request.requiresEvaluation
        ? "payment is conditional on an evaluator verdict, so funds are escrowed in an ERC-8183 job"
        : `${formatUsd(request.amount, { symbol: true })} of asynchronous work is escrowed until delivery`,
    });
  }

  // XRPL: the cross-currency and cross-network path.
  if (request.providerNetwork === "XRPL" || request.providerNetwork === "XRPL_TESTNET") {
    if (crossCurrency) {
      out.push({
        rail: "XRPL_PATHFINDING",
        mechanism: "DIRECT_TRANSFER",
        network: request.providerNetwork,
        capability: "XRPL.PATHFINDING",
        timing: "IMMEDIATE",
        rationale: `buyer settles in ${request.settlementAsset} and the provider is paid in ${request.providerAsset}; XRPL pathfinding performs the conversion atomically`,
      });
    } else if (request.requiresEvaluation || request.asynchronous) {
      out.push({
        rail: "XRPL_ESCROW",
        mechanism: "XRPL_ESCROW",
        network: request.providerNetwork,
        capability: "XRPL.ESCROW",
        timing: "ON_DELIVERY",
        rationale: "asynchronous XRPL settlement is held in escrow until delivery",
      });
    } else {
      out.push({
        rail: "XRPL_PAYMENT",
        mechanism: "DIRECT_TRANSFER",
        network: request.providerNetwork,
        capability: "XRPL.PAYMENTS",
        timing: "IMMEDIATE",
        rationale: "direct XRPL payment to the provider's account",
      });
    }
  }

  return out;
}

export interface RouteDecision {
  readonly plan: RoutePlan;
  /** Routes that were structurally valid but whose primitives are not live. */
  readonly rejected: readonly { rail: SettlementRail; reason: string }[];
}

export function routeIntent(
  request: RoutingRequest,
  capabilities: ProtocolCapabilityEngine,
  config: RouterConfig = DEFAULT_ROUTER_CONFIG,
): Outcome<RouteDecision> {
  if (request.amount <= 0n) {
    return fail(violation("INVALID_AMOUNT", "routing requires a positive amount"));
  }

  const structural = candidates(request, config);
  if (structural.length === 0) {
    return fail(
      violation(
        "NO_ELIGIBLE_ROUTE",
        "no rail matches this combination of amount, networks and delivery model",
        {
          amount: request.amount,
          buyerNetwork: request.buyerNetwork,
          providerNetwork: request.providerNetwork,
        },
      ),
    );
  }

  const rejected: { rail: SettlementRail; reason: string }[] = [];
  const live: Candidate[] = [];
  for (const candidate of structural) {
    const available = capabilities.assertAvailable(candidate.capability);
    if (available.ok) live.push(candidate);
    else {
      rejected.push({
        rail: candidate.rail,
        reason: available.violations[0]?.message ?? "capability unavailable",
      });
    }
  }

  if (live.length === 0) {
    return fail([
      violation(
        "NO_ELIGIBLE_ROUTE",
        "every structurally valid route depends on a primitive that is not verified live",
        { considered: structural.map((c) => c.rail).join(",") },
      ),
      ...rejected.map((r) => violation("CAPABILITY_UNAVAILABLE", `${r.rail}: ${r.reason}`)),
    ]);
  }

  // Preference order is configuration, not opinion expressed at call time.
  live.sort((a, b) => {
    const ai = config.railPreference.indexOf(a.rail);
    const bi = config.railPreference.indexOf(b.rail);
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  });

  const chosen = live[0] as Candidate;
  const crossCurrency =
    request.providerAsset !== undefined &&
    request.providerAsset.toUpperCase() !== request.settlementAsset.toUpperCase();

  const validation: ValidationStrategy = request.requiresEvaluation
    ? chosen.timing === "IMMEDIATE"
      ? "EVALUATOR_AFTER_PAYMENT"
      : "EVALUATOR_BEFORE_PAYMENT"
    : "NONE";

  const plan: RoutePlan = {
    counterpartyAgentId: request.providerAgentId,
    mechanism: chosen.mechanism,
    network: chosen.network,
    rail: chosen.rail,
    settlementAsset: request.settlementAsset.toUpperCase(),
    fxRoute: crossCurrency
      ? {
          from: request.settlementAsset.toUpperCase(),
          to: (request.providerAsset as string).toUpperCase(),
          via: chosen.rail === "XRPL_PATHFINDING" ? "XRPL_DEX" : "DIRECT",
        }
      : null,
    validation,
    timing: chosen.timing,
    requiredCapability: chosen.capability,
    rationale: chosen.rationale,
  };

  return ok({ plan, rejected });
}
