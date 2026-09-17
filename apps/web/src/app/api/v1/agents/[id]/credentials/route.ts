/**
 * Credentials held by an agent.
 *
 * `POST` asks for one; it does not describe one. The claims are derived
 * server-side from our own records, because a caller who could name the claims
 * could mint "controller verified" for themselves — and the entire value of a
 * credential is that the counterparty does not have to ask them.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { agents, and, eq, getDb } from "@acor/db";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { credentialsForAgent, issueCredential, revokeCredential } from "@/lib/credentials";
import { recordAudit } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const issueSchema = z.object({
  type: z.enum([
    "CONTROLLER_VERIFIED",
    "MANDATE_BOUND",
    "WORK_HISTORY",
    "SETTLEMENT_PERMITTED",
  ]),
});

const revokeSchema = z.object({
  credentialId: z.string().min(8).max(128),
  reason: z.string().min(1).max(64),
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
  if (!getDb()) return notConnected();

  const { id } = await params;
  if (!(await ownsAgent(principal.organizationId, id))) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such agent in this organization." },
      { status: 404 },
    );
  }

  const credentials = await credentialsForAgent(principal.organizationId, id);
  return NextResponse.json({
    credentials: credentials.map((credential) => ({
      credentialId: credential.credentialId,
      type: credential.type,
      document: credential.document,
      signature: credential.signature,
      issuerPublicKey: credential.issuerPublicKey,
      issuedAt: credential.issuedAt.toISOString(),
      expiresAt: credential.expiresAt.toISOString(),
      revokedAt: credential.revokedAt?.toISOString() ?? null,
      // Re-verified as it is read. A stored signature that no longer verifies
      // is exactly what a reader most needs to be told.
      valid: credential.valid,
      reasons: credential.reasons,
      // Additive only: see docs/POST_QUANTUM_READINESS.md. Null on every
      // credential issued without a configured secondary attestation key.
      secondaryAttestation: credential.secondaryAttestation,
    })),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const { id } = await params;
  if (!(await ownsAgent(principal.organizationId, id))) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such agent in this organization." },
      { status: 404 },
    );
  }

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");

  const revoking = revokeSchema.safeParse(body);
  if (revoking.success) {
    const done = await revokeCredential(
      principal.organizationId,
      revoking.data.credentialId,
      revoking.data.reason,
    );
    await recordAudit({
      organizationId: principal.organizationId,
      actor: `${principal.kind}:${principal.id}`,
      action: "credential.revoked",
      subject: revoking.data.credentialId,
      outcome: done ? "ALLOW" : "DENY",
      detail: { reason: revoking.data.reason },
    });
    return done
      ? NextResponse.json({ revoked: true, credentialId: revoking.data.credentialId })
      : NextResponse.json(
          { error: "NOT_FOUND", message: "No such credential in this organization." },
          { status: 404 },
        );
  }

  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      "Body must be either { type } to issue, or { credentialId, reason } to revoke.",
    );
  }

  const issued = await issueCredential(principal.organizationId, id, parsed.data.type);
  if (!issued.ok) {
    await recordAudit({
      organizationId: principal.organizationId,
      actor: `${principal.kind}:${principal.id}`,
      action: "credential.refused",
      subject: id,
      outcome: "DENY",
      detail: { type: parsed.data.type },
    });
    return NextResponse.json({ error: "NOT_ISSUED", message: issued.error }, { status: 409 });
  }

  await recordAudit({
    organizationId: principal.organizationId,
    actor: `${principal.kind}:${principal.id}`,
    action: "credential.issued",
    subject: id,
    outcome: "ALLOW",
    detail: { type: parsed.data.type, credentialId: issued.credentialId },
  });

  return NextResponse.json(
    { credentialId: issued.credentialId, document: issued.document },
    { status: 201 },
  );
}
