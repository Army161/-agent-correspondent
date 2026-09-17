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
import { canAuthorizeOn } from "@/lib/identity/gates";
import { createRelay } from "@/lib/relay";
import { preCheckIntent } from "@/lib/security/evaluate";
import { openIncident } from "@/lib/security/incidents";

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

  // Who is behind the account, before what the intent says. On a network where
  // value actually moves, an unverified organization is refused here — cheaper
  // than the relay's checks, and a clearer answer for the caller.
  const gate = await canAuthorizeOn(principal.organizationId, intent.value.network);

  // Sentinel-5: a kill switch (global, this rail, or this agent) and the
  // account's own behavioural history, checked before the relay is touched
  // at all. A held or denied request here burns no nonce and leaves no
  // intent in the relay's store — see lib/security/evaluate.ts for why
  // mandate and bounds are not re-checked here.
  const sentinel = await preCheckIntent({
    organizationId: principal.organizationId,
    intent: intent.value,
    principalKind: principal.kind,
    verified: gate.allowed,
    verificationRemedy: gate.reason,
  });

  if (sentinel.decision.outcome === "DENY") {
    return NextResponse.json(
      {
        accepted: false,
        error: sentinel.decision.code ?? "DENIED",
        message: sentinel.decision.message,
        incidentId: sentinel.incidentId,
      },
      { status: sentinel.decision.code === "KILL_SWITCH_ENGAGED" ? 503 : 403 },
    );
  }
  if (sentinel.decision.outcome === "HOLD") {
    return NextResponse.json(
      {
        accepted: false,
        held: true,
        error: sentinel.decision.code ?? "HELD_FOR_REVIEW",
        message: sentinel.decision.message,
        incidentId: sentinel.incidentId,
      },
      { status: 202 },
    );
  }

  const result = await relay.submit(intent.value, parsed.data.signature, parsed.data.signer);

  if (!result.accepted) {
    // The relay itself is the authority on mandate and bounds, and a denial
    // whose code looks like an active attempt to forge or redirect an
    // authorization — not a routine "over budget" — is worth the same
    // evidence trail as a Sentinel-5 hold. Everything else (a mandate limit,
    // an expired intent) is normal traffic and is not incident-worthy.
    const attackShaped = new Set([
      "SIGNATURE_INVALID",
      "SIGNER_MISMATCH",
      "DESTINATION_SUBSTITUTION",
      "ASSET_SUBSTITUTION",
      "NETWORK_SUBSTITUTION",
      "NONCE_REUSED",
      "DOMAIN_MISMATCH",
      "CHAIN_MISMATCH",
      "CONTRACT_MISMATCH",
    ]);
    const firstCode = result.violations[0]?.code;
    if (firstCode && attackShaped.has(firstCode)) {
      await openIncident({
        organizationId: principal.organizationId,
        decision: {
          outcome: "DENY",
          layers: [],
          decidedBy: "BOUNDS",
          code: firstCode,
          message: result.violations[0]?.message ?? null,
        },
        summary: `Relay refused intent submission for agent ${intent.value.buyerAgentId} on ${firstCode}: this is the shape of a forged or redirected authorization attempt, not a routine limit.`,
      });
    }

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
