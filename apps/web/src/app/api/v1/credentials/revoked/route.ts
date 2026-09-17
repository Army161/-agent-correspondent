/**
 * The revocation list.
 *
 * Public and unauthenticated, because a verifier checking one of our
 * credentials is by definition not one of our customers. It contains
 * credential ids and nothing else — no agent, no organization, no reason. A
 * revocation list is not a place to publish why somebody was cut off.
 */

import { NextResponse } from "next/server";

import { revokedCredentialIds } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const revoked = await revokedCredentialIds();
  return NextResponse.json(
    { revoked, asOf: new Date().toISOString() },
    {
      // Short, not zero. A verifier should not have to hit the origin for
      // every check, and a revocation that takes a minute to propagate is
      // better than a list nobody can afford to fetch.
      headers: { "cache-control": "public, max-age=60" },
    },
  );
}
