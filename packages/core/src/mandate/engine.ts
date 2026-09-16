/**
 * The mandate engine.
 *
 * Every spend in Agent Correspondent passes through `evaluateMandate` before it
 * reaches a rail. The function is pure and total: same inputs, same decision,
 * no I/O, no model call. A language model can *propose* a payment; only this
 * function can authorize one.
 *
 * It is fail-closed by construction. A missing mandate, an unknown balance or
 * an unreadable spend history is a denial, not a default.
 */

import { violation, type EconomicViolation } from "../errors/index";
import { formatUsd, type Nanos } from "../units/money";
import type { EconomicMandate, NetworkId } from "./schema";

export type MandateDecisionKind = "ALLOW" | "REQUIRE_HUMAN_APPROVAL" | "DENY";

export interface MandateRequest {
  /** Gross amount leaving the agent, in nanos, fees included. */
  readonly amount: Nanos;
  readonly asset: string;
  readonly network: string;
  /**
   * Whether the counterparty has a verified identity (an ERC-8004 record, a
   * prior settled job, or an operator allowlist entry).
   */
  readonly counterpartyVerified: boolean;
  /** True when the agent takes on an obligation rather than paying now. */
  readonly incursCredit?: boolean;
  /** True when the spend buys a non-settlement token. */
  readonly isTokenTrade?: boolean;
  /** Human approval already captured for this exact amount. */
  readonly humanApprovalGranted?: boolean;
}

export interface MandateContext {
  /**
   * Spendable balance for `asset` on `network`, in nanos.
   * `null` means unknown — which is a denial, never an assumption.
   */
  readonly availableBalance: Nanos | null;
  /** Nanos already committed in the current mandate day. `null` means unknown. */
  readonly spentToday: Nanos | null;
  /** Start of the current mandate day (UTC), used only for reporting. */
  readonly dayStart?: Date;
}

export interface MandateCheck {
  readonly rule: string;
  readonly passed: boolean;
  readonly limit?: string;
  readonly observed?: string;
}

export interface MandateDecision {
  readonly decision: MandateDecisionKind;
  readonly violations: readonly EconomicViolation[];
  /** Full rule trace, in fixed order, for the audit log and the UI. */
  readonly checks: readonly MandateCheck[];
  /** Remaining daily headroom after this spend, when computable. */
  readonly remainingDailyLimit: Nanos | null;
}

const NO_MANDATE_DECISION: MandateDecision = {
  decision: "DENY",
  violations: [
    violation("MANDATE_MISSING", "agent has no economic mandate; all spending is denied"),
  ],
  checks: [{ rule: "mandate.present", passed: false }],
  remainingDailyLimit: null,
};

