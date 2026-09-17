/**
 * Ask for a proof of wallet control.
 *
 * Returns a message for the caller's wallet to sign. The message is single-use,
 * expires in ten minutes, and names the agent it will bind to — so a proof
 * collected for one agent cannot bind an address to another.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { agents, and, eq, getDb } from "@acor/db";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { issueChallenge, type SupportedNetwork } from "@/lib/wallets/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  network: z.enum(["ARC", "ARC_TESTNET"]),
  address: z.string().min(4).max(128),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const db = getDb();
  if (!db) return notConnected();

  const { id } = await params;
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.organizationId, principal.organizationId)))
    .limit(1);
  if (owned.length === 0) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such agent in this organization." },
      { status: 404 },
    );
  }

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const issued = await issueChallenge({
    organizationId: principal.organizationId,
    agentId: id,
    network: parsed.data.network as SupportedNetwork,
    address: parsed.data.address,
  });

  if (!issued.ok) return badRequest(issued.error);

  return NextResponse.json(
    {
      nonce: issued.challenge.nonce,
      message: issued.challenge.message,
      address: issued.challenge.address,
      chainId: issued.challenge.chainId,
      expiresAt: issued.challenge.expiresAt.toISOString(),
    },
    { status: 201 },
  );
}
