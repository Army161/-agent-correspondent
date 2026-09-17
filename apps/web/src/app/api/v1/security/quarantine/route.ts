/**
 * Provider and integration quarantine.
 *
 * Platform-wide: a quarantined provider is quarantined for every
 * organization, so only a platform operator may set or lift one.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { badRequest, readJson } from "@/lib/api";
import { requireFreshSession } from "@/lib/auth";
import { isPlatformOperator, platformOperatorsConfigured } from "@/lib/security/operators";
import { liftQuarantine, listQuarantines, quarantineProvider } from "@/lib/security/quarantine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const fresh = await requireFreshSession();
  if (!fresh.ok) return NextResponse.json({ error: "NOT_AUTHORIZED", message: fresh.reason }, { status: 401 });
  return NextResponse.json({ quarantined: await listQuarantines() });
}

const schema = z.object({
  providerId: z.string().min(1).max(96),
  action: z.enum(["QUARANTINE", "LIFT"]),
  reason: z.string().min(3).max(500).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const fresh = await requireFreshSession();
  if (!fresh.ok) return NextResponse.json({ error: "NOT_AUTHORIZED", message: fresh.reason }, { status: 401 });

  if (!platformOperatorsConfigured() || !isPlatformOperator(fresh.user.email)) {
    return NextResponse.json(
      {
        error: "NOT_A_PLATFORM_OPERATOR",
        message: platformOperatorsConfigured()
          ? "This account is not on the platform operator allowlist."
          : "No platform operators are configured on this deployment (PLATFORM_OPERATOR_EMAILS).",
      },
      { status: 403 },
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

  const actor = `user:${fresh.user.id}`;
  const applied =
    parsed.data.action === "QUARANTINE"
      ? await quarantineProvider(
          parsed.data.providerId,
          parsed.data.reason ?? "no reason given",
          fresh.user.id,
          actor,
        )
      : await liftQuarantine(parsed.data.providerId, fresh.user.id, actor);

  if (!applied) {
    return NextResponse.json({ error: "NOT_APPLIED" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, providerId: parsed.data.providerId, action: parsed.data.action });
}
