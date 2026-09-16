/**
 * Paddle webhooks.
 *
 * This endpoint is the only thing in the system that may grant a paid plan. It
 * is public, so every line of it assumes the caller is hostile until the
 * signature says otherwise:
 *
 *  1. Read the *raw* body. Re-serialising parsed JSON changes bytes and breaks
 *     the signature.
 *  2. Verify the HMAC in constant time, and reject anything older than a few
 *     minutes so a captured delivery cannot be replayed.
 *  3. Record the event. The unique index on (provider, event_id) makes a
 *     duplicate delivery a no-op rather than a second application.
 *  4. Decide what it means, and apply it — or record why it was not applied.
 *
 * An unverified request never reaches step 3, so the event log contains only
 * things Paddle actually sent.
 */

import { NextResponse } from "next/server";

import {
  billingEvents,
  eq,
  getDb,
  organizations,
  subscriptions,
} from "@acor/db";
import { newId } from "@acor/core";

import { decideEvent, parseEnvelope } from "@/lib/billing/webhook-events";
import { verifyPaddleSignature } from "@/lib/billing/paddle-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  const raw = await request.text();

  const signature = verifyPaddleSignature(
    raw,
    request.headers.get("paddle-signature"),
    secret,
    new Date(),
  );
  if (!signature.ok) {
    // The reason is logged, not returned: telling a caller *why* their forgery
    // failed is free tuning feedback.
    console.warn(`[billing] rejected webhook: ${signature.reason}`);
    return NextResponse.json(
      { error: signature.reason === "MISSING_SECRET" ? "not configured" : "invalid signature" },
      { status: signature.reason === "MISSING_SECRET" ? 503 : 401 },
    );
  }

  const db = getDb();
  if (!db) {
    // 503 rather than 200: Paddle will retry, and a dropped event means a
    // customer who paid without being granted anything.
    return NextResponse.json({ error: "no database" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "malformed body" }, { status: 400 });
  }

  const envelope = parseEnvelope(body);
  if (!envelope) return NextResponse.json({ error: "unrecognised event" }, { status: 400 });

  // Record first. If applying throws, the event is still on file.
  const eventRowId = newId("bill");
  try {
    const inserted = await db
      .insert(billingEvents)
      .values({
        id: eventRowId,
        provider: "paddle",
        providerEventId: envelope.eventId,
        eventType: envelope.eventType,
        occurredAt: envelope.occurredAt,
        payload: body as Record<string, unknown>,
      })
      .onConflictDoNothing({
        target: [billingEvents.provider, billingEvents.providerEventId],
      })
      .returning({ id: billingEvents.id });

    if (inserted.length === 0) {
      // Already seen. Paddle retries on any non-2xx, so duplicates are normal.
      return NextResponse.json({ ok: true, duplicate: true });
    }
  } catch (cause) {
    console.error("[billing] could not record event:", cause);
    return NextResponse.json({ error: "could not record event" }, { status: 503 });
  }

  const decision = decideEvent(envelope, () => true);

  if (decision.kind === "IGNORE" || decision.kind === "REJECT") {
    await db
      .update(billingEvents)
      .set({ rejectedReason: decision.reason })
      .where(eq(billingEvents.id, eventRowId));
    if (decision.kind === "REJECT") {
      console.warn(`[billing] event ${envelope.eventId} not applied: ${decision.reason}`);
    }
    // 200: the event was received and understood. Retrying would not help.
    return NextResponse.json({ ok: true, applied: false, reason: decision.reason });
  }

  // The organization id comes from custom_data we wrote when the transaction
  // was created server-side. Confirm it still exists before writing to it.
  const org = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, decision.organizationId))
    .limit(1);

  if (org.length === 0) {
    const reason = "custom_data names an organization this deployment does not have";
    await db
      .update(billingEvents)
      .set({ rejectedReason: reason })
      .where(eq(billingEvents.id, eventRowId));
    return NextResponse.json({ ok: true, applied: false, reason });
  }

  const now = new Date();
  try {
    await db
      .insert(subscriptions)
      .values({
        id: newId("sub"),
        organizationId: decision.organizationId,
        provider: "paddle",
        providerCustomerId: decision.customerId,
        providerSubscriptionId: decision.subscriptionId,
        providerPriceId: decision.priceId,
        planId: decision.planId,
        status: decision.status,
        providerStatus: decision.providerStatus,
        currentPeriodEnd: decision.currentPeriodEnd,
        cancelAt: decision.cancelAt,
        lastEventId: envelope.eventId,
        lastEventAt: envelope.occurredAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subscriptions.organizationId,
        set: {
          providerCustomerId: decision.customerId,
          providerSubscriptionId: decision.subscriptionId,
          providerPriceId: decision.priceId,
          planId: decision.planId,
          status: decision.status,
          providerStatus: decision.providerStatus,
          currentPeriodEnd: decision.currentPeriodEnd,
          cancelAt: decision.cancelAt,
          lastEventId: envelope.eventId,
          lastEventAt: envelope.occurredAt ?? now,
          updatedAt: now,
        },
      });

    await db
      .update(billingEvents)
      .set({ appliedAt: now, organizationId: decision.organizationId })
      .where(eq(billingEvents.id, eventRowId));

    return NextResponse.json({ ok: true, applied: true });
  } catch (cause) {
    console.error("[billing] could not apply event:", cause);
    // 503 so Paddle retries; the unique index makes the retry safe.
    return NextResponse.json({ error: "could not apply event" }, { status: 503 });
  }
}
