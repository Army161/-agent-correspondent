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
  CapabilityId,
  EconomicIntent,
  EconomicViolation,
  ExecutionPlan,
  Nanos,
  Outcome,
  ProtocolCapabilityEngine,
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

export interface BalanceReading {
  readonly asset: string;
  readonly network: string;
  readonly address: string;
  readonly amount: Nanos;
  readonly asOf: Date;
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
  readonly settledAmount: Nanos;
  readonly feePaid: Nanos;
  readonly submittedAt: Date;
}

export interface SettlementAdapter {
  readonly name: string;
  readonly networks: readonly string[];
  /** Report configuration and probe live capabilities. Never throws. */
  health(capabilities: ProtocolCapabilityEngine): Promise<AdapterHealth>;
  /** Read balances. Returns a violation when not configured — never a zero. */
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
