/**
 * Jobs: creation, funding, and settlement.
 *
 * A job is escrowed, evaluated work — the ERC-8183-style lifecycle in
 * `@acor/core`'s `jobs/lifecycle.ts`. This module is where that state machine
 * meets real money: funding a job binds it to an already-accepted, signed
 * `EconomicIntent`, and settling one creates the μLedger obligation, the
 * immutable receipt, the transaction record that makes mandate spend limits
 * and Sentinel-5's anomaly sensors see it, and the reputation event.
 *
 * Every side effect of a transition happens in one database transaction: a
 * job that reads as SETTLED has a receipt, an intent that reads as CONSUMED
 * has a job, and there is no window where one exists without the other.
 *
 * A settlement also fires a `job.funded`/`job.settled` webhook once the
 * transaction has committed (see `lib/webhooks`) -- deliberately outside the
 * transaction, so a webhook can never fire for a transition that rolled back.
 *
 * Funding today is MULEDGER-only. A job priced in a live rail's currency and
 * funded by an Arc- or XRPL-settled intent is not implemented — see
 * docs/MULEDGER.md and the "not yet built" note in this module.
 */

import "server-only";

import {
  agents,
  and,
  economicIntents,
  economicReceipts,
  eq,
  fromNanosColumn,
  getDb,
  jobEvents,
  jobs,
  muledgerEntries,
  reputationEvents,
  toNanosColumn,
  transactions,
  type Database,
} from "@acor/db";
import {
  allowedTransitions,
  applyTransition,
  canTransition,
  canonicalAssetId,
  createReceipt,
  newId,
  receiptHash,
  type JobState,
  type JobTransition,
} from "@acor/core";

import { recordAudit } from "./platform";
import { dispatchWebhookEvent } from "./webhooks";

/** The μLedger accounting asset for a settlement-asset symbol. USD is the fallback. */
function muledgerAssetFor(symbol: string): { id: string; decimals: number } {
  const known = new Set(["USDC", "RLUSD"]);
  const mapped = known.has(symbol.toUpperCase()) ? symbol.toUpperCase() : "USD";
  return { id: canonicalAssetId("MULEDGER", mapped), decimals: 9 };
}

export interface CreateJobInput {
  readonly organizationId: string;
  readonly buyerAgentId: string;
  readonly providerAgentId: string;
  readonly title: string;
  readonly service: string;
  readonly priceUsd: string;
  readonly evaluator?: string;
  readonly requestPayload?: unknown;
}

export type JobResult =
  | { readonly ok: true; readonly jobId: string; readonly state: JobState }
  | { readonly ok: false; readonly error: string; readonly code?: string };

async function ownsAgent(db: Database, organizationId: string, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
    .limit(1);
  return rows.length > 0;
}

async function agentExists(db: Database, agentId: string): Promise<boolean> {
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return rows.length > 0;
}

/**
 * Create a job in DRAFT.
 *
 * The buyer agent must belong to the caller's organization — a job cannot be
 * created that would commit somebody else's agent to buy something. The
 * provider agent only needs to exist: this platform is a marketplace, and the
 * whole point is that buyer and provider are usually different organizations.
 */
export async function createJob(input: CreateJobInput): Promise<JobResult> {
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };

  if (!(await ownsAgent(db, input.organizationId, input.buyerAgentId))) {
    return { ok: false, error: "No such buyer agent in this organization.", code: "NOT_FOUND" };
  }
  if (!(await agentExists(db, input.providerAgentId))) {
    return { ok: false, error: "No such provider agent.", code: "NOT_FOUND" };
  }
  if (input.buyerAgentId === input.providerAgentId) {
    return { ok: false, error: "An agent cannot buy from itself.", code: "INVALID_INPUT" };
  }

  const priceParsed = /^\d+(\.\d{1,9})?$/.test(input.priceUsd.trim());
  if (!priceParsed) {
    return { ok: false, error: "priceUsd must be a non-negative decimal.", code: "INVALID_INPUT" };
  }
  const priceNanos = BigInt(Math.round(Number(input.priceUsd) * 1_000_000_000));

  const jobId = newId("job");
  try {
    await db.insert(jobs).values({
      id: jobId,
      organizationId: input.organizationId,
      buyerAgentId: input.buyerAgentId,
      providerAgentId: input.providerAgentId,
      title: input.title,
      service: input.service,
      requestPayload: (input.requestPayload ?? null) as never,
      state: "DRAFT",
      escrowNanos: toNanosColumn(priceNanos),
      evaluator: input.evaluator ?? null,
    });
    await db.insert(jobEvents).values({
      id: newId("evt"),
      jobId,
      fromState: null,
      toState: "DRAFT",
      transition: "CREATE",
      actor: "system",
      detail: { action: "created" } as never,
    });
  } catch (cause) {
    console.error("[jobs] could not create job:", cause);
    return { ok: false, error: "Could not create the job." };
  }

  return { ok: true, jobId, state: "DRAFT" };
}

