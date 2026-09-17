/**
 * Security incidents.
 *
 * `GET` lists this organization's incidents plus, for platform operators,
 * platform-wide ones (organizationId null). `POST` advances an incident's
 * status — CONTAINED or RESOLVED — which requires a fresh session for the
 * same reason engaging a kill switch does.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { desc, eq, getDb, securityIncidents } from "@acor/db";

import { badRequest, readJson } from "@/lib/api";
import { requireFreshSession } from "@/lib/auth";
import { advanceIncident } from "@/lib/security/incidents";
import { isPlatformOperator } from "@/lib/security/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const fresh = await requireFreshSession();
  if (!fresh.ok) return NextResponse.json({ error: "NOT_AUTHORIZED", message: fresh.reason }, { status: 401 });

  const db = getDb();
  if (!db) return NextResponse.json({ incidents: [] });

  const operator = isPlatformOperator(fresh.user.email);
  const rows = await db
    .select()
    .from(securityIncidents)
    .where(operator ? undefined : eq(securityIncidents.organizationId, fresh.user.organizationId))
    .orderBy(desc(securityIncidents.createdAt))
    .limit(200);

  return NextResponse.json({ incidents: rows, isOperator: operator });
}

const schema = z.object({
  incidentId: z.string().min(3).max(128),
  status: z.enum(["CONTAINED", "RESOLVED"]),
  note: z.string().max(2000).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const fresh = await requireFreshSession();
  if (!fresh.ok) return NextResponse.json({ error: "NOT_AUTHORIZED", message: fresh.reason }, { status: 401 });

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 503 });

  const operator = isPlatformOperator(fresh.user.email);
  const rows = await db
    .select({ organizationId: securityIncidents.organizationId })
    .from(securityIncidents)
    .where(eq(securityIncidents.id, parsed.data.incidentId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ error: "NOT_FOUND", message: "No such incident." }, { status: 404 });
  }
  // A platform-wide incident (organizationId null) may only be advanced by an
  // operator; an org-scoped one only by that organization's own member.
  const allowed =
    row.organizationId === null ? operator : row.organizationId === fresh.user.organizationId;
  if (!allowed) {
    return NextResponse.json({ error: "NOT_FOUND", message: "No such incident." }, { status: 404 });
  }

  const applied = await advanceIncident(
    parsed.data.incidentId,
    parsed.data.status,
    fresh.user.id,
    parsed.data.note ?? null,
  );
  if (!applied) {
    return NextResponse.json(
      { error: "NOT_APPLIED", message: "Status must move forward: OPEN -> CONTAINED -> RESOLVED." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, incidentId: parsed.data.incidentId, status: parsed.data.status });
}
