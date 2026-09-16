/**
 * What an organization is entitled to.
 *
 * Read server-side from the `subscriptions` row, which is written only by the
 * signature-verified webhook handler. Nothing here consults a request body, a
 * cookie, local storage or a checkout success page — a browser that reached a
 * success URL has proved that it reached a URL.
 *
 * Fail-closed: no row, an unreadable database, an unrecognised plan or a
 * lapsed subscription all resolve to the default plan, which grants nothing
 * paid.
 */

import "server-only";

import { eq, getDb, subscriptions } from "@acor/db";

import { DEFAULT_PLAN_ID, planById, type Plan, type PlanId, plans } from "../plans";

export type SubscriptionStatus =
  | "NONE"
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "PAUSED"
  | "CANCELED";

/** The statuses that actually confer the paid plan's limits. */
const ENTITLING: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  "TRIALING",
  "ACTIVE",
  // PAST_DUE keeps access during the provider's dunning window. Cutting a
  // customer off on the first failed charge loses more than it protects, and
  // the provider will send CANCELED when it gives up.
  "PAST_DUE",
]);

export interface Entitlements {
  readonly plan: Plan;
  readonly status: SubscriptionStatus;
  /** The provider's own status string, when there is one. */
  readonly providerStatus: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAt: Date | null;
  /** Why these entitlements are what they are. */
  readonly source: "subscription" | "default" | "unavailable";
}

function fallback(source: "default" | "unavailable"): Entitlements {
  const plan = planById(DEFAULT_PLAN_ID);
  if (!plan) throw new Error(`default plan ${DEFAULT_PLAN_ID} is not defined`);
  return {
    plan,
    status: "NONE",
    providerStatus: null,
    currentPeriodEnd: null,
    cancelAt: null,
    source,
  };
}

export async function entitlementsFor(organizationId: string): Promise<Entitlements> {
  const db = getDb();
  if (!db) return fallback("unavailable");

  try {
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);

    const row = rows[0];
    if (!row) return fallback("default");

    const status = row.status as SubscriptionStatus;
    const plan = planById(row.planId);

    // An unknown plan id means configuration drifted — a price id was mapped to
    // a plan that no longer exists. Granting the *previous* limits would be a
    // guess; the default is the only safe reading.
    if (!plan || !ENTITLING.has(status)) return fallback("default");

    // A subscription whose period has already ended, with no renewal recorded,
    // is not an entitlement. The webhook should have cancelled it; if it did
    // not arrive, time still passed.
    if (row.currentPeriodEnd && row.currentPeriodEnd.getTime() < Date.now()) {
      return fallback("default");
    }

    return {
      plan,
      status,
      providerStatus: row.providerStatus,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAt: row.cancelAt,
      source: "subscription",
    };
  } catch {
    return fallback("unavailable");
  }
}

/**
 * Resolve a provider price id to a plan.
 *
 * Configuration is the only mapping. A price id that matches nothing configured
 * is not guessed at — the webhook records the event and refuses to apply it,
 * so a mis-keyed environment variable produces an unapplied event rather than a
 * silently wrong entitlement.
 */
export function planForPriceId(priceId: string): PlanId | null {
  const needle = priceId.trim();
  if (needle.length === 0) return null;
  for (const plan of plans()) {
    if (plan.priceIds.monthly === needle || plan.priceIds.yearly === needle) {
      return plan.id;
    }
  }
  return null;
}
