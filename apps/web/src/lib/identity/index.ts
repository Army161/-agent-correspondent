/**
 * Identity verification, server side.
 *
 * The policy is in `@acor/core`. What is here is the storage, the gate the API
 * calls, and the provider seam.
 *
 * The seam is deliberately narrow: a provider can start a case and report a
 * decision, and nothing else. In particular there is no path by which a request
 * body sets a verification status. A client that could post its own KYC state
 * would make every gate downstream decorative.
 */

import "server-only";

import {
  eq,
  getDb,
  identityVerifications,
} from "@acor/db";
import {
  REQUIREMENTS,
  verificationGate,
  type VerificationDecision,
  type VerificationLevel,
  type VerificationRecord,
  type VerificationRequirement,
  type VerificationStatus,
} from "@acor/core";

export interface ProviderState {
  readonly id: string;
  readonly configured: boolean;
  readonly requires: readonly string[];
}

/**
 * Which verification provider this deployment can actually use.
 *
 * None is configured here. That is reported rather than worked around: there is
 * no "manual approval" path, because a manual approval path is the thing an
 * attacker with a database connection reaches for first.
 */
export function verificationProvider(): ProviderState {
  const key = process.env.KYC_PROVIDER_API_KEY?.trim();
  const id = process.env.KYC_PROVIDER?.trim();
  return {
    id: id && id.length > 0 ? id : "none",
    configured: Boolean(id && key),
    requires: ["KYC_PROVIDER", "KYC_PROVIDER_API_KEY", "KYC_PROVIDER_WEBHOOK_SECRET"],
  };
}

/** The verification on file for an organization, or null. Never throws. */
export async function verificationFor(
  organizationId: string,
): Promise<VerificationRecord | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(identityVerifications)
      .where(eq(identityVerifications.organizationId, organizationId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      level: row.level as VerificationLevel,
      status: row.status as VerificationStatus,
      decidedAt: row.decidedAt,
      expiresAt: row.expiresAt,
      provider: row.provider,
    };
  } catch {
    // An unreadable record is not an approved one.
    return null;
  }
}

export type RequirementName = keyof typeof REQUIREMENTS;

/**
 * Whether an organization may take an action that needs verification.
 *
 * Fail-closed at every step: no database, no record, an unreadable record, an
 * expired approval — each denies.
 */
export async function requireVerification(
  organizationId: string,
  requirement: RequirementName | VerificationRequirement,
  now: Date = new Date(),
): Promise<VerificationDecision> {
  const target: VerificationRequirement =
    typeof requirement === "string" ? REQUIREMENTS[requirement] : requirement;
  const record = await verificationFor(organizationId);
  const decision = verificationGate(record, target, now);

  if (!decision.allowed && !verificationProvider().configured && target.level !== "NONE") {
    return {
      ...decision,
      remedy: `${target.because} No verification provider is configured on this deployment, so this cannot be completed here.`,
    };
  }
  return decision;
}
