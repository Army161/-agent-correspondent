/**
 * Wallets bound to an agent.
 *
 * Binding a wallet is what makes a signature meaningful: the relay treats a
 * bound wallet as entitled to commit that agent's money, and refuses an
 * authorization signed by anything else. No key material is stored here — only
 * an address, the custody model, and an opaque provider reference.
 */

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { agents, agentWallets, getDb } from "@acor/db";
import { newId } from "@acor/core";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { recordAudit } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  network: z.enum(["ARC", "ARC_TESTNET", "XRPL", "XRPL_TESTNET"]),
  address: z.string().min(4).max(128),
  /**
   * Where the signing key lives. `external` is a user-controlled wallet,
   * `circle` a custody provider, `readonly` an address we can watch but not
   * spend from.
   */
  custody: z.enum(["external", "circle", "readonly"]).default("external"),
  externalRef: z.string().max(128).optional(),
  isPrimary: z.boolean().default(false),
});

async function ownsAgent(organizationId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
    .limit(1);
  return rows.length > 0;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  const db = getDb();
  if (!db) return notConnected();

  const { id } = await params;
  if (!(await ownsAgent(principal.organizationId, id))) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such agent in this organization." },
      { status: 404 },
    );
  }

  const rows = await db
    .select({
      network: agentWallets.network,
      address: agentWallets.address,
      custody: agentWallets.custody,
      isPrimary: agentWallets.isPrimary,
    })
    .from(agentWallets)
    .where(eq(agentWallets.agentId, id));

  return NextResponse.json({ wallets: rows });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  const db = getDb();
  if (!db) return notConnected();

  const { id } = await params;
  if (!(await ownsAgent(principal.organizationId, id))) {
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

  // EVM addresses are checksummed inconsistently across tools, and the relay
  // compares them case-insensitively. Storing one canonical case keeps the
  // unique index meaningful.
  const address = parsed.data.network.startsWith("ARC")
    ? parsed.data.address.trim().toLowerCase()
    : parsed.data.address.trim();

  if (parsed.data.network.startsWith("ARC") && !/^0x[0-9a-f]{40}$/.test(address)) {
    return badRequest("An Arc wallet address must be a 20-byte hex address.");
  }

  await db
    .insert(agentWallets)
    .values({
      id: newId("agent"),
      agentId: id,
      network: parsed.data.network,
      address,
      custody: parsed.data.custody,
      externalRef: parsed.data.externalRef ?? null,
      isPrimary: parsed.data.isPrimary,
    })
    .onConflictDoNothing();

  await recordAudit({
    organizationId: principal.organizationId,
    actor: `${principal.kind}:${principal.id}`,
    action: "agent.wallet_bound",
    subject: id,
    outcome: "ALLOW",
    detail: { network: parsed.data.network, address, custody: parsed.data.custody },
  });

  return NextResponse.json({ bound: true, agentId: id, network: parsed.data.network, address }, { status: 201 });
}
