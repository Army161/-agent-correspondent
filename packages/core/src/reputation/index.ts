/**
 * Portable economic reputation (PRODUCT_SPEC §14).
 *
 * Reputation here is *derived*, never asserted. It is computed from settled
 * receipts and evaluator verdicts, so it cannot be inflated by claiming it.
 * ERC-8004 feedback is an input the platform reads and never rewrites; this
 * module builds the higher-level score on top of it.
 *
 * The properties that matter:
 *  - paid value counts more than job count, so a thousand free jobs do not
 *    outweigh real economic trust
 *  - counterparty diversity counts, so an agent cannot farm a score against
 *    itself through one collaborator
 *  - failures and disputes decay slowly; a good history does not erase a
 *    recent dispute
 */

import { absNanos, formatUsd, type Nanos } from "../units/money";

export type ReputationEventKind =
  | "JOB_COMPLETED"
  | "JOB_FAILED"
  | "JOB_DISPUTED"
  | "EVALUATION_PASSED"
  | "EVALUATION_FAILED"
  | "SETTLEMENT_COMPLETED"
  | "SETTLEMENT_FAILED"
  | "REPEAT_CUSTOMER";

export interface ReputationEvent {
  readonly eventId: string;
  readonly agentId: string;
  readonly counterpartyAgentId: string;
  readonly kind: ReputationEventKind;
  /** Settled value associated with this event, in nanos. */
  readonly value: Nanos;
  readonly occurredAt: Date;
  readonly receiptId: string | null;
}

export interface ReputationSnapshot {
  readonly agentId: string;
  /** 0-100. `null` when there is no history at all — never a default of 50. */
  readonly score: number | null;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly disputes: number;
  readonly settledValue: Nanos;
  readonly distinctCounterparties: number;
  readonly repeatCustomers: number;
  readonly successRate: number | null;
  readonly computedAt: Date;
  /** Every input that produced the score, for the reputation tab. */
  readonly evidence: readonly { factor: string; contribution: number; detail: string }[];
}

const WEIGHTS = {
  /** Maximum points from raw success rate. */
  successRate: 55,
  /** Maximum points from settled economic value. */
  settledValue: 20,
  /** Maximum points from counterparty diversity. */
  diversity: 15,
  /** Maximum points from repeat business. */
  repeat: 10,
  /** Points removed per dispute. */
  disputePenalty: 12,
} as const;

/** Half-life in days for weighting recent behaviour above old behaviour. */
const HALF_LIFE_DAYS = 90;

function recencyWeight(event: ReputationEvent, now: Date): number {
  const ageDays = (now.getTime() - event.occurredAt.getTime()) / 86_400_000;
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

export function computeReputation(
  agentId: string,
  events: readonly ReputationEvent[],
  now: Date = new Date(),
): ReputationSnapshot {
  const mine = events.filter((event) => event.agentId === agentId);

  if (mine.length === 0) {
    return {
      agentId,
      score: null,
      completedJobs: 0,
      failedJobs: 0,
      disputes: 0,
      settledValue: 0n,
      distinctCounterparties: 0,
      repeatCustomers: 0,
      successRate: null,
      computedAt: now,
      evidence: [],
    };
  }

  let weightedSuccess = 0;
  let weightedTotal = 0;
  let completedJobs = 0;
  let failedJobs = 0;
  let disputes = 0;
  let settledValue = 0n;
  const counterpartyJobs = new Map<string, number>();

  for (const event of mine) {
    const weight = recencyWeight(event, now);
    switch (event.kind) {
      case "JOB_COMPLETED":
      case "EVALUATION_PASSED":
      case "SETTLEMENT_COMPLETED":
        completedJobs += event.kind === "JOB_COMPLETED" ? 1 : 0;
        weightedSuccess += weight;
        weightedTotal += weight;
        settledValue += absNanos(event.value);
        break;
      case "JOB_FAILED":
      case "EVALUATION_FAILED":
      case "SETTLEMENT_FAILED":
        failedJobs += event.kind === "JOB_FAILED" ? 1 : 0;
        weightedTotal += weight;
        break;
      case "JOB_DISPUTED":
        disputes += 1;
        weightedTotal += weight;
        break;
      case "REPEAT_CUSTOMER":
        break;
    }
    if (event.kind === "JOB_COMPLETED") {
      counterpartyJobs.set(
        event.counterpartyAgentId,
        (counterpartyJobs.get(event.counterpartyAgentId) ?? 0) + 1,
      );
    }
  }

  const successRate = weightedTotal > 0 ? weightedSuccess / weightedTotal : null;
  const distinctCounterparties = counterpartyJobs.size;
  const repeatCustomers = [...counterpartyJobs.values()].filter((count) => count > 1).length;

  const evidence: { factor: string; contribution: number; detail: string }[] = [];

  const successPoints = successRate === null ? 0 : successRate * WEIGHTS.successRate;
  evidence.push({
    factor: "success rate",
    contribution: successPoints,
    detail: successRate === null ? "no outcomes yet" : `${(successRate * 100).toFixed(1)}% (recency weighted)`,
  });

  // Value contribution is logarithmic: the difference between $0 and $10 of
  // settled work says far more than the difference between $10k and $10.01k.
  const valueUsd = Number(settledValue / 1_000_000n) / 1000;
  const valuePoints = Math.min(WEIGHTS.settledValue, Math.log10(1 + valueUsd) * 8);
  evidence.push({
    factor: "settled value",
    contribution: valuePoints,
    detail: formatUsd(settledValue, { symbol: true }),
  });

  const diversityPoints = Math.min(WEIGHTS.diversity, Math.log2(1 + distinctCounterparties) * 5);
  evidence.push({
    factor: "counterparty diversity",
    contribution: diversityPoints,
    detail: `${distinctCounterparties} distinct counterparties`,
  });

  const repeatPoints = Math.min(WEIGHTS.repeat, repeatCustomers * 2.5);
  evidence.push({
    factor: "repeat customers",
    contribution: repeatPoints,
    detail: `${repeatCustomers} counterparties returned`,
  });

  const disputePenalty = -Math.min(60, disputes * WEIGHTS.disputePenalty);
  if (disputes > 0) {
    evidence.push({
      factor: "disputes",
      contribution: disputePenalty,
      detail: `${disputes} disputed job${disputes === 1 ? "" : "s"}`,
    });
  }

  const raw = successPoints + valuePoints + diversityPoints + repeatPoints + disputePenalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    agentId,
    score,
    completedJobs,
    failedJobs,
    disputes,
    settledValue,
    distinctCounterparties,
    repeatCustomers,
    successRate,
    computedAt: now,
    evidence,
  };
}
