/**
 * Submit a signed EconomicIntent to the relay.
 *
 * This is the point at which an authorization becomes real. Everything before
 * it — compiling, quoting, ranking — commits nobody to anything.
 *
 * The relay re-checks everything: structure, expiry, nonce, provider state and
 * payout address, the buyer's mandate, the signature, and whether the signer is
 * entitled to commit that agent's money. A nonce is burned only once every
 * other check has passed, so a rejected submission does not consume a nonce the
 * user still holds a valid signature for.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseIntent } from "@acor/core";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized, violations } from "@/lib/api";
import { createRelay } from "@/lib/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  intent: z.record(z.string(), z.unknown()),
  signature: z.string().min(4).max(512),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "signer must be a 20-byte hex address"),
});

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const relay = createRelay({ organizationId: principal.organizationId });
  if (!relay) return notConnected();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const intent = parseIntent(parsed.data.intent);
  if (!intent.ok) return violations(intent.violations);

  const result = await relay.submit(intent.value, parsed.data.signature, parsed.data.signer);

  if (!result.accepted) {
    return NextResponse.json(
      {
        accepted: false,
        intentId: result.intentId,
        hash: result.hash,
        error: result.violations[0]?.code ?? "REJECTED",
        violations: result.violations.map((violation) => ({
          code: violation.code,
          message: violation.message,
        })),
        ...(result.mandate
          ? {
              mandate: {
                decision: result.mandate.decision,
                checks: result.mandate.checks,
              },
            }
          : {}),
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    accepted: true,
    intentId: result.intentId,
    hash: result.hash,
    status: "OPEN",
    ...(result.mandate ? { mandate: { decision: result.mandate.decision } } : {}),
  });
}
