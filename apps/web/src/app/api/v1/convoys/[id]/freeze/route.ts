/**
 * Freeze or unfreeze an entire convoy.
 *
 * Implemented as an AGENT-scope kill switch engaged for every member,
 * rather than a new kill-switch scope: each member's freeze stays
 * independently visible and auditable in the same kill-switch log
 * everything else uses, instead of a parallel mechanism a caller would have
 * to know to check separately.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { badRequest, readJson } from "@/lib/api";
import { requireFreshSession } from "@/lib/auth";
import { getConvoy } from "@/lib/convoy";
import { engageKillSwitch, disengageKillSwitch } from "@/lib/security/kill-switches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["FREEZE", "UNFREEZE"]),
  reason: z.string().min(3).max(500),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const fresh = await requireFreshSession();
  if (!fresh.ok) return NextResponse.json({ error: "NOT_AUTHORIZED", message: fresh.reason }, { status: 401 });

  const { id } = await params;
  const convoy = await getConvoy(fresh.user.organizationId, id);
  if (!convoy) {
    return NextResponse.json({ error: "NOT_FOUND", message: "No such convoy." }, { status: 404 });
  }

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) return badRequest("action and reason are required.");

  const apply = parsed.data.action === "FREEZE" ? engageKillSwitch : disengageKillSwitch;
  const results = await Promise.all(
    convoy.members.map((agentId) =>
      apply({
        scope: "AGENT",
        target: agentId,
        reason: `Convoy "${convoy.name}" ${parsed.data.action.toLowerCase()}: ${parsed.data.reason}`,
        actorUserId: fresh.user.id,
        actor: `user:${fresh.user.id}`,
        organizationId: fresh.user.organizationId,
      }),
    ),
  );

  return NextResponse.json({
    ok: results.every(Boolean),
    convoyId: id,
    action: parsed.data.action,
    membersAffected: convoy.members.length,
  });
}
