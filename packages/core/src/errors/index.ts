/**
 * Deterministic, typed failures for every economic decision path.
 *
 * Economic code in Agent Correspondent never throws bare `Error` for an
 * expected condition: an expected condition is a *decision*, and decisions are
 * data. Throwing is reserved for programmer error (bad wiring, impossible
 * state), which should crash loudly in tests.
 */

export type EconomicErrorCode =
  // money / encoding
  | "INVALID_AMOUNT"
  | "PRECISION_LOSS"
  | "UNKNOWN_ASSET"
  | "UNKNOWN_NETWORK"
  | "ASSET_MISMATCH"
  // valuation
  | "VALUATION_UNAVAILABLE"
  | "VALUATION_STALE"
  // mandate
  | "ASSET_NOT_ALLOWED"
  | "NETWORK_NOT_ALLOWED"
  | "MAX_TRANSACTION_EXCEEDED"
  | "DAILY_LIMIT_EXCEEDED"
  | "MINIMUM_RESERVE_BREACHED"
  | "UNVERIFIED_COUNTERPARTY_LIMIT"
  | "CREDIT_NOT_ALLOWED"
  | "TOKEN_TRADING_NOT_ALLOWED"
  | "HUMAN_APPROVAL_REQUIRED"
  | "MANDATE_MISSING"
  | "CONTEXT_INCOMPLETE"
  // intent / relay
  | "INTENT_MALFORMED"
  | "INTENT_EXPIRED"
  | "DEADLINE_AFTER_EXPIRY"
  | "NONCE_REUSED"
  | "SIGNATURE_INVALID"
  | "SIGNER_MISMATCH"
  | "DOMAIN_MISMATCH"
  | "CHAIN_MISMATCH"
  | "CONTRACT_MISMATCH"
  | "PROVIDER_UNAVAILABLE"
  | "QUOTE_STALE"
  // execution bounds
  | "MAX_SPEND_EXCEEDED"
  | "MIN_RECEIVE_NOT_MET"
  | "MAX_FEE_EXCEEDED"
  | "MAX_NETWORK_FEE_EXCEEDED"
  | "FX_SLIPPAGE_EXCEEDED"
  | "ASSET_SUBSTITUTION"
  | "NETWORK_SUBSTITUTION"
  | "DESTINATION_SUBSTITUTION"
  | "AUTHORIZATION_EXPIRED"
  // settlement / ledger
  | "DUPLICATE_SETTLEMENT"
  | "DUPLICATE_LEDGER_ENTRY"
  | "LEDGER_ENTRY_IMMUTABLE"
  | "RECEIPT_IMMUTABLE"
  | "EVALUATOR_UNTRUSTED"
  | "EVALUATION_MISSING"
  // capability
  | "CAPABILITY_UNAVAILABLE"
  | "CAPABILITY_UNKNOWN"
  | "CAPABILITY_TESTNET_ONLY"
  // routing / procurement
  | "NO_ELIGIBLE_ROUTE"
  | "NO_ELIGIBLE_PROVIDER"
  | "AUCTION_COMMIT_MISMATCH"
  // job lifecycle
  | "ILLEGAL_JOB_TRANSITION";

export interface EconomicViolation {
  readonly code: EconomicErrorCode;
  readonly message: string;
  /** Machine-readable context. Values are strings so violations stay canonical-hashable. */
  readonly detail?: Readonly<Record<string, string>>;
}

export function violation(
  code: EconomicErrorCode,
  message: string,
  detail?: Record<string, string | number | bigint | boolean | undefined>,
): EconomicViolation {
  if (!detail) return { code, message };
  const flat: Record<string, string> = {};
  for (const key of Object.keys(detail).sort()) {
    const value = detail[key];
    if (value === undefined) continue;
    flat[key] = typeof value === "string" ? value : String(value);
  }
  return { code, message, detail: flat };
}

/** Result type used across the kernel. Never throws for expected failure. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violations: readonly EconomicViolation[] };

export function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function fail<T>(
  violations: EconomicViolation | readonly EconomicViolation[],
): Outcome<T> {
  return {
    ok: false,
    violations: Array.isArray(violations)
      ? (violations as readonly EconomicViolation[])
      : [violations as EconomicViolation],
  };
}

/** Programmer error. Unlike violations, these are bugs and should be loud. */
export class KernelInvariantError extends Error {
  constructor(message: string) {
    super(`kernel invariant violated: ${message}`);
    this.name = "KernelInvariantError";
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new KernelInvariantError(message);
}

export function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw new KernelInvariantError(
    `unwrap() on failed outcome: ${outcome.violations.map((v) => v.code).join(", ")}`,
  );
}
