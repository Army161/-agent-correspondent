/**
 * Outbound webhook subscriptions and delivery.
 *
 * There is no queue and no retry worker: this app has no background job
 * runner, so a delivery is attempted once, inline, with a bounded timeout,
 * and the attempt (success or failure) is logged to
 * `webhook_delivery_attempts` for the operator to see. A receiving endpoint
 * that is down when an event fires misses it. That is a real limitation, not
 * a hidden one — see docs/WEBHOOKS.md.
 */

import "server-only";

import { and, eq, getDb, webhookDeliveryAttempts, webhooks } from "@acor/db";
import { newId } from "@acor/core";

import { decryptSecret, encryptSecret, generateWebhookSecret, signPayload } from "./crypto";

/** The event names a subscription may list. Every event this deployment fires. */
export const WEBHOOK_EVENTS = ["job.funded", "job.settled"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookSubscription {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly createdAt: Date;
}

export type CreateWebhookResult =
  | { readonly ok: true; readonly id: string; readonly secret: string }
  | { readonly ok: false; readonly error: string; readonly code?: string };

function validUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function createWebhookSubscription(
  organizationId: string,
  url: string,
  events: readonly string[],
): Promise<CreateWebhookResult> {
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };
  if (!validUrl(url)) return { ok: false, error: "url must be a valid http(s) URL.", code: "INVALID_INPUT" };
  const unknown = events.filter((event) => !(WEBHOOK_EVENTS as readonly string[]).includes(event));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown event(s): ${unknown.join(", ")}. Known events: ${WEBHOOK_EVENTS.join(", ")}.`,
      code: "INVALID_INPUT",
    };
  }
  if (events.length === 0) {
    return { ok: false, error: "events must name at least one event.", code: "INVALID_INPUT" };
  }

  let secretCiphertext: string;
  const secret = generateWebhookSecret();
  try {
    secretCiphertext = encryptSecret(secret);
  } catch {
    return {
      ok: false,
      error:
        "This deployment has no WEBHOOK_ENCRYPTION_KEY configured, so a webhook secret cannot be stored safely.",
      code: "CAPABILITY_UNAVAILABLE",
    };
  }

  const id = newId("hook");
  await db.insert(webhooks).values({
    id,
    organizationId,
    url,
    events: [...events],
    secretCiphertext,
    active: true,
  });

  // Returned exactly once. It is not derivable from anything stored -- the
  // ciphertext requires WEBHOOK_ENCRYPTION_KEY to read back, and this
  // deployment never re-displays a signing secret after creation, the same
  // posture as an API key.
  return { ok: true, id, secret };
}

export async function listWebhookSubscriptions(organizationId: string): Promise<WebhookSubscription[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db.select().from(webhooks).where(eq(webhooks.organizationId, organizationId));
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    events: row.events,
    active: row.active,
    createdAt: row.createdAt,
  }));
}

export async function revokeWebhookSubscription(
  organizationId: string,
  webhookId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const updated = await db
    .update(webhooks)
    .set({ active: false })
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.organizationId, organizationId)))
    .returning({ id: webhooks.id });
  return updated.length > 0;
}

/**
 * Fire `event` at every active subscription this organization has for it.
 *
 * Best-effort and non-throwing: a webhook delivery failing must never fail
 * the economic action that triggered it. Call this after the triggering
 * transaction has committed, not from inside it -- a rolled-back job must
 * never have fired a webhook.
 */
export async function dispatchWebhookEvent(
  organizationId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  if (!db) return;

  const subscriptions = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.organizationId, organizationId), eq(webhooks.active, true)));
  const targets = subscriptions.filter((row) => row.events.includes(event));
  if (targets.length === 0) return;

  const body = JSON.stringify({
    event,
    deliveredAt: new Date().toISOString(),
    data: payload,
  });

  await Promise.all(
    targets.map(async (target) => {
      let ok = false;
      let statusCode: number | null = null;
      let error: string | null = null;
      try {
        const secret = decryptSecret(target.secretCiphertext);
        const signature = signPayload(secret, body);
        const response = await fetch(target.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-acor-event": event,
            "x-acor-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        statusCode = response.status;
        ok = response.ok;
        if (!ok) error = `receiving endpoint returned ${response.status}`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "delivery failed";
      }

      try {
        await db.insert(webhookDeliveryAttempts).values({
          id: newId("evt"),
          webhookId: target.id,
          organizationId,
          event,
          ok,
          statusCode,
          error,
        });
      } catch (cause) {
        console.error("[webhooks] could not record delivery attempt:", cause);
      }
    }),
  );
}
