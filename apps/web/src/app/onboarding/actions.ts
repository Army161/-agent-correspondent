"use server";

/**
 * Onboarding server actions.
 *
 * Each one re-reads the session and takes the organization from it. A form
 * field naming an organization would be an authorization decision made by the
 * browser, which is exactly the thing this codebase does not do.
 */

import { revalidatePath } from "next/cache";

import { currentUser } from "@/lib/auth";
import {
  dismissOnboarding,
  recordPlanChoice,
  recordPurpose,
  renameOrganization,
} from "@/lib/onboarding";
import { planById } from "@/lib/plans";

import type { ActionState } from "./action-state";

export async function renameOrganizationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const result = await renameOrganization(user.organizationId, String(formData.get("name") ?? ""));
  if (!result.ok) return { ok: false, error: result.error ?? "Could not save that." };

  revalidatePath("/onboarding");
  revalidatePath("/settings");
  return { ok: true, error: null };
}

export async function recordPurposeAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const result = await recordPurpose(user.organizationId, String(formData.get("purpose") ?? ""));
  if (!result.ok) return { ok: false, error: result.error ?? "Could not save that." };

  revalidatePath("/onboarding");
  return { ok: true, error: null };
}

export async function choosePlanAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const planId = String(formData.get("planId") ?? "");
  const plan = planById(planId);
  if (!plan) return { ok: false, error: "That is not a plan." };

  // Recording a choice is not granting it. A paid plan still requires a
  // completed checkout and a verified webhook before `subscriptions` says so,
  // and entitlements are read from there, never from this column.
  const result = await recordPlanChoice(user.organizationId, plan.id);
  if (!result.ok) return { ok: false, error: result.error ?? "Could not save that." };

  revalidatePath("/onboarding");
  return { ok: true, error: null };
}

export async function dismissOnboardingAction(): Promise<void> {
  const user = await currentUser();
  if (!user) return;
  await dismissOnboarding(user.organizationId);
  revalidatePath("/onboarding");
}
