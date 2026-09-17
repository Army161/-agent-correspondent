/**
 * Wallets bound to an agent.
 *
 * Binding a wallet is what makes a signature meaningful: the relay treats a
 * bound wallet as entitled to commit that agent's money, and refuses an
 * authorization signed by anything else. That is only safe if the binding is a
 * fact rather than a claim — so binding a user-controlled address requires a
 * signature over a challenge this service issued.
 *
 * An address typed into a form proves nothing about who holds the key. Such a
 * binding is recorded as unverified, is never a signer, and is never a payout
 * destination.
 *
 * No key material is stored here — only an address, the custody model, an
 * opaque provider reference, and the proof.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  agents,
  agentWallets,
  and,
  eq,
  getDb,
} from "@acor/db";
import { newId } from "@acor/core";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { recordAudit } from "@/lib/platform";
import { consumeProof, isXrplNetwork, type SupportedNetwork } from "@/lib/wallets/ownership";

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
  /** The challenge answered, and the signature answering it. Required for `external`. */
  nonce: z.string().min(8).max(64).optional(),
  signature: z.string().min(4).max(256).optional(),
  /**
   * The signing key, for XRPL only.
   *
   * An EVM signature carries a recovery parameter, so the address falls out of
   * the signature itself. An XRPL signature does not, so the key comes with it
   * — and the address is derived from that key rather than believed.
   */
  publicKey: z.string().min(66).max(66).optional(),
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
      verifiedAt: agentWallets.verifiedAt,
    })
    .from(agentWallets)
    .where(eq(agentWallets.agentId, id));

  return NextResponse.json({
    wallets: rows.map((row) => ({
      network: row.network,
      address: row.address,
      custody: row.custody,
      isPrimary: row.isPrimary,
      // Stated plainly rather than implied by a null timestamp: a consumer
      // that ignores this field should not accidentally treat a claim as a
      // proved binding.
      verified: row.verifiedAt !== null,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
    })),
  });
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
  // XRPL addresses are base58 and case-significant; lowercasing one destroys
  // it. EVM addresses are checksummed inconsistently across tools and the relay
  // compares them case-insensitively, so one canonical case is stored.
  const address = parsed.data.network.startsWith("ARC")
    ? parsed.data.address.trim().toLowerCase()
    : parsed.data.address.trim();

  if (parsed.data.network.startsWith("ARC") && !/^0x[0-9a-f]{40}$/.test(address)) {
    return badRequest("An Arc wallet address must be a 20-byte hex address.");
  }

  // A user-controlled wallet must prove control. Without that, anyone could
  // name a stranger's address as their agent's — which at best displays
  // someone else's balance as yours, and at worst points a payout instruction
  // somewhere its owner never agreed to.
  let verifiedAt: Date | null = null;
  let proofNonce: string | null = null;
  let proofSignature: string | null = null;

  if (parsed.data.custody === "external") {
    if (!parsed.data.nonce || !parsed.data.signature) {
      return NextResponse.json(
        {
          error: "PROOF_REQUIRED",
          message:
            "Binding a user-controlled wallet requires a signed challenge. Request one from POST /api/v1/agents/{id}/wallets/challenge.",
        },
        { status: 400 },
      );
    }

    if (isXrplNetwork(parsed.data.network) && !parsed.data.publicKey) {
      return NextResponse.json(
        {
          error: "PROOF_REQUIRED",
          message:
            "An XRPL proof must include the signing public key: an XRPL signature carries no recovery parameter, so the account is derived from the key.",
        },
        { status: 400 },
      );
    }

    const proof = await consumeProof({
      organizationId: principal.organizationId,
      agentId: id,
      network: parsed.data.network as SupportedNetwork,
      nonce: parsed.data.nonce,
      proof: isXrplNetwork(parsed.data.network)
        ? {
            kind: "XRPL",
            signature: parsed.data.signature,
            publicKey: parsed.data.publicKey as string,
          }
        : { kind: "EVM", signature: parsed.data.signature },
    });

    if (!proof.ok) {
      await recordAudit({
        organizationId: principal.organizationId,
        actor: `${principal.kind}:${principal.id}`,
        action: "agent.wallet_bind_refused",
        subject: id,
        outcome: "DENY",
        detail: { network: parsed.data.network, address, reason: proof.code },
      });
      return NextResponse.json({ error: proof.code, message: proof.error }, { status: 400 });
    }

    // The proof establishes an address. Binding a different one would make the
    // proof decorative.
    // EVM comparison is case-insensitive because checksums vary between tools;
    // XRPL base58 is exact.
    const claimed = isXrplNetwork(parsed.data.network) ? address : address.toLowerCase();
    if (proof.address !== claimed) {
      return NextResponse.json(
        {
          error: "SIGNER_MISMATCH",
          message: "The proof was issued for a different address than the one being bound.",
        },
        { status: 400 },
      );
    }

    verifiedAt = new Date();
    proofNonce = proof.nonce;
    proofSignature = parsed.data.signature;
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
      verifiedAt,
      proofNonce,
      proofSignature,
    })
    .onConflictDoNothing();

  await recordAudit({
    organizationId: principal.organizationId,
    actor: `${principal.kind}:${principal.id}`,
    action: "agent.wallet_bound",
    subject: id,
    outcome: "ALLOW",
    detail: {
      network: parsed.data.network,
      address,
      custody: parsed.data.custody,
      verified: verifiedAt === null ? "false" : "true",
    },
  });

  return NextResponse.json(
    {
      bound: true,
      agentId: id,
      network: parsed.data.network,
      address,
      verified: verifiedAt !== null,
    },
    { status: 201 },
  );
}