export interface TransitionInput {
  readonly organizationId: string;
  readonly jobId: string;
  readonly transition: JobTransition;
  readonly actor: string;
  /** FUND only: the already-accepted intent that pays for this job. */
  readonly intentId?: string;
  /** SUBMIT only. */
  readonly resultHash?: string;
  readonly deliverableUri?: string;
}

/**
 * Which side of the job may call which transition.
 *
 * The buyer controls funding and cancellation (their money); the provider
 * controls starting and submitting (their work); either side may call
 * EVALUATE, PASS/REJECT is the evaluator's call in principle but is applied
 * here by whichever side requests it since no separate evaluator identity is
 * modelled yet (see docs/MULEDGER.md); settlement and disputes are open to
 * either side, since both have standing to want the job concluded.
 */
const BUYER_ONLY: ReadonlySet<JobTransition> = new Set(["FUND", "CANCEL"]);
const PROVIDER_ONLY: ReadonlySet<JobTransition> = new Set(["START", "SUBMIT"]);

async function transitionSide(
  db: Database,
  organizationId: string,
  job: { buyerAgentId: string; providerAgentId: string | null },
  transition: JobTransition,
): Promise<{ allowed: boolean; reason?: string }> {
  if (BUYER_ONLY.has(transition)) {
    const owns = await ownsAgent(db, organizationId, job.buyerAgentId);
    return owns ? { allowed: true } : { allowed: false, reason: "Only the buyer may do this." };
  }
  if (PROVIDER_ONLY.has(transition) && job.providerAgentId) {
    const owns = await ownsAgent(db, organizationId, job.providerAgentId);
    return owns ? { allowed: true } : { allowed: false, reason: "Only the provider may do this." };
  }
  // Everything else (QUOTE, EVALUATE, PASS, REJECT, DISPUTE, RESOLVE_*, SETTLE)
  // is open to either side of the job.
  const buyerOwns = await ownsAgent(db, organizationId, job.buyerAgentId);
  const providerOwns = job.providerAgentId
    ? await ownsAgent(db, organizationId, job.providerAgentId)
    : false;
  return buyerOwns || providerOwns
    ? { allowed: true }
    : { allowed: false, reason: "Neither party to this job." };
}

/** Apply one lifecycle transition, with whatever side effects it carries. */
export async function transitionJob(input: TransitionInput): Promise<JobResult> {
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };

  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, input.jobId), eq(jobs.organizationId, input.organizationId)))
    .limit(1);
  const job = rows[0];
  if (!job) return { ok: false, error: "No such job.", code: "NOT_FOUND" };

  const side = await transitionSide(db, input.organizationId, job, input.transition);
  if (!side.allowed) {
    return { ok: false, error: side.reason ?? "Not permitted.", code: "NOT_AUTHORIZED" };
  }

  const from = job.state as JobState;
  if (!canTransition(from, input.transition)) {
    return {
      ok: false,
      error: `Cannot ${input.transition} a job in state ${from}. Allowed: ${allowedTransitions(from).join(", ") || "none (terminal)"}.`,
      code: "ILLEGAL_JOB_TRANSITION",
    };
  }
  const next = applyTransition(from, input.transition);
  if (!next.ok) return { ok: false, error: next.violations[0]?.message ?? "Illegal transition." };
  const toState = next.value;

  type SideEffectFailure = { ok: false; error: string; code?: string };
  let sideEffectFailure: SideEffectFailure | null = null;

  try {
    await db.transaction(async (tx) => {
      if (input.transition === "FUND") {
        const result = await fundJob(tx, job, input.intentId);
        if (!result.ok) {
          sideEffectFailure = result;
          throw new Error("side effect refused");
        }
      } else if (input.transition === "SETTLE") {
        const result = await settleJob(tx, job, from);
        if (!result.ok) {
          sideEffectFailure = result;
          throw new Error("side effect refused");
        }
      }

      await tx
        .update(jobs)
        .set({
          state: toState,
          updatedAt: new Date(),
          ...(input.transition === "SUBMIT"
            ? {
                resultHash: input.resultHash ?? null,
                deliverableUri: input.deliverableUri ?? null,
              }
            : {}),
        })
        .where(eq(jobs.id, job.id));

      await tx.insert(jobEvents).values({
        id: newId("evt"),
        jobId: job.id,
        fromState: from,
        toState,
        transition: input.transition,
        actor: input.actor,
        detail: null,
      });
    });
  } catch (cause) {
    if (sideEffectFailure) return sideEffectFailure;
    console.error("[jobs] transition failed:", cause);
    return { ok: false, error: "Could not apply this transition." };
  }

  await recordAudit({
    organizationId: input.organizationId,
    actor: input.actor,
    action: `job.${input.transition.toLowerCase()}`,
    subject: job.id,
    outcome: "ALLOW",
    detail: { from, to: toState },
  });

  if (input.transition === "FUND" || input.transition === "SETTLE") {
    await dispatchWebhookEvent(
      input.organizationId,
      input.transition === "FUND" ? "job.funded" : "job.settled",
      { jobId: job.id, from, to: toState },
    );
  }

  return { ok: true, jobId: job.id, state: toState };
}

