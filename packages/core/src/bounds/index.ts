/**
 * Fail-closed execution bounds (PRODUCT_SPEC §24).
 *
 * Between signing an intent and executing it, the world moves: a quote goes
 * stale, an FX rate drifts, a relay hands back a different destination address,
 * a rail substitutes a "equivalent" token. Every one of those is a way to lose
 * money, and none of them is a question for a language model.
 *
 * `enforceBounds` compares what was authorized against what is about to happen
 * and returns violations. Any violation means do not execute. There is no
 * "close enough", no override flag, and no path that asks the model to decide.
 */

import { violation, type EconomicViolation } from "../errors/index";
import { slippageBps } from "../units/money";
import { formatAtomic } from "../units/decimal";
import { assetDefinition, canonicalAssetId } from "../assets/registry";
import { intentAssetId, type EconomicIntent } from "../intent/schema";

/**
 * What the executor is actually about to do.
 *
 * Every amount is an integer of the settlement asset's **smallest unit** — the
 * same units the intent authorized and the same units the rail moves. Nothing
 * here is denominated in dollars, because a comparison between an authorization
 * in one unit and an execution in another is exactly the class of bug this
 * function exists to catch.
 */
export interface ExecutionPlan {
  /** Total leaving the buyer, in settlement-asset atomic units, fees included. */
  readonly totalSpend: bigint;
  /** What the provider will receive, in settlement-asset atomic units. */
  readonly providerReceives: bigint;
  /** Rail/protocol fee, in settlement-asset atomic units. */
  readonly railFee: bigint;
  /** Network/gas fee, in settlement-asset atomic units. */
  readonly networkFee: bigint;
  readonly asset: string;
  readonly network: string;
  readonly destination: string;
  readonly rail: string;
  /** Expected received amount at quote time, for slippage measurement. */
  readonly quotedReceive?: bigint;
  /** When the quote backing this plan was produced. */
  readonly quotedAt?: Date;
}

export interface BoundsOptions {
  /** Maximum age of a quote, in seconds. */
  readonly maxQuoteAgeSeconds?: number;
}

export interface BoundsResult {
  readonly authorized: boolean;
  readonly violations: readonly EconomicViolation[];
}

