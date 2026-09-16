/**
 * Cancel an open intent.
 *
 * Only a wallet entitled to commit the buyer agent's money may cancel. The
 * nonce stays burned either way: releasing it would re-open the replay window
 * the burn exists to close, since the holder of the original signature could
 * simply resubmit it.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { createRelay } from "@/lib/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  requestedBy: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "requestedBy must be a hex address"),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const relay = createRelay({ organizationId: principal.organizationId });
  if (!relay) return notConnected();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid request.");
  }

  const { id } = await params;
  const cancelled = await relay.cancel(id, parsed.data.requestedBy);

  if (!cancelled) {
    const stored = await relay.get(id);
    return NextResponse.json(
      {
        cancelled: false,
        error: stored ? "NOT_CANCELLABLE" : "NOT_FOUND",
        message: stored
          ? `Intent is ${stored.status.toLowerCase()}, or ${parsed.data.requestedBy} is not authorized to cancel it.`
          : "No such intent.",
      },
      { status: stored ? 409 : 404 },
    );
  }

  return NextResponse.json({ cancelled: true, intentId: id, status: "CANCELLED" });
}
