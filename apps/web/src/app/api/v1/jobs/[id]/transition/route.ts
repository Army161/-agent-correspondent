/**
 * Advance a job through its lifecycle.
 *
 * One endpoint for every transition (QUOTE, FUND, START, SUBMIT, EVALUATE,
 * PASS, REJECT, DISPUTE, RESOLVE_FOR_PROVIDER, RESOLVE_FOR_BUYER, SETTLE,
 * CANCEL) rather than one route per verb: the legality of a transition is a
 * property of the state machine in `@acor/core`, checked once, not
 * re-implemented per endpoint. See lib/jobs.ts for what FUND and SETTLE do
 * to money.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized } from "@/lib/api";
import { transitionJob } from "@/lib/jobs";
import { getDb } from "@acor/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  transition: z.enum([
    "QUOTE",
    "FUND",
    "START",
    "SUBMIT",
    "EVALUATE",
    "PASS",
    "REJECT",
    "DISPUTE",
    "RESOLVE_FOR_PROVIDER",
    "RESOLVE_FOR_BUYER",
    "SETTLE",
    "CANCEL",
  ]),
  intentId: z.string().max(128).optional(),
  resultHash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
  deliverableUri: z.string().max(2000).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();
  if (!getDb()) return notConnected();

  const { id } = await params;
  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const result = await transitionJob({
    organizationId: principal.organizationId,
    jobId: id,
    transition: parsed.data.transition,
    actor: `${principal.kind}:${principal.id}`,
    intentId: parsed.data.intentId,
    resultHash: parsed.data.resultHash,
    deliverableUri: parsed.data.deliverableUri,
  });

  if (!result.ok) {
    const status =
      result.code === "NOT_FOUND"
        ? 404
        : result.code === "NOT_AUTHORIZED"
          ? 403
          : result.code === "ILLEGAL_JOB_TRANSITION"
            ? 409
            : 400;
    return NextResponse.json({ error: result.code ?? "NOT_APPLIED", message: result.error }, { status });
  }

  return NextResponse.json({ jobId: result.jobId, state: result.state });
}
