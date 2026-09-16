/**
 * The settlement plane boundary.
 *
 * Every rail — Arc, Circle, XRPL, and the optional Kaleido and BlockDAG
 * integrations — implements the same interface, so the router can choose
 * between them without knowing anything about their internals, and so a rail
 * that is not configured reports that fact instead of pretending.
 *
 * Two rules hold for every adapter in this package:
 *
 *  1. An adapter never decides whether a payment is allowed. It receives an
 *     authorization that the mandate engine and the bounds enforcer have
 *     already approved, and it re-checks the bounds immediately before
 *     submitting.
 *  2. An adapter with missing credentials reports `NOT_CONFIGURED`. It never
 *     falls back to a simulation, and it never returns a fabricated balance or
 *     transaction hash.
 */

import type {
  AssetAmount,
  CapabilityId,
  EconomicIntent,
  EconomicViolation,
  ExecutionPlan,
  Outcome,
  ProtocolCapabilityEngine,
  UsdValue,
} from "@acor/core";

export type AdapterStatus = "NOT_CONFIGURED" | "READY" | "DEGRADED" | "ERROR";

export interface AdapterHealth {
  readonly adapter: string;
  readonly status: AdapterStatus;
  /** What is missing or wrong, in words a developer can act on. */
  readonly detail: string;
  /** Capabilities this adapter probed, and what it found. */
  readonly capabilities: readonly { id: CapabilityId; state: string; note?: string }[];
  readonly checkedAt: Date;
}

/**
 * A balance, in the asset's own units.
 *
 * `amount` is an `AssetAmount`, never a dollar figure. A wallet holding 12 XRP
 * holds twelve XRP; what that is worth in dollars is a separate question with a
 * separate answer that may not exist. `usdValue` is populated only when the
 * asset has a registered peg or the caller supplied a price, and is `null`
 * otherwise — which the UI renders as an unknown, not as zero.
 */
export interface BalanceReading {
  readonly amount: AssetAmount;
  readonly address: string;
  readonly asOf: Date;
  readonly usdValue: UsdValue | null;
}

export interface SettlementRequest {
  readonly intent: EconomicIntent;
  readonly plan: ExecutionPlan;
  /** Idempotency key. Submitting twice with the same key must settle once. */
  readonly idempotencyKey: string;
}

export interface SettlementResult {
  readonly reference: string;
  readonly status: "SUBMITTED" | "CONFIRMED";
  /** What actually moved, in the settlement asset's own units. */
  readonly settledAmount: AssetAmount;
  /** What the rail charged, in the asset the fee was charged in. */
  readonly feePaid: AssetAmount;
  readonly submittedAt: Date;
}

export interface SettlementAdapter {
  readonly name: string;
  readonly networks: readonly string[];
  /** Report configuration and probe live capabilities. Never throws. */
  health(capabilities: ProtocolCapabilityEngine): Promise<AdapterHealth>;
  /**
   * Read balances. Returns a violation when not configured — never a zero.
   * `assets` are canonical asset ids; an adapter ignores ones it cannot serve.
   */
  balances(address: string, assets: readonly string[]): Promise<Outcome<readonly BalanceReading[]>>;
  /** Execute a settlement that has already passed the mandate and bounds checks. */
  settle(request: SettlementRequest): Promise<Outcome<SettlementResult>>;
}

export function notConfigured(adapter: string, missing: readonly string[]): AdapterHealth {
  return {
    adapter,
    status: "NOT_CONFIGURED",
    detail: `missing configuration: ${missing.join(", ")}`,
    capabilities: [],
    checkedAt: new Date(),
  };
}

export function configurationViolation(
  adapter: string,
  missing: readonly string[],
): EconomicViolation {
  return {
    code: "CAPABILITY_UNAVAILABLE",
    message: `${adapter} is not configured (missing ${missing.join(", ")})`,
    detail: { adapter, missing: missing.join(",") },
  };
}
