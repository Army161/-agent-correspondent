/**
 * Outbound webhook subscriptions.
 *
 * `POST` creates one and returns its signing secret exactly once -- see
 * lib/webhooks/crypto.ts for why it cannot be shown again. `GET` lists this
 * organization's subscriptions, never including the secret.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { createWebhookSubscription, listWebhookSubscriptions, WEBHOOK_EVENTS } from "@/lib/webhooks";
import { getDb } from "@acor/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const subscriptions = await listWebhookSubscriptions(principal.organizationId);
  return NextResponse.json({
    webhooks: subscriptions.map((sub) => ({ ...sub, createdAt: sub.createdAt.toISOString() })),
    knownEvents: WEBHOOK_EVENTS,
  });
}

const schema = z.object({
  url: z.string().min(1).max(2000),
  events: z.array(z.string()).min(1),
});

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const result = await createWebhookSubscription(
    principal.organizationId,
    parsed.data.url,
    parsed.data.events,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.code ?? "NOT_CREATED", message: result.error },
      { status: result.code === "CAPABILITY_UNAVAILABLE" ? 503 : 400 },
    );
  }

  return NextResponse.json({ webhookId: result.id, secret: result.secret }, { status: 201 });
}
