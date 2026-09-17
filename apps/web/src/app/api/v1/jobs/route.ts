/**
 * Jobs.
 *
 * `POST` creates one, in DRAFT, priced but unfunded. `GET` lists this
 * organization's jobs (buyer or provider side).
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { formatUsd } from "@acor/core";

import { authenticateRequest, badRequest, notConnected, unauthorized, readJson } from "@/lib/api";
import { createJob } from "@/lib/jobs";
import { listJobs } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const view = await listJobs(principal.organizationId);
  if (view.state === "NOT_CONNECTED") return notConnected();
  const rows = view.state === "READY" ? view.data : [];
  return NextResponse.json({
    jobs: rows.map((job) => ({ ...job, escrow: job.escrow === null ? null : formatUsd(job.escrow) })),
  });
}

const schema = z.object({
  buyerAgentId: z.string().min(1).max(128),
  providerAgentId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  service: z.string().min(1).max(256),
  priceUsd: z.string(),
  evaluator: z.string().max(256).optional(),
  requestPayload: z.unknown().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const result = await createJob({ organizationId: principal.organizationId, ...parsed.data });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.code ?? "NOT_CREATED", message: result.error },
      { status: result.code === "NOT_FOUND" ? 404 : 400 },
    );
  }

  return NextResponse.json({ jobId: result.jobId, state: result.state }, { status: 201 });
}
