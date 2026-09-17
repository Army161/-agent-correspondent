/**
 * Identity verification, as a policy rather than a provider.
 *
 * The product needs to answer one question — "is this account allowed to do
 * this?" — without that answer depending on which vendor happens to be wired
 * up. So the levels, the statuses and the gate are here, deterministic and
 * testable, and the vendor lives behind an adapter.
 *
 * Two rules shape the whole design:
 *
 *  - **No raw documents.** This system stores a level, a status, a provider
 *    reference and a digest. A passport scan is the most damaging thing a
 *    breach could hand over, and the way to not lose it is to never hold it.
 *  - **Fail closed.** Unknown, stale and unreadable all deny. A verification
 *    system that approves when it cannot tell is worse than none, because it
 *    is trusted.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";

/**
 * What has been established about who is behind an account.
 *
 * Ordered: each level implies the ones before it.
 */
export type VerificationLevel =
  /** Nothing beyond an email address that received a link. */
  | "NONE"
  /** A natural person's identity, checked against a document. */
  | "INDIVIDUAL"
  /** A legal entity, its registration, and a beneficial owner. */
  | "BUSINESS";

const ORDER: readonly VerificationLevel[] = ["NONE", "INDIVIDUAL", "BUSINESS"];

export type VerificationStatus =
  | "NOT_STARTED"
  | "PENDING"
  /** The provider is reviewing. Not an approval. */
  | "IN_REVIEW"
  | "APPROVED"
  | "REJECTED"
  /** Approved once, but the approval has aged out of its validity window. */
  | "EXPIRED";

export interface VerificationRecord {
  readonly level: VerificationLevel;
  readonly status: VerificationStatus;
  /** When the provider decided, if it has. */
  readonly decidedAt: Date | null;
  /** When this approval stops counting. Null means it does not expire. */
  readonly expiresAt: Date | null;
  /** Which adapter produced this. Never a claim from a browser. */
  readonly provider: string;
}

export interface VerificationRequirement {
  readonly level: VerificationLevel;
  /** Why this action needs it, phrased for the person who hit the gate. */
  readonly because: string;
}

export interface VerificationDecision {
  readonly allowed: boolean;
  /** The level actually held, after expiry is applied. */
  readonly effectiveLevel: VerificationLevel;
  readonly status: VerificationStatus;
  /** What the account must do next, when it is not allowed. */
  readonly remedy: string | null;
}

function rank(level: VerificationLevel): number {
  return ORDER.indexOf(level);
}

/** Whether `held` is at least `required`. */
export function meetsLevel(held: VerificationLevel, required: VerificationLevel): boolean {
  return rank(held) >= rank(required);
}

/**
 * The level an account effectively holds right now.
 *
 * An approval that has passed its expiry is not an approval. The record is not
 * rewritten — the caller may still want to see that it was once approved — but
 * the level it confers is `NONE`.
 */
export function effectiveLevel(record: VerificationRecord, now: Date): VerificationLevel {
  if (record.status !== "APPROVED") return "NONE";
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) return "NONE";
  return record.level;
}

/**
 * Decide whether an account may proceed.
 *
 * `record` being null means nothing is on file, which is a denial, not an
 * error: an account that has never been verified simply has not been.
 */
export function verificationGate(
  record: VerificationRecord | null,
  requirement: VerificationRequirement,
  now: Date,
): VerificationDecision {
  if (requirement.level === "NONE") {
    return {
      allowed: true,
      effectiveLevel: record ? effectiveLevel(record, now) : "NONE",
      status: record?.status ?? "NOT_STARTED",
      remedy: null,
    };
  }

  if (!record) {
    return {
      allowed: false,
      effectiveLevel: "NONE",
      status: "NOT_STARTED",
      remedy: `${requirement.because} Start verification to continue.`,
    };
  }

  const held = effectiveLevel(record, now);
  if (meetsLevel(held, requirement.level)) {
    return { allowed: true, effectiveLevel: held, status: record.status, remedy: null };
  }

  const remedy =
    record.status === "PENDING" || record.status === "IN_REVIEW"
      ? `${requirement.because} Verification is still in progress.`
      : record.status === "REJECTED"
        ? `${requirement.because} The last verification attempt was not approved.`
        : record.status === "EXPIRED" ||
            (record.status === "APPROVED" && held === "NONE")
          ? `${requirement.because} The previous approval has expired and must be renewed.`
          : `${requirement.because} Start verification to continue.`;

  return { allowed: false, effectiveLevel: held, status: record.status, remedy };
}

/**
 * The evidence digest stored alongside a decision.
 *
 * A hash of what the provider told us, so a later dispute can establish that
 * the record was not altered — without this system ever holding the document
 * it summarises.
 */
export interface VerificationEvidence {
  readonly provider: string;
  readonly providerReference: string;
  readonly digest: string;
}

/** A digest must look like one. Anything else is probably a document by mistake. */
export function checkEvidence(evidence: VerificationEvidence): Outcome<VerificationEvidence> {
  if (!/^[0-9a-f]{64}$/i.test(evidence.digest)) {
    return fail(
      violation(
        "CHALLENGE_MALFORMED",
        "evidence digest must be a 64-character hex SHA-256; this system stores digests, never documents",
      ),
    );
  }
  if (evidence.providerReference.trim().length === 0) {
    return fail(violation("CHALLENGE_MALFORMED", "a decision must name the provider's reference"));
  }
  return ok(evidence);
}

/** The requirements this product enforces. Each names what it is protecting. */
export const REQUIREMENTS = {
  /** Reading, building agents, μLedger obligations: nothing external moves. */
  NONE: { level: "NONE", because: "" },
  /** Anything that can move value on a public network. */
  LIVE_SETTLEMENT: {
    level: "INDIVIDUAL",
    because: "Moving value on a live network requires a verified identity.",
  },
  /** Acting for a company, and any entity-level limit. */
  ORGANIZATION_CONTROLS: {
    level: "BUSINESS",
    because: "Acting on behalf of a legal entity requires that entity to be verified.",
  },
} as const satisfies Record<string, VerificationRequirement>;