export function enforceBounds(
  intent: EconomicIntent,
  plan: ExecutionPlan,
  now: Date,
  options: BoundsOptions = {},
): BoundsResult {
  const violations: EconomicViolation[] = [];
  const nowSeconds = Math.floor(now.getTime() / 1000);

  // Amounts are rendered at the settlement asset's own scale so a violation
  // message says "0.025 USDC", not a bare integer of unclear units.
  const authorizedAssetId = intentAssetId(intent);
  const decimals = assetDefinition(authorizedAssetId)?.decimals;
  const show = (atomic: bigint): string =>
    decimals === undefined
      ? `${atomic} atomic units`
      : `${formatAtomic(atomic, decimals)} ${intent.settlementAsset}`;

  // --- the authorization must still be live -------------------------------
  if (nowSeconds > intent.expiresAt) {
    violations.push(
      violation("AUTHORIZATION_EXPIRED", "authorization expired before execution", {
        expiresAt: intent.expiresAt,
        now: nowSeconds,
      }),
    );
  }
  if (nowSeconds > intent.deadline) {
    violations.push(
      violation("INTENT_EXPIRED", "work deadline has passed", {
        deadline: intent.deadline,
        now: nowSeconds,
      }),
    );
  }

  // --- substitution attacks ------------------------------------------------
  if (plan.asset.toUpperCase() !== intent.settlementAsset.toUpperCase()) {
    violations.push(
      violation("ASSET_SUBSTITUTION", `execution would settle in ${plan.asset}, not ${intent.settlementAsset}`, {
        expected: intent.settlementAsset,
        actual: plan.asset,
      }),
    );
  }
  if (plan.network.toUpperCase() !== intent.network.toUpperCase()) {
    violations.push(
      violation("NETWORK_SUBSTITUTION", `execution would settle on ${plan.network}, not ${intent.network}`, {
        expected: intent.network,
        actual: plan.network,
      }),
    );
  }
  // Symbol and network matching separately is not sufficient: two assets can
  // share both and still differ by issuer or contract. The resolved identity is
  // the check that catches a look-alike issuer.
  const planAssetId = canonicalAssetId(plan.network, plan.asset);
  if (planAssetId !== authorizedAssetId) {
    violations.push(
      violation(
        "ASSET_SUBSTITUTION",
        `execution resolves to asset ${planAssetId}, but the authorization is for ${authorizedAssetId}`,
        { expected: authorizedAssetId, actual: planAssetId },
      ),
    );
  }

  // Destination comparison is case-insensitive because EVM addresses are
  // checksummed inconsistently across tools; it is otherwise exact.
  if (plan.destination.toLowerCase() !== intent.destination.toLowerCase()) {
    violations.push(
      violation("DESTINATION_SUBSTITUTION", "payout destination does not match the authorization", {
        expected: intent.destination,
        actual: plan.destination,
      }),
    );
  }
  if (!(intent.allowedRails as readonly string[]).includes(plan.rail)) {
    violations.push(
      violation("NO_ELIGIBLE_ROUTE", `rail ${plan.rail} is not authorized by this intent`, {
        rail: plan.rail,
        allowed: intent.allowedRails.join(","),
      }),
    );
  }

  // --- amounts -------------------------------------------------------------
  if (plan.totalSpend > intent.maxSpend) {
    violations.push(
      violation(
        "MAX_SPEND_EXCEEDED",
        `execution would spend ${show(plan.totalSpend)}, above the authorized ${show(intent.maxSpend)}`,
        { authorized: intent.maxSpend, planned: plan.totalSpend },
      ),
    );
  }
  if (plan.providerReceives < intent.minReceive) {
    violations.push(
      violation(
        "MIN_RECEIVE_NOT_MET",
        `provider would receive ${show(plan.providerReceives)}, below the required ${show(intent.minReceive)}`,
        { required: intent.minReceive, planned: plan.providerReceives },
      ),
    );
  }
  if (plan.networkFee > intent.maxNetworkFee) {
    violations.push(
      violation(
        "MAX_NETWORK_FEE_EXCEEDED",
        `network fee ${show(plan.networkFee)} exceeds the authorized ${show(intent.maxNetworkFee)}`,
        { authorized: intent.maxNetworkFee, planned: plan.networkFee },
      ),
    );
  }

  // Internal consistency: the parts must add up to the whole. A plan whose
  // components do not reconcile is malformed regardless of its ceilings.
  const reconciled = plan.providerReceives + plan.railFee + plan.networkFee;
  if (reconciled !== plan.totalSpend) {
    violations.push(
      violation(
        "MAX_FEE_EXCEEDED",
        `execution plan does not reconcile: ${show(plan.providerReceives)} + ${show(plan.railFee)} + ${show(plan.networkFee)} != ${show(plan.totalSpend)}`,
        { reconciled, totalSpend: plan.totalSpend },
      ),
    );
  }

  // --- FX slippage ---------------------------------------------------------
  if (plan.quotedReceive !== undefined && plan.quotedReceive > 0n) {
    const drift = slippageBps(plan.quotedReceive, plan.providerReceives);
    if (drift > intent.maxFxSlippageBps) {
      violations.push(
        violation(
          "FX_SLIPPAGE_EXCEEDED",
          `received amount drifted ${drift} bps from the quote, above the authorized ${intent.maxFxSlippageBps} bps`,
          { drift, authorized: intent.maxFxSlippageBps },
        ),
      );
    }
  }

  // --- quote freshness -----------------------------------------------------
  const maxAge = options.maxQuoteAgeSeconds ?? 60;
  if (plan.quotedAt) {
    const age = nowSeconds - Math.floor(plan.quotedAt.getTime() / 1000);
    if (age > maxAge) {
      violations.push(
        violation("QUOTE_STALE", `quote is ${age}s old, older than the ${maxAge}s limit`, {
          age,
          maxAge,
        }),
      );
    }
  }

  return { authorized: violations.length === 0, violations };
}
