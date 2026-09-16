/**
 * Subscription status, as this system models it.
 *
 * Its own module so the pure webhook-interpretation code can use it without
 * pulling in the database reads of `entitlements.ts`.
 */
export type SubscriptionStatus =
  | "NONE"
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "PAUSED"
  | "CANCELED";