type JobRow = typeof jobs.$inferSelect;

/**
 * FUND: bind an already-accepted intent as this job's escrow.
 *
 * The intent must be OPEN (accepted by the relay, not yet consumed), name
 * this exact buyer and provider, settle on MULEDGER, and cover at least the
 * job's quoted price. It is consumed immediately: once a job is FUNDED the
 * lifecycle has no path back to DRAFT/QUOTED (see the state machine's own
 * comment on why), so the funds are committed for the life of this job.
 */
async function fundJob(
  db: Database,
  job: JobRow,
  intentId: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  if (!intentId) {
    return { ok: false, error: "FUND requires intentId: an already-accepted intent.", code: "INVALID_INPUT" };
  }
  const rows = await db
    .select()
    .from(economicIntents)
    .where(eq(economicIntents.id, intentId))
    .limit(1);
  const intent = rows[0];
  if (!intent) return { ok: false, error: "No such intent.", code: "NOT_FOUND" };
  if (intent.status !== "OPEN") {
    return { ok: false, error: `Intent is ${intent.status}, not OPEN.`, code: "INTENT_NOT_OPEN" };
  }
  if (intent.buyerAgentId !== job.buyerAgentId || intent.providerAgentId !== job.providerAgentId) {
    return {
      ok: false,
      error: "This intent does not authorize this buyer to pay this provider.",
      code: "INTENT_MISMATCH",
    };
  }
  if (intent.network !== "MULEDGER") {
    return {
      ok: false,
      error: "Only intents on MULEDGER can fund a job today.",
      code: "UNSUPPORTED_NETWORK",
    };
  }
  const authorizedNanos = intent.maxSpendAtomic
    ? fromNanosColumn(intent.maxSpendAtomic)
    : fromNanosColumn(intent.maxSpendNanos);
  const quotedNanos = fromNanosColumn(job.escrowNanos);
  if (authorizedNanos < quotedNanos) {
    return {
      ok: false,
      error: "This intent's maxSpend does not cover the job's quoted price.",
      code: "INSUFFICIENT_AUTHORIZATION",
    };
  }

  await db
    .update(economicIntents)
    .set({ status: "CONSUMED" })
    .where(and(eq(economicIntents.id, intentId), eq(economicIntents.status, "OPEN")));
  await db
    .update(jobs)
    .set({
      intentId,
      settlementAsset: intent.settlementAsset,
      network: intent.network,
    })
    .where(eq(jobs.id, job.id));

  return { ok: true };
}

/**
 * SETTLE: release (or, for a rejected job, decline to release) escrow.
 *
 * A job reaching SETTLED from COMPLETE pays the quoted price in full. One
 * reaching it from REJECTED pays nothing — evaluation failed, so no μLedger
 * obligation, no transaction, and no receipt claiming a positive settlement.
 * Either way a receipt is written, because "the buyer's money was
 * conclusively not owed" is exactly as much a durable record as "it was".
 */
