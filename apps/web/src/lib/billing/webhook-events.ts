/**
 * Interpreting a Paddle event.
 *
 * Pure: a verified payload in, a decision out. The handler does the I/O; this
 * module decides what the event means, so the interesting cases can be tested
 * without a database or a network.
 *
 * The rule that shapes everything here: an event is only allowed to say what
 * Paddle actually told us. A price id that maps to no configured plan is not
 * guessed at, and an event that names no organization we recognise is recorded
 * and left unapplied rather than applied to somebody.
 */

import { planForPriceId } from "../plans";
import type { SubscriptionStatus } from "./subscription-status";

/** The events worth acting on. Everything else is recorded and ignored. */
const SUBSCRIPTION_EVENTS = new Set([
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.trialing",
]);

/** Paddle's subscription statuses, mapped onto ours. */
function mapStatus(providerStatus: string): SubscriptionStatus {
  switch (providerStatus) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    case "paused":
      return "PAUSED";
    case "canceled":
    case "cancelled":
      return "CANCELED";
    default:
      // An unrecognised status is not an entitlement. Guessing "probably
      // active" is how a cancelled account keeps its plan.
      return "NONE";
  }
}

export interface PaddleEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date | null;
  readonly data: Record<string, unknown>;
}

export type EventDecision =
  | {
      readonly kind: "APPLY";
      readonly organizationId: string;
      readonly subscriptionId: string;
      readonly customerId: string | null;
      readonly priceId: string | null;
      readonly planId: string;
      readonly status: SubscriptionStatus;
      readonly providerStatus: string;
      readonly currentPeriodEnd: Date | null;
      readonly cancelAt: Date | null;
    }
  | { readonly kind: "IGNORE"; readonly reason: string }
  | { readonly kind: "REJECT"; readonly reason: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function date(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parse the outer envelope. Returns null when it is not shaped like an event. */
export function parseEnvelope(body: unknown): PaddleEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const eventId = str(record.event_id);
  const eventType = str(record.event_type);
  const data = record.data;
  if (!eventId || !eventType || typeof data !== "object" || data === null) return null;
  return {
    eventId,
    eventType,
    occurredAt: date(record.occurred_at),
    data: data as Record<string, unknown>,
  };
}

/**
 * Decide what one event means.
 *
 * `knownOrganization` answers "is this an organization in this deployment".
 * The id itself comes from `custom_data`, which we wrote when the transaction
 * was created server-side — never from a browser.
 */
export function decideEvent(
  envelope: PaddleEnvelope,
  knownOrganization: (id: string) => boolean,
): EventDecision {
  if (!SUBSCRIPTION_EVENTS.has(envelope.eventType)) {
    return { kind: "IGNORE", reason: `no action for ${envelope.eventType}` };
  }

  const data = envelope.data;
  const subscriptionId = str(data.id);
  if (!subscriptionId) return { kind: "REJECT", reason: "event carries no subscription id" };

  const custom = (data.custom_data ?? null) as Record<string, unknown> | null;
  const organizationId = custom ? str(custom.organizationId) : null;
  if (!organizationId) {
    return {
      kind: "REJECT",
      reason: "no organizationId in custom_data; the transaction was not created by this service",
    };
  }
  if (!knownOrganization(organizationId)) {
    return { kind: "REJECT", reason: "custom_data names an organization this deployment does not have" };
  }

  const providerStatus = str(data.status) ?? "unknown";
  const status =
    envelope.eventType === "subscription.canceled" ? "CANCELED" : mapStatus(providerStatus);

  // Paddle reports the price on the subscription's items.
  const items = Array.isArray(data.items) ? data.items : [];
  let priceId: string | null = null;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const price = (item as Record<string, unknown>).price;
    if (typeof price === "object" && price !== null) {
      priceId = str((price as Record<string, unknown>).id);
      if (priceId) break;
    }
  }

  const planId = priceId ? planForPriceId(priceId) : null;
  if (!planId) {
    return {
      kind: "REJECT",
      reason: priceId
        ? `price ${priceId} is not mapped to a plan in this deployment's configuration`
        : "event carries no price id",
    };
  }

  const billingPeriod = (data.current_billing_period ?? null) as Record<string, unknown> | null;

  return {
    kind: "APPLY",
    organizationId,
    subscriptionId,
    customerId: str(data.customer_id),
    priceId,
    planId,
    status,
    providerStatus,
    currentPeriodEnd: billingPeriod ? date(billingPeriod.ends_at) : null,
    cancelAt: date(data.scheduled_change ? (data.scheduled_change as Record<string, unknown>).effective_at : null),
  };
}
