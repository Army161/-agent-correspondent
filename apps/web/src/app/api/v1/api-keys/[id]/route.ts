/**
 * Revoke an API key. Either a session or any key of the same organization may
 * do it: revocation only ever removes access, so the bar is lower than for
 * issuing one -- a key that knows it leaked should be able to end itself.
 */

import { NextResponse } from "next/server";

import { getDb } from "@acor/db";

import { authenticateRequest, notConnected, unauthorized } from "@/lib/api";
import { revokeApiKey } from "@/lib/api-keys";

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
  const revoked = await revokeApiKey(principal.organizationId, id, `revoked by ${principal.kind}:${principal.id}`);
  if (!revoked) {
    return NextResponse.json({ error: "NOT_FOUND", message: "No such active key." }, { status: 404 });
  }
  return NextResponse.json({ keyId: id, revoked: true });
}
