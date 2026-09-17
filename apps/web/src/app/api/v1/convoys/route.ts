/**
 * Convoys.
 *
 * `GET` lists this organization's convoys. `POST` creates one, with a shared
 * daily USD pool limit stated up front -- in addition to, never instead of,
 * each member agent's own individual mandate.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseUsd } from "@acor/core";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { createConvoy, listConvoys } from "@/lib/convoy";
import { getDb } from "@acor/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const convoys = await listConvoys(principal.organizationId);
  return NextResponse.json({
    convoys: convoys.map((convoy) => ({
      ...convoy,
      dailyPoolLimitNanos: convoy.dailyPoolLimitNanos.toString(),
    })),
  });
}

const schema = z.object({
  name: z.string().min(1).max(120),
  dailyPoolLimitUsd: z.string(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const limit = parseUsd(parsed.data.dailyPoolLimitUsd);
  if (!limit.ok) {
    return badRequest(limit.violations[0]?.message ?? "dailyPoolLimitUsd is invalid.");
  }

  const convoy = await createConvoy(principal.organizationId, parsed.data.name, limit.value);
  if (!convoy) {
    return NextResponse.json({ error: "NOT_CREATED", message: "Could not create the convoy." }, { status: 503 });
  }

  return NextResponse.json(
    { ...convoy, dailyPoolLimitNanos: convoy.dailyPoolLimitNanos.toString() },
    { status: 201 },
  );
}
