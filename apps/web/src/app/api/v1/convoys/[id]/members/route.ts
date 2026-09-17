/**
 * Convoy membership.
 *
 * `POST` adds an agent; `DELETE` removes one. An agent belongs to at most one
 * convoy at a time (enforced by a unique index), so adding an agent already in
 * another convoy is refused rather than silently moving it.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { addMember, removeMember } from "@/lib/convoy";
import { getDb } from "@acor/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ agentId: z.string().min(1).max(128) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const { id } = await params;
  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) return badRequest("agentId is required.");

  const result = await addMember(principal.organizationId, id, parsed.data.agentId);
  if (!result.ok) {
    return NextResponse.json({ error: "NOT_ADDED", message: result.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const { id } = await params;
  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) return badRequest("agentId is required.");

  const removed = await removeMember(principal.organizationId, id, parsed.data.agentId);
  if (!removed) {
    return NextResponse.json({ error: "NOT_FOUND", message: "No such member." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
