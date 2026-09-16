import { NextResponse } from "next/server";

import { describeIntent } from "@acor/core";

import { authenticateRequest, notConnected, unauthorized } from "@/lib/api";
import { createRelay } from "@/lib/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const relay = createRelay({ organizationId: principal.organizationId });
  if (!relay) return notConnected();

  const { id } = await params;
  const stored = await relay.get(id);
  if (!stored) {
    return NextResponse.json({ error: "NOT_FOUND", message: "No such intent." }, { status: 404 });
  }

  return NextResponse.json({
    intentId: stored.intent.intentId,
    hash: stored.hash,
    // Expiry is a live property, not a stored one: an intent whose window has
    // closed reads EXPIRED even if nothing has run to update its row.
    status: stored.status,
    signer: stored.signer,
    receivedAt: stored.receivedAt.toISOString(),
    display: describeIntent(stored.intent),
  });
}
