/**
 * Plan limit enforcement.
 *
 * Entitlements are a server-side read of the `subscriptions` row. A limit check
 * that consulted anything the caller sent — a header, a body field, a cached
 * plan in local storage — would be advisory, and an advisory limit on a paid
 * feature is no limit at all.
 *
 * Fail-closed: when the plan cannot be determined, the default plan's limits
 * apply, and the default grants nothing paid.
 */

import "server-only";

import { agents, and, count, eq, getDb, ne } from "@acor/db";

import { entitlementsFor } from "./entitlements";

export interface LimitCheck {
  readonly allowed: boolean;
  /** Why not, phrased for the person who hit it. */
  readonly reason: string | null;
  readonly planId: string;
  readonly limit: number | "unlimited";
  readonly current: number;
}

/** Whether this organization may create one more agent. */
export async function canCreateAgent(organizationId: string): Promise<LimitCheck> {
  const entitlements = await entitlementsFor(organizationId);
  const limit = entitlements.plan.limits.agents;

  const db = getDb();
  if (!db) {
    return {
      allowed: false,
      reason: "No database is configured, so the agent count cannot be established.",
      planId: entitlements.plan.id,
      limit,
      current: 0,
    };
  }

  let current = 0;
  try {
    const rows = await db
      .select({ total: count() })
      .from(agents)
      .where(and(eq(agents.organizationId, organizationId), ne(agents.status, "DISABLED")));
    current = Number(rows[0]?.total ?? 0);
  } catch {
    // An unknown count is not a low count.
    return {
      allowed: false,
      reason: "The current agent count could not be read, so the plan limit cannot be applied.",
      planId: entitlements.plan.id,
      limit,
      current: 0,
    };
  }

  if (limit === "unlimited") {
    return { allowed: true, reason: null, planId: entitlements.plan.id, limit, current };
  }

  if (current >= limit) {
    return {
      allowed: false,
      reason: `The ${entitlements.plan.name} plan includes ${limit} agent${limit === 1 ? "" : "s"}, and this organization has ${current}. Disable one, or change plan.`,
      planId: entitlements.plan.id,
      limit,
      current,
    };
  }

  return { allowed: true, reason: null, planId: entitlements.plan.id, limit, current };
}

/** Whether this organization's plan includes the REST API. */
export async function hasDeveloperApi(organizationId: string): Promise<boolean> {
  const entitlements = await entitlementsFor(organizationId);
  return entitlements.plan.limits.developerApi;
}
