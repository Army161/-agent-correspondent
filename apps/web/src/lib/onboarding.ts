/**
 * Onboarding, server side.
 *
 * The state machine itself lives in `@acor/core` and is pure. This module's
 * only job is to gather the facts it needs from the database and to record the
 * two answers that have nowhere else to live.
 *
 * Every read and write here is scoped to the organization on the verified
 * session. An organization id is never accepted from a request.
 */

import "server-only";

import {
  agents,
  and,
  count,
  eq,
  getDb,
  ne,
  onboardingProgress,
  organizations,
} from "@acor/db";
import {
  economicReadiness,
  isOrganizationNamed,
  newId,
  onboardingState,
  type EconomicReadiness,
  type OnboardingFacts,
  type OnboardingState,
} from "@acor/core";

import { emailConfigured } from "./email";
import { isProduction } from "./env";
import type { SessionUser } from "./auth";

/**
 * Whether this deployment requires a confirmed address before economic actions.
 *
 * On in production, and not switchable by a user or a request. A production
 * deployment with no mail provider therefore authorizes no economic actions,
 * which is the correct failure: an account nobody can verify is an account
 * nobody can attribute.
 */
export function requiresVerifiedEmail(): boolean {
  return isProduction();
}

export interface OnboardingView {
  readonly state: OnboardingState;
  readonly facts: OnboardingFacts;
  readonly readiness: EconomicReadiness;
  readonly purpose: string | null;
  readonly selectedPlanId: string | null;
  readonly organizationName: string;
}

/** Gather the facts and compute the state. Never throws. */
export async function onboardingFor(user: SessionUser): Promise<OnboardingView> {
  const db = getDb();

  const base = {
    emailVerified: user.emailVerified,
    emailDeliveryConfigured: emailConfigured(),
    organizationNamed: isOrganizationNamed(user.organizationName),
    purposeRecorded: false,
    planSelected: false,
    agentCount: 0,
    dismissedAt: null,
  } satisfies OnboardingFacts;

  if (!db) {
    return {
      state: onboardingState(base),
      facts: base,
      readiness: economicReadiness(base, { requireVerifiedEmail: requiresVerifiedEmail() }),
      purpose: null,
      selectedPlanId: null,
      organizationName: user.organizationName,
    };
  }

  try {
    const [progressRows, agentRows] = await Promise.all([
      db
        .select()
        .from(onboardingProgress)
        .where(eq(onboardingProgress.organizationId, user.organizationId))
        .limit(1),
      db
        .select({ total: count() })
        .from(agents)
        .where(and(eq(agents.organizationId, user.organizationId), ne(agents.status, "DISABLED"))),
    ]);

    const progress = progressRows[0] ?? null;
    const facts: OnboardingFacts = {
      ...base,
      purposeRecorded: progress?.purposeRecordedAt !== null && progress?.purposeRecordedAt !== undefined,
      planSelected: progress?.planSelectedAt !== null && progress?.planSelectedAt !== undefined,
      agentCount: Number(agentRows[0]?.total ?? 0),
      dismissedAt: progress?.dismissedAt ?? null,
    };

    return {
      state: onboardingState(facts),
      facts,
      readiness: economicReadiness(facts, { requireVerifiedEmail: requiresVerifiedEmail() }),
      purpose: progress?.purpose ?? null,
      selectedPlanId: progress?.selectedPlanId ?? null,
      organizationName: user.organizationName,
    };
  } catch {
    return {
      state: onboardingState(base),
      facts: base,
      readiness: economicReadiness(base, { requireVerifiedEmail: requiresVerifiedEmail() }),
      purpose: null,
      selectedPlanId: null,
      organizationName: user.organizationName,
    };
  }
}

type ProgressPatch = Partial<{
  purpose: string | null;
  purposeRecordedAt: Date | null;
  selectedPlanId: string | null;
  planSelectedAt: Date | null;
  dismissedAt: Date | null;
  completedAt: Date | null;
}>;

/** Upsert the recorded answers for one organization. */
async function recordProgress(organizationId: string, patch: ProgressPatch): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const now = new Date();
  try {
    await db
      .insert(onboardingProgress)
      .values({
        id: newId("onb"),
        organizationId,
        purpose: patch.purpose ?? null,
        purposeRecordedAt: patch.purposeRecordedAt ?? null,
        selectedPlanId: patch.selectedPlanId ?? null,
        planSelectedAt: patch.planSelectedAt ?? null,
        dismissedAt: patch.dismissedAt ?? null,
        completedAt: patch.completedAt ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: onboardingProgress.organizationId,
        set: { ...patch, updatedAt: now },
      });
    return true;
  } catch {
    return false;
  }
}

const MAX_PURPOSE = 500;
const MAX_ORGANIZATION_NAME = 120;

export async function recordPurpose(
  organizationId: string,
  purpose: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = purpose.trim();
  if (trimmed.length === 0) return { ok: false, error: "Write a sentence, or skip this step." };
  if (trimmed.length > MAX_PURPOSE) {
    return { ok: false, error: `Keep it under ${MAX_PURPOSE} characters.` };
  }
  const written = await recordProgress(organizationId, {
    purpose: trimmed,
    purposeRecordedAt: new Date(),
  });
  return written ? { ok: true } : { ok: false, error: "Could not save that. Try again." };
}

export async function recordPlanChoice(
  organizationId: string,
  planId: string,
): Promise<{ ok: boolean; error?: string }> {
  const written = await recordProgress(organizationId, {
    selectedPlanId: planId,
    planSelectedAt: new Date(),
  });
  return written ? { ok: true } : { ok: false, error: "Could not save that. Try again." };
}

export async function dismissOnboarding(organizationId: string): Promise<void> {
  await recordProgress(organizationId, { dismissedAt: new Date() });
}

/**
 * Rename the organization.
 *
 * The slug is left alone: it is referenced by existing rows and by any link
 * already shared, and renaming is a display change, not an identity change.
 */
export async function renameOrganization(
  organizationId: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = name.trim();
  if (trimmed.length < 2) return { ok: false, error: "Use at least two characters." };
  if (trimmed.length > MAX_ORGANIZATION_NAME) {
    return { ok: false, error: `Keep it under ${MAX_ORGANIZATION_NAME} characters.` };
  }
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };
  try {
    await db
      .update(organizations)
      .set({ name: trimmed })
      .where(eq(organizations.id, organizationId));
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save that. Try again." };
  }
}
