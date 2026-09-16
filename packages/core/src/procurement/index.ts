/**
 * Procurement (PRODUCT_SPEC §12).
 *
 * The cheapest provider is frequently the most expensive one. A $0.004 call
 * that fails a third of the time, takes nine seconds, and comes from an
 * unverified counterparty costs more than a $0.010 call that works — in retries,
 * in latency, and in the tail risk of paying for nothing.
 *
 * So ranking is on *effective cost*, every component of which is expressed in
 * nanos so they can be added honestly:
 *
 *   effectiveCost = price
 *                 + latencyPenalty
 *                 + failureRisk
 *                 + validationCost
 *                 + counterpartyRisk
 */

import { fail, ok, violation, type Outcome } from "../errors/index";
import { formatUsd, type Nanos } from "../units/money";
import type { ProviderMatch } from "../discovery/index";

export interface ProcurementWeights {
  /** Nanos charged per second of expected latency. */
  readonly latencyCostPerSecond: Nanos;
  /** Assumed success rate when a provider has no history. */
  readonly assumedSuccessRateUnknown: number;
  /** Nanos added for running an evaluator over the result. */
  readonly validationCost: Nanos;
  /** Multiplier on price charged for an unverified counterparty. */
  readonly unverifiedRiskMultiplierBps: number;
  /** Extra risk charged for a provider with no completed jobs, in bps of price. */
  readonly coldStartRiskBps: number;
}

export const DEFAULT_WEIGHTS: ProcurementWeights = {
  // A second of agent latency is worth about a tenth of a cent. This is the
  // single most opinionated number in the engine; it belongs in config, not in
  // a prompt.
  latencyCostPerSecond: 1_000_000n, // $0.001/s
  assumedSuccessRateUnknown: 0.8,
  validationCost: 200_000n, // $0.0002
  unverifiedRiskMultiplierBps: 5_000, // +50% of price
  coldStartRiskBps: 1_000, // +10% of price
};

export interface RankedProvider {
  readonly agentId: string;
  readonly displayName: string;
  readonly capabilityId: string;
  readonly price: Nanos;
  readonly latencyMs: number;
  readonly reputation: number | null;
  readonly verified: boolean;
  readonly effectiveCost: Nanos;
  readonly components: {
    readonly price: Nanos;
    readonly latencyPenalty: Nanos;
    readonly failureRisk: Nanos;
    readonly validationCost: Nanos;
    readonly counterpartyRisk: Nanos;
  };
  readonly destination: string;
  readonly match: ProviderMatch;
}

export interface RankOptions {
  readonly weights?: ProcurementWeights;
  /** Require an evaluator pass before payment; adds validation cost. */
  readonly requireValidation?: boolean;
  /** Hard ceiling: providers whose *price* exceeds this are excluded. */
  readonly maxSpend?: Nanos;
}

function bpsOf(amount: Nanos, bps: number): Nanos {
  return (amount * BigInt(Math.round(bps))) / 10_000n;
}

export function rankProviders(
  matches: readonly ProviderMatch[],
  options: RankOptions = {},
): readonly RankedProvider[] {
  const weights = options.weights ?? DEFAULT_WEIGHTS;

  const ranked = matches
    .filter((match) => options.maxSpend === undefined || match.capability.price <= options.maxSpend)
    .map((match): RankedProvider => {
      const { provider, capability } = match;

      const latencyPenalty =
        (weights.latencyCostPerSecond * BigInt(Math.round(capability.latencyMs))) / 1000n;

      // Expected cost of a failure is the price paid for work that has to be
      // redone: price * (1 - successRate) / successRate, approximated in bps to
      // stay in integer math.
      const successRate =
        provider.successRate ??
        (provider.reputation !== null
          ? Math.max(0.5, provider.reputation / 100)
          : weights.assumedSuccessRateUnknown);
      const failureBps = Math.round(((1 - successRate) / Math.max(successRate, 0.01)) * 10_000);
      const failureRisk = bpsOf(capability.price, failureBps);

      const validationCost =
        options.requireValidation && capability.validationSupported ? weights.validationCost : 0n;

      let counterpartyRisk = provider.verified
        ? 0n
        : bpsOf(capability.price, weights.unverifiedRiskMultiplierBps);
      if (provider.completedJobs === 0) {
        counterpartyRisk += bpsOf(capability.price, weights.coldStartRiskBps);
      }

      const effectiveCost =
        capability.price + latencyPenalty + failureRisk + validationCost + counterpartyRisk;

      return {
        agentId: provider.agentId,
        displayName: provider.displayName,
        capabilityId: capability.capabilityId,
        price: capability.price,
        latencyMs: capability.latencyMs,
        reputation: provider.reputation,
        verified: provider.verified,
        effectiveCost,
        components: {
          price: capability.price,
          latencyPenalty,
          failureRisk,
          validationCost,
          counterpartyRisk,
        },
        destination: provider.destination,
        match,
      };
    });

  // Deterministic order: effective cost, then price, then agent id. Two runs
  // over the same inputs must produce the same winner, always.
  return ranked.sort((a, b) => {
    if (a.effectiveCost !== b.effectiveCost) return a.effectiveCost < b.effectiveCost ? -1 : 1;
    if (a.price !== b.price) return a.price < b.price ? -1 : 1;
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
  });
}

export function selectProvider(
  matches: readonly ProviderMatch[],
  options: RankOptions = {},
): Outcome<RankedProvider> {
  const ranked = rankProviders(matches, options);
  const best = ranked[0];
  if (!best) {
    return fail(
      violation("NO_ELIGIBLE_PROVIDER", "no provider satisfies the request within its bounds"),
    );
  }
  return ok(best);
}

export function explainRanking(provider: RankedProvider): string {
  const c = provider.components;
  return [
    `price ${formatUsd(c.price, { symbol: true })}`,
    `latency ${formatUsd(c.latencyPenalty, { symbol: true })}`,
    `failure risk ${formatUsd(c.failureRisk, { symbol: true })}`,
    `validation ${formatUsd(c.validationCost, { symbol: true })}`,
    `counterparty ${formatUsd(c.counterpartyRisk, { symbol: true })}`,
    `= ${formatUsd(provider.effectiveCost, { symbol: true })}`,
  ].join("  •  ");
}
