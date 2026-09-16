/**
 * Better Auth's HTTP surface: sign-in, sign-up, OAuth callbacks, verification,
 * password reset, passkeys, two-factor and session management.
 *
 * When authentication is unavailable — no database, or no signing secret — the
 * handler says so rather than returning a 500, so the sign-in page can explain
 * what is missing.
 */

import { NextResponse } from "next/server";

import { authUnavailableReason, getAuth } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const auth = getAuth();
  if (!auth) {
    return NextResponse.json(
      {
        error: "AUTH_UNAVAILABLE",
        message: authUnavailableReason() ?? "Authentication is not configured.",
      },
      { status: 503 },
    );
  }
  return auth.handler(request);
}

export const GET = handle;
export const POST = handle;
