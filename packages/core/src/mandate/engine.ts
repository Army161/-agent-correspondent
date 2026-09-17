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
import { formatAmount, type AssetAmount } from "../assets/amount";
import { valueInUsd, type PriceQuote, type UsdValue } from "../assets/valuation";
import type { EconomicMandate, NetworkId } from "./schema";

export type MandateDecisionKind = "ALLOW" | "REQUIRE_HUMAN_APPROVAL" | "DENY";

interface MandateRequestBase {
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

/**
 * A spend denominated in a specific asset.
 *
 * This is the form every rail produces. The engine values it in USD before
 * testing it against the mandate's dollar limits, and denies the spend if it
 * cannot — one XRP is not one dollar, and a mandate that cannot be evaluated
 * cannot be satisfied.
 */
export interface AssetMandateRequest extends MandateRequestBase {
  readonly amount: AssetAmount;
  /** A price for the asset, when it has no registered USD peg. */
  readonly quote?: PriceQuote;
  /** Maximum acceptable quote age, in seconds. */
  readonly maxQuoteAgeSeconds?: number;
}

/**
 * A spend the caller has already expressed in US dollars.
 *
 * Used where the amount genuinely originates in dollars — an operator asking
 * "could this agent spend five dollars?", or an internal μLedger obligation.
 * The caller owns the valuation; the engine does not invent one.
 */
export interface UsdMandateRequest extends MandateRequestBase {
  /** Gross amount leaving the agent, in nanodollars, fees included. */
  readonly amount: Nanos;
  readonly asset: string;
  readonly network: string;
}

export type MandateRequest = AssetMandateRequest | UsdMandateRequest;

function isUsdRequest(request: MandateRequest): request is UsdMandateRequest {
  return typeof request.amount === "bigint";
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
  /** Evaluation time, used for valuation freshness. Defaults to now. */
  readonly now?: Date;
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
  /**
   * How the spend was valued in dollars, when it was. Absent means the spend
   * could not be valued — which is always a denial.
   */
  readonly valuation?: UsdValue;
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
  const now = context.now ?? new Date();

  const record = (
    rule: string,
    passed: boolean,
    extra?: { limit?: string; observed?: string },
  ): boolean => {
    checks.push({ rule, passed, ...extra });
    return passed;
  };

  // --- valuation -----------------------------------------------------------
  //
  // Mandate limits are dollar figures, so a spend has to become a dollar figure
  // before it can be tested against them. For a USD-denominated request the
  // caller has already done that. For an asset-native request the engine values
  // it — by registered peg where one exists, otherwise from a supplied price —
  // and a spend that cannot be valued cannot be checked, so it is denied.
  let usdAmount: Nanos | null = null;
  let valuation: UsdValue | undefined;
  let asset: string;
  let network: string;
  let nativeDescription: string;
  let amountIsPositive: boolean;

  if (isUsdRequest(request)) {
    usdAmount = request.amount;
    asset = request.asset.toUpperCase();
    network = request.network.toUpperCase();
    nativeDescription = formatUsd(request.amount, { symbol: true });
    amountIsPositive = request.amount > 0n;
    record("valuation.available", true, { observed: "caller-denominated USD" });
  } else {
    const amount = request.amount;
    asset = amount.symbol.toUpperCase();
    network = amount.network.toUpperCase();
    nativeDescription = formatAmount(amount);
    amountIsPositive = amount.atomic > 0n;

    const valued = valueInUsd(amount, {
      now,
      ...(request.quote ? { quote: request.quote } : {}),
      ...(request.maxQuoteAgeSeconds !== undefined
        ? { maxQuoteAgeSeconds: request.maxQuoteAgeSeconds }
        : {}),
    });

    if (valued.ok) {
      valuation = valued.value;
      usdAmount = valued.value.nanos;
      record("valuation.available", true, {
        observed: `${formatUsd(valued.value.nanos, { symbol: true })} via ${valued.value.source.kind}`,
      });
    } else {
      record("valuation.available", false, { observed: nativeDescription });
      violations.push(...valued.violations);
    }
  }

  // --- amount sanity -------------------------------------------------------
  if (!record("amount.positive", amountIsPositive, { observed: nativeDescription })) {
    violations.push(
      violation("INVALID_AMOUNT", "spend amount must be greater than zero", {
        amount: nativeDescription,
      }),
    );
  }

  // --- allowlists ----------------------------------------------------------
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

  const networkAllowed = (mandate.allowedNetworks as readonly string[]).includes(network as NetworkId);
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
  //
  // Every limit below is a dollar figure, so each is skipped when the spend
  // could not be valued. Skipping is safe only because an unvalued spend has
  // already been denied above.
  if (usdAmount !== null) {
    const withinTransactionLimit = usdAmount <= mandate.maxTransactionUsd;
    record("transaction.max", withinTransactionLimit, {
      limit: formatUsd(mandate.maxTransactionUsd, { symbol: true }),
      observed: formatUsd(usdAmount, { symbol: true }),
    });
    if (!withinTransactionLimit) {
      violations.push(
        violation(
          "MAX_TRANSACTION_EXCEEDED",
          `${formatUsd(usdAmount, { symbol: true })} exceeds the per-transaction limit of ${formatUsd(mandate.maxTransactionUsd, { symbol: true })}`,
          { amount: usdAmount, limit: mandate.maxTransactionUsd, native: nativeDescription },
        ),
      );
    }
  }

  // --- daily budget --------------------------------------------------------
  let remainingDailyLimit: Nanos | null = null;
  if (usdAmount === null) {
    record("daily.limit", false, { observed: "spend could not be valued" });
  } else if (context.spentToday === null) {
    record("daily.known", false);
    violations.push(
      violation(
        "CONTEXT_INCOMPLETE",
        "today's spend is unknown; the daily limit cannot be enforced, so the spend is denied",
      ),
    );
  } else {
    const projected = context.spentToday + usdAmount;
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
  //
  // Dipping below the reserve floor *is* taking on credit — the agent would
  // owe more than it holds. Rather than a hard wall independent of
  // `creditAllowed`, a mandate that explicitly permits credit is allowed to
  // breach the reserve; one that does not is denied exactly as before. This
  // is what makes `creditAllowed` mean something on the real settlement path,
  // where nothing else ever sets `incursCredit` explicitly.
  if (usdAmount === null) {
    record("reserve.floor", false, { observed: "spend could not be valued" });
  } else if (context.availableBalance === null) {
    record("reserve.known", false);
    violations.push(
      violation(
        "CONTEXT_INCOMPLETE",
        "wallet balance is unknown; the minimum reserve cannot be enforced, so the spend is denied",
      ),
    );
  } else {
    const remaining = context.availableBalance - usdAmount;
    const wouldBreachReserve = remaining < mandate.minimumReserveUsd;
    const reserveHeld = !wouldBreachReserve || mandate.creditAllowed;
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
    request.counterpartyVerified ||
    (usdAmount !== null && usdAmount <= mandate.unverifiedCounterpartyLimitUsd);
  record("counterparty.unverifiedLimit", counterpartyOk, {
    limit: formatUsd(mandate.unverifiedCounterpartyLimitUsd, { symbol: true }),
    observed: request.counterpartyVerified
      ? "verified"
      : usdAmount === null
        ? "unvalued"
        : formatUsd(usdAmount, { symbol: true }),
  });
  if (!counterpartyOk && usdAmount !== null) {
    violations.push(
      violation(
        "UNVERIFIED_COUNTERPARTY_LIMIT",
        `counterparty is unverified; the limit for unverified counterparties is ${formatUsd(mandate.unverifiedCounterpartyLimitUsd, { symbol: true })}`,
        { amount: usdAmount, limit: mandate.unverifiedCounterpartyLimitUsd },
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
    return {
      decision: "DENY",
      violations,
      checks,
      remainingDailyLimit,
      ...(valuation ? { valuation } : {}),
    };
  }

  // --- human in the loop ---------------------------------------------------
  const needsHuman = usdAmount !== null && usdAmount > mandate.humanApprovalAboveUsd;
  const humanSatisfied = !needsHuman || request.humanApprovalGranted === true;
  record("human.approval", humanSatisfied, {
    limit: formatUsd(mandate.humanApprovalAboveUsd, { symbol: true }),
    observed: usdAmount === null ? "unvalued" : formatUsd(usdAmount, { symbol: true }),
  });

  if (!humanSatisfied) {
    return {
      decision: "REQUIRE_HUMAN_APPROVAL",
      violations: [
        violation(
          "HUMAN_APPROVAL_REQUIRED",
          `${formatUsd(usdAmount as Nanos, { symbol: true })} is above the ${formatUsd(mandate.humanApprovalAboveUsd, { symbol: true })} human-approval threshold`,
          { amount: usdAmount as Nanos, threshold: mandate.humanApprovalAboveUsd },
        ),
      ],
      checks,
      remainingDailyLimit,
      ...(valuation ? { valuation } : {}),
    };
  }

  return {
    decision: "ALLOW",
    violations: [],
    checks,
    remainingDailyLimit,
    ...(valuation ? { valuation } : {}),
  };
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
