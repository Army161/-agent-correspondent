/**
 * Organization API keys.
 *
 * `POST` issues one and returns it exactly once. It requires a fresh,
 * signed-in session -- never an API key. A key that could mint more keys would
 * let a single leaked key make itself permanent: revoke it, and the copy it
 * minted first keeps working. `GET` lists keys without their secrets.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@acor/db";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { createApiKey, listApiKeys } from "@/lib/api-keys";
import { requireFreshSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const keys = await listApiKeys(principal.organizationId);
  return NextResponse.json({
    keys: keys.map((key) => ({
      ...key,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      revokedAt: key.revokedAt?.toISOString() ?? null,
    })),
  });
}

const schema = z.object({ name: z.string().trim().min(1).max(80) });

export async function POST(request: Request): Promise<NextResponse> {
  if (request.headers.get("authorization")) {
    return NextResponse.json(
      {
        error: "SESSION_REQUIRED",
        message: "API keys can only be issued from a signed-in session, never by another API key.",
      },
      { status: 403 },
    );
  }
  const fresh = await requireFreshSession();
  if (!fresh.ok) return NextResponse.json({ error: "NOT_AUTHORIZED", message: fresh.reason }, { status: 401 });
  if (!getDb()) return notConnected();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(`${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  const result = await createApiKey(fresh.user.organizationId, parsed.data.name, `session:${fresh.user.id}`);
  if (!result.ok) return NextResponse.json({ error: "NOT_CREATED", message: result.error }, { status: 400 });
  return NextResponse.json({ keyId: result.id, key: result.key }, { status: 201 });
}