async function settleJob(
  db: Database,
  job: JobRow,
  from: JobState,
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  const quotedNanos = fromNanosColumn(job.escrowNanos);
  const finalNanos = from === "COMPLETE" ? quotedNanos : 0n;
  const evaluationResult = from === "COMPLETE" ? "PASS" : "FAIL";

  if (!job.intentId) {
    return { ok: false, error: "This job was never funded.", code: "NOT_FUNDED" };
  }
  const intentRows = await db
    .select()
    .from(economicIntents)
    .where(eq(economicIntents.id, job.intentId))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) return { ok: false, error: "Funding intent no longer exists.", code: "NOT_FOUND" };

  const now = new Date();
  const asset = muledgerAssetFor(job.settlementAsset ?? "USD");
  const providerAgentId = job.providerAgentId as string;

  let entryId: string | null = null;
  if (finalNanos > 0n) {
    entryId = newId("entry");
    const idempotencyKey = `job:${job.id}:settle`;
    await db.insert(muledgerEntries).values({
      id: entryId,
      organizationId: job.organizationId,
      debtorAgentId: job.buyerAgentId,
      creditorAgentId: providerAgentId,
      amountNanos: toNanosColumn(finalNanos),
      amountAtomic: toNanosColumn(finalNanos),
      amountAssetId: asset.id,
      amountDecimals: asset.decimals,
      asset: job.settlementAsset ?? "USD",
      service: job.service,
      intentId: job.intentId,
      state: "OPEN",
      idempotencyKey,
    });
  }

  const receiptDraft = createReceipt({
    buyerAgentId: job.buyerAgentId,
    providerAgentId,
    intentId: job.intentId,
    jobId: job.id,
    service: job.service,
    quotedPrice: quotedNanos,
    finalPrice: finalNanos,
    network: intent.network,
    settlementRail: "MULEDGER",
    settlementAsset: job.settlementAsset ?? "USD",
    transactionReference: entryId ? `muledger:${entryId}` : `job:${job.id}:no-settlement`,
    resultHash: job.resultHash ?? "",
    evaluator: job.evaluator ?? "none",
    evaluationResult,
    startedAt: job.createdAt,
    completedAt: now,
  });
  if (!receiptDraft.ok) {
    return {
      ok: false,
      error: receiptDraft.violations[0]?.message ?? "Could not build the receipt.",
      code: "RECEIPT_INVALID",
    };
  }
  const receipt = receiptDraft.value;

  await db.insert(economicReceipts).values({
    id: newId("receipt"),
    organizationId: job.organizationId,
    receiptHash: receiptHash(receipt),
    buyerAgentId: receipt.buyerAgentId,
    providerAgentId: receipt.providerAgentId,
    intentId: receipt.intentId,
    jobId: receipt.jobId,
    service: receipt.service,
    quotedPriceNanos: toNanosColumn(receipt.quotedPrice),
    finalPriceNanos: toNanosColumn(receipt.finalPrice),
    quotedPriceAtomic: toNanosColumn(receipt.quotedPrice),
    quotedPriceAssetId: asset.id,
    quotedPriceDecimals: asset.decimals,
    finalPriceAtomic: toNanosColumn(receipt.finalPrice),
    finalPriceAssetId: asset.id,
    finalPriceDecimals: asset.decimals,
    finalPriceUsdNanos: toNanosColumn(receipt.finalPrice),
    finalPriceUsdSource: "PEG",
    finalPriceUsdAsOf: now,
    network: receipt.network,
    settlementRail: receipt.settlementRail,
    settlementAsset: receipt.settlementAsset,
    transactionReference: receipt.transactionReference,
    resultHash: receipt.resultHash,
    evaluator: receipt.evaluator,
    evaluationResult: receipt.evaluationResult,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    reputationEffect: receipt.reputationEffect,
  });

  // Every mandate spend limit and every Sentinel-5 anomaly sensor reads this
  // table. A settlement that never wrote to it would be invisible to both.
  if (finalNanos > 0n) {
    await db.insert(transactions).values({
      id: newId("tx"),
      organizationId: job.organizationId,
      agentId: job.buyerAgentId,
      intentId: job.intentId,
      direction: "OUT",
      amountNanos: toNanosColumn(finalNanos),
      amountAtomic: toNanosColumn(finalNanos),
      amountAssetId: asset.id,
      amountDecimals: asset.decimals,
      amountUsdNanos: toNanosColumn(finalNanos),
      amountUsdSource: "PEG",
      amountUsdAsOf: now,
      asset: job.settlementAsset ?? "USD",
      network: receipt.network,
      rail: "MULEDGER",
      counterparty: providerAgentId,
      reference: entryId ? `muledger:${entryId}` : `job:${job.id}`,
      status: "CONFIRMED",
    });
  }

  await db.insert(reputationEvents).values({
    id: newId("evt"),
    agentId: providerAgentId,
    counterpartyAgentId: job.buyerAgentId,
    kind: evaluationResult === "PASS" ? "JOB_COMPLETED" : "JOB_FAILED",
    valueNanos: toNanosColumn(finalNanos),
    valueUsdSource: "PEG",
    valueUsdAsOf: now,
    receiptId: null,
    occurredAt: now,
  });

  return { ok: true };
}
