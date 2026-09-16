/**
 * Economic receipts.
 *
 * A receipt is the durable record that a piece of machine work happened and was
 * paid for: who bought, who provided, what was authorized, what was actually
 * settled, on which rail, and whether the result passed evaluation. Reputation
 * is derived from receipts, so receipts have to be immutable — a system that
 * lets you edit the record lets you edit your reputation.
 */

import { canonicalize, domainHash } from "../canonical/json";
import { fail, ok, violation, type EconomicViolation, type Outcome } from "../errors/index";
import { formatUsd, type Nanos } from "../units/money";

export type EvaluationResult = "PASS" | "FAIL" | "NOT_EVALUATED" | "DISPUTED";

export interface EconomicReceipt {
  readonly receiptId: string;
  readonly buyerAgentId: string;
  readonly providerAgentId: string;
  readonly intentId: string;
  readonly jobId: string | null;
  readonly service: string;
  /** What the provider quoted, in nanos. */
  readonly quotedPrice: Nanos;
  /** What actually moved, in nanos. */
  readonly finalPrice: Nanos;
  readonly network: string;
  readonly settlementRail: string;
  readonly settlementAsset: string;
  /** On-chain tx hash, x402 reference, or `muledger:<entryId>`. */
  readonly transactionReference: string;
  /** Hash of the delivered result, so the deliverable can be proven later. */
  readonly resultHash: string;
  readonly evaluator: string;
  readonly evaluationResult: EvaluationResult;
  readonly startedAt: Date;
  readonly completedAt: Date;
  /** Signed integer applied to the provider's reputation by this receipt. */
  readonly reputationEffect: number;
}

/** Canonical document for hashing. Dates become whole-second ISO strings. */
export function canonicalReceiptDocument(receipt: EconomicReceipt): Record<string, unknown> {
  return {
    buyerAgentId: receipt.buyerAgentId,
    completedAt: isoSeconds(receipt.completedAt),
    evaluationResult: receipt.evaluationResult,
    evaluator: receipt.evaluator,
    finalPrice: receipt.finalPrice,
    intentId: receipt.intentId,
    jobId: receipt.jobId,
    network: receipt.network,
    providerAgentId: receipt.providerAgentId,
    quotedPrice: receipt.quotedPrice,
    receiptId: receipt.receiptId,
    reputationEffect: receipt.reputationEffect,
    resultHash: receipt.resultHash,
    service: receipt.service,
    settlementAsset: receipt.settlementAsset,
    settlementRail: receipt.settlementRail,
    startedAt: isoSeconds(receipt.startedAt),
    transactionReference: receipt.transactionReference,
  };
}

function isoSeconds(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

export function receiptHash(receipt: EconomicReceipt): string {
  return domainHash("receipt.v1", canonicalReceiptDocument(receipt) as never);
}

export function receiptCanonicalForm(receipt: EconomicReceipt): string {
  return canonicalize(canonicalReceiptDocument(receipt) as never);
}

export interface ReceiptDraft extends Omit<EconomicReceipt, "receiptId" | "reputationEffect"> {
  readonly receiptId?: string;
  readonly reputationEffect?: number;
}

/**
 * Build a receipt from a completed settlement.
 *
 * `finalPrice` above `quotedPrice` is rejected here as well as at the bounds
 * check: a receipt is the last place a price mutation could hide, and it is the
 * document reputation is computed from.
 */
export function createReceipt(draft: ReceiptDraft): Outcome<EconomicReceipt> {
  const violations: EconomicViolation[] = [];

  if (draft.finalPrice < 0n) {
    violations.push(violation("INVALID_AMOUNT", "finalPrice must not be negative"));
  }
  if (draft.finalPrice > draft.quotedPrice) {
    violations.push(
      violation(
        "MAX_SPEND_EXCEEDED",
        `settled ${formatUsd(draft.finalPrice, { symbol: true })} against a quote of ${formatUsd(draft.quotedPrice, { symbol: true })}`,
        { quoted: draft.quotedPrice, final: draft.finalPrice },
      ),
    );
  }
  if (draft.completedAt.getTime() < draft.startedAt.getTime()) {
    violations.push(violation("INTENT_MALFORMED", "completedAt precedes startedAt"));
  }
  if (draft.evaluationResult === "PASS" && draft.resultHash.length === 0) {
    violations.push(
      violation("EVALUATION_MISSING", "a passing receipt must carry the hash of the result"),
    );
  }

  if (violations.length > 0) return fail(violations);

  const reputationEffect = draft.reputationEffect ?? defaultReputationEffect(draft.evaluationResult);
  const withoutId: EconomicReceipt = {
    ...draft,
    receiptId: "",
    reputationEffect,
  };
  const receiptId = draft.receiptId ?? `receipt_${receiptHash(withoutId).slice(2, 34)}`;
  return ok({ ...withoutId, receiptId });
}

function defaultReputationEffect(result: EvaluationResult): number {
  switch (result) {
    case "PASS":
      return 1;
    case "FAIL":
      return -3;
    case "DISPUTED":
      return -5;
    case "NOT_EVALUATED":
      return 0;
  }
}

/**
 * Immutability guard.
 *
 * Receipts are stored in an append-only table; this is the belt-and-braces
 * check for any code path that hands back a "corrected" receipt.
 */
export function assertReceiptUnchanged(
  previous: EconomicReceipt,
  next: EconomicReceipt,
): Outcome<true> {
  const before = receiptHash(previous);
  const after = receiptHash(next);
  if (before !== after) {
    return fail(
      violation("RECEIPT_IMMUTABLE", "receipts cannot be modified after issuance", {
        receiptId: previous.receiptId,
        before,
        after,
      }),
    );
  }
  return ok(true);
}

/** Settlement idempotency: one settlement reference, one receipt. */
export class ReceiptRegistry {
  private readonly byId = new Map<string, EconomicReceipt>();
  private readonly bySettlement = new Map<string, string>();

  record(receipt: EconomicReceipt): Outcome<EconomicReceipt> {
    const existing = this.byId.get(receipt.receiptId);
    if (existing) {
      const unchanged = assertReceiptUnchanged(existing, receipt);
      if (!unchanged.ok) return unchanged as Outcome<EconomicReceipt>;
      return ok(existing);
    }
    const settlementKey = `${receipt.network}:${receipt.transactionReference}`;
    const duplicate = this.bySettlement.get(settlementKey);
    if (duplicate && duplicate !== receipt.receiptId) {
      return fail(
        violation(
          "DUPLICATE_SETTLEMENT",
          `settlement ${settlementKey} already produced receipt ${duplicate}`,
          { settlementKey, existingReceiptId: duplicate },
        ),
      );
    }
    this.byId.set(receipt.receiptId, receipt);
    this.bySettlement.set(settlementKey, receipt.receiptId);
    return ok(receipt);
  }

  get(receiptId: string): EconomicReceipt | undefined {
    return this.byId.get(receiptId);
  }

  all(): readonly EconomicReceipt[] {
    return [...this.byId.values()];
  }
}
