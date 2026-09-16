/**
 * Shared helpers for the public API.
 *
 * API keys are matched by hash and scoped to an organization. There is no
 * "anonymous but allowed" path: an economic endpoint either identifies the
 * caller or refuses.
 */

import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { apiKeys, getDb } from "@acor/db";
import { sha256Hex, type EconomicViolation } from "@acor/core";

import { currentUser } from "./auth";

export interface ApiPrincipal {
  readonly organizationId: string;
  readonly kind: "session" | "api_key";
  readonly id: string;
}

/**
 * Identify the caller from a session cookie or an API key.
 *
 * Keys are compared by SHA-256, because the plaintext key is never stored —
 * it is shown once, at creation.
 */
export async function authenticateRequest(request: Request): Promise<ApiPrincipal | null> {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const db = getDb();
    if (!db) return null;
    const token = header.slice(7).trim();
    if (token.length < 16) return null;
    const rows = await db
      .select({ id: apiKeys.id, organizationId: apiKeys.organizationId })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, sha256Hex(token)), isNull(apiKeys.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
    return { organizationId: row.organizationId, kind: "api_key", id: row.id };
  }

  const user = await currentUser();
  if (!user) return null;
  return { organizationId: user.organizationId, kind: "session", id: user.id };
}

export function unauthorized(): NextResponse {
  return NextResponse.json(
    {
      error: "UNAUTHENTICATED",
      message:
        "Provide a session cookie or an API key as `Authorization: Bearer <key>`. If this deployment has no database configured, no credential can be verified.",
    },
    { status: 401 },
  );
}

/** 422 with the full violation list — never just the first one. */
export function violations(list: readonly EconomicViolation[], status = 422): NextResponse {
  return NextResponse.json(
    {
      error: list[0]?.code ?? "REJECTED",
      violations: list.map((violation) => ({
        code: violation.code,
        message: violation.message,
        detail: violation.detail ?? null,
      })),
    },
    { status },
  );
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: "BAD_REQUEST", message }, { status: 400 });
}

export function notConnected(): NextResponse {
  return NextResponse.json(
    {
      error: "NOT_CONNECTED",
      message:
        "No database is configured for this deployment. Set DATABASE_URL and run the migrations in packages/db.",
    },
    { status: 503 },
  );
}

export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
