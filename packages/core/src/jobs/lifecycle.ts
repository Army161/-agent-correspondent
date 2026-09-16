/**
 * ERC-8183-style job lifecycle (PRODUCT_SPEC §15).
 *
 * Escrowed, evaluated work has a state machine, and the state machine is
 * enforced in code rather than implied by which button the UI renders. An
 * illegal transition — settling a job that was never funded, completing one
 * that was never submitted — is refused here, once, for every caller.
 *
 * This is for conditional and asynchronous work. A sub-cent synchronous API
 * call has no business creating an on-chain job; the router sends those to a
 * nanopayment rail or the mu-ledger.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";

export type JobState =
  | "DRAFT"
  | "QUOTED"
  | "FUNDED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "EVALUATING"
  | "COMPLETE"
  | "REJECTED"
  | "DISPUTED"
  | "SETTLED"
  | "CANCELLED";

export type JobTransition =
  | "QUOTE"
  | "FUND"
  | "START"
  | "SUBMIT"
  | "EVALUATE"
  | "PASS"
  | "REJECT"
  | "DISPUTE"
  | "RESOLVE_FOR_PROVIDER"
  | "RESOLVE_FOR_BUYER"
  | "SETTLE"
  | "CANCEL";

const TRANSITIONS: Readonly<Record<JobState, Partial<Record<JobTransition, JobState>>>> =
  Object.freeze({
    DRAFT: { QUOTE: "QUOTED", CANCEL: "CANCELLED" },
    QUOTED: { FUND: "FUNDED", CANCEL: "CANCELLED" },
    // Once funds are escrowed the buyer can no longer unilaterally cancel:
    // the provider may already be working. Exit is via dispute.
    FUNDED: { START: "IN_PROGRESS", DISPUTE: "DISPUTED" },
    IN_PROGRESS: { SUBMIT: "SUBMITTED", DISPUTE: "DISPUTED" },
    SUBMITTED: { EVALUATE: "EVALUATING", DISPUTE: "DISPUTED" },
    EVALUATING: { PASS: "COMPLETE", REJECT: "REJECTED", DISPUTE: "DISPUTED" },
    COMPLETE: { SETTLE: "SETTLED", DISPUTE: "DISPUTED" },
    REJECTED: { DISPUTE: "DISPUTED", SETTLE: "SETTLED" },
    DISPUTED: { RESOLVE_FOR_PROVIDER: "COMPLETE", RESOLVE_FOR_BUYER: "REJECTED" },
    // Terminal.
    SETTLED: {},
    CANCELLED: {},
  });

export function canTransition(from: JobState, transition: JobTransition): boolean {
  return TRANSITIONS[from][transition] !== undefined;
}

export function applyTransition(from: JobState, transition: JobTransition): Outcome<JobState> {
  const next = TRANSITIONS[from][transition];
  if (!next) {
    return fail(
      violation("ILLEGAL_JOB_TRANSITION", `cannot ${transition} a job in state ${from}`, {
        from,
        transition,
        allowed: Object.keys(TRANSITIONS[from]).join(",") || "none (terminal state)",
      }),
    );
  }
  return ok(next);
}

export function allowedTransitions(from: JobState): readonly JobTransition[] {
  return Object.keys(TRANSITIONS[from]) as JobTransition[];
}

export function isTerminal(state: JobState): boolean {
  return allowedTransitions(state).length === 0;
}

/** Escrow must be funded before work begins, and released only once. */
export const FUNDED_STATES: readonly JobState[] = [
  "FUNDED",
  "IN_PROGRESS",
  "SUBMITTED",
  "EVALUATING",
  "COMPLETE",
  "REJECTED",
  "DISPUTED",
];

export function requiresEscrow(state: JobState): boolean {
  return FUNDED_STATES.includes(state);
}