export function evaluateMandate(
  mandate: EconomicMandate | null | undefined,
  request: MandateRequest,
  context: MandateContext,
): MandateDecision {
  if (!mandate) return NO_MANDATE_DECISION;

  const violations: EconomicViolation[] = [];
  const checks: MandateCheck[] = [];

  const record = (
    rule: string,
    passed: boolean,
    extra?: { limit?: string; observed?: string },
  ): boolean => {
    checks.push({ rule, passed, ...extra });
    return passed;
  };

  // --- amount sanity -------------------------------------------------------
  if (
    !record("amount.positive", request.amount > 0n, {
      observed: formatUsd(request.amount, { symbol: true }),
    })
  ) {
    violations.push(
      violation("INVALID_AMOUNT", "spend amount must be greater than zero", {
        amount: request.amount,
      }),
    );
  }

  // --- allowlists ----------------------------------------------------------
  const asset = request.asset.toUpperCase();
  const assetAllowed = (mandate.allowedAssets as readonly string[]).includes(asset);
  record("asset.allowed", assetAllowed, {
    limit: mandate.allowedAssets.join(", "),
    observed: asset,
  });
  if (!assetAllowed) {
    violations.push(
      violation("ASSET_NOT_ALLOWED", `asset ${asset} is not in the mandate allowlist`, {
        asset,
        allowed: mandate.allowedAssets.join(","),
      }),
    );
  }

  const network = request.network.toUpperCase() as NetworkId;
  const networkAllowed = (mandate.allowedNetworks as readonly string[]).includes(network);
  record("network.allowed", networkAllowed, {
    limit: mandate.allowedNetworks.join(", "),
    observed: network,
  });
  if (!networkAllowed) {
    violations.push(
      violation("NETWORK_NOT_ALLOWED", `network ${network} is not in the mandate allowlist`, {
        network,
        allowed: mandate.allowedNetworks.join(","),
      }),
    );
  }

  // --- per-transaction ceiling --------------------------------------------
  const withinTransactionLimit = request.amount <= mandate.maxTransactionUsd;
  record("transaction.max", withinTransactionLimit, {
    limit: formatUsd(mandate.maxTransactionUsd, { symbol: true }),
    observed: formatUsd(request.amount, { symbol: true }),
  });
  if (!withinTransactionLimit) {
    violations.push(
      violation(
        "MAX_TRANSACTION_EXCEEDED",
        `${formatUsd(request.amount, { symbol: true })} exceeds the per-transaction limit of ${formatUsd(mandate.maxTransactionUsd, { symbol: true })}`,
        { amount: request.amount, limit: mandate.maxTransactionUsd },
      ),
    );
  }

  // --- daily budget --------------------------------------------------------
  let remainingDailyLimit: Nanos | null = null;
  if (context.spentToday === null) {
    record("daily.known", false);
    violations.push(
      violation(
        "CONTEXT_INCOMPLETE",
        "today's spend is unknown; the daily limit cannot be enforced, so the spend is denied",
      ),
    );
  } else {
    const projected = context.spentToday + request.amount;
    const withinDaily = projected <= mandate.dailySpendLimitUsd;
    record("daily.limit", withinDaily, {
      limit: formatUsd(mandate.dailySpendLimitUsd, { symbol: true }),
      observed: formatUsd(projected, { symbol: true }),
    });
    remainingDailyLimit =
      mandate.dailySpendLimitUsd - projected > 0n ? mandate.dailySpendLimitUsd - projected : 0n;
    if (!withinDaily) {
      violations.push(
        violation(
          "DAILY_LIMIT_EXCEEDED",
          `this spend would bring today's total to ${formatUsd(projected, { symbol: true })}, above the daily limit of ${formatUsd(mandate.dailySpendLimitUsd, { symbol: true })}`,
          { projected, limit: mandate.dailySpendLimitUsd, spentToday: context.spentToday },
        ),
      );
    }
  }

  // --- reserve floor -------------------------------------------------------
  if (context.availableBalance === null) {
    record("reserve.known", false);
    violations.push(
      violation(
        "CONTEXT_INCOMPLETE",
        "wallet balance is unknown; the minimum reserve cannot be enforced, so the spend is denied",
      ),
    );
  } else {
    const remaining = context.availableBalance - request.amount;
    const reserveHeld = remaining >= mandate.minimumReserveUsd;
    record("reserve.floor", reserveHeld, {
      limit: formatUsd(mandate.minimumReserveUsd, { symbol: true }),
      observed: formatUsd(remaining, { symbol: true }),
    });
    if (!reserveHeld) {
      violations.push(
        violation(
          "MINIMUM_RESERVE_BREACHED",
          `this spend would leave ${formatUsd(remaining, { symbol: true })}, below the required reserve of ${formatUsd(mandate.minimumReserveUsd, { symbol: true })}`,
          { remaining, reserve: mandate.minimumReserveUsd },
        ),
      );
    }
  }

  // --- counterparty risk ---------------------------------------------------
  const counterpartyOk =
    request.counterpartyVerified || request.amount <= mandate.unverifiedCounterpartyLimitUsd;
  record("counterparty.unverifiedLimit", counterpartyOk, {
    limit: formatUsd(mandate.unverifiedCounterpartyLimitUsd, { symbol: true }),
    observed: request.counterpartyVerified ? "verified" : formatUsd(request.amount, { symbol: true }),
  });
  if (!counterpartyOk) {
    violations.push(
      violation(
        "UNVERIFIED_COUNTERPARTY_LIMIT",
        `counterparty is unverified; the limit for unverified counterparties is ${formatUsd(mandate.unverifiedCounterpartyLimitUsd, { symbol: true })}`,
        { amount: request.amount, limit: mandate.unverifiedCounterpartyLimitUsd },
      ),
    );
  }

  // --- structural permissions ---------------------------------------------
  const creditOk = !request.incursCredit || mandate.creditAllowed;
  record("credit.allowed", creditOk);
  if (!creditOk) {
    violations.push(
      violation("CREDIT_NOT_ALLOWED", "this mandate does not permit the agent to take on credit"),
    );
  }

  const tradeOk = !request.isTokenTrade || mandate.tokenTradingAllowed;
  record("tokenTrading.allowed", tradeOk);
  if (!tradeOk) {
    violations.push(
      violation("TOKEN_TRADING_NOT_ALLOWED", "this mandate does not permit token trading"),
    );
  }

  if (violations.length > 0) {
    return { decision: "DENY", violations, checks, remainingDailyLimit };
  }

  // --- human in the loop ---------------------------------------------------
  const needsHuman = request.amount > mandate.humanApprovalAboveUsd;
  const humanSatisfied = !needsHuman || request.humanApprovalGranted === true;
  record("human.approval", humanSatisfied, {
    limit: formatUsd(mandate.humanApprovalAboveUsd, { symbol: true }),
    observed: formatUsd(request.amount, { symbol: true }),
  });

  if (!humanSatisfied) {
    return {
      decision: "REQUIRE_HUMAN_APPROVAL",
      violations: [
        violation(
          "HUMAN_APPROVAL_REQUIRED",
          `${formatUsd(request.amount, { symbol: true })} is above the ${formatUsd(mandate.humanApprovalAboveUsd, { symbol: true })} human-approval threshold`,
          { amount: request.amount, threshold: mandate.humanApprovalAboveUsd },
        ),
      ],
      checks,
      remainingDailyLimit,
    };
  }

  return { decision: "ALLOW", violations: [], checks, remainingDailyLimit };
}

/** Compact, human-readable summary for chat cards and the audit log. */
export function summarizeDecision(decision: MandateDecision): string {
  switch (decision.decision) {
    case "ALLOW":
      return "PASS";
    case "REQUIRE_HUMAN_APPROVAL":
      return "APPROVAL REQUIRED";
    case "DENY":
      return `BLOCKED — ${decision.violations.map((v) => v.code).join(", ")}`;
  }
}
