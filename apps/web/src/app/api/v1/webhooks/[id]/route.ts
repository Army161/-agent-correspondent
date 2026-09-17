/** Revoke a webhook subscription. Soft-deleted: it stops receiving deliveries, its delivery history stays. */

import { NextResponse } from "next/server";

import { authenticateRequest, notConnected, unauthorized } from "@/lib/api";
import { revokeWebhookSubscription } from "@/lib/webhooks";
import { getDb } from "@acor/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const { id } = await params;
  const revoked = await revokeWebhookSubscription(principal.organizationId, id);
  if (!revoked) {
    return NextResponse.json({ error: "NOT_FOUND", message: "No such webhook." }, { status: 404 });
  }
  return NextResponse.json({ webhookId: id, active: false });
}
