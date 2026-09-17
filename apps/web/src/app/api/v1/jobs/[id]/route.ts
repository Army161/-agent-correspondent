/**
 * One job's detail.
 */

import { NextResponse } from "next/server";

import { formatUsd } from "@acor/core";

import { authenticateRequest, notConnected, unauthorized } from "@/lib/api";
import { getJob } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const { id } = await params;
  const view = await getJob(principal.organizationId, id);
  if (view.state === "NOT_CONNECTED") return notConnected();
  if (view.state === "EMPTY") {
    return NextResponse.json({ error: "NOT_FOUND", message: "No such job." }, { status: 404 });
  }
  if (view.state === "ERROR") {
    return NextResponse.json({ error: "QUERY_FAILED", message: view.reason }, { status: 500 });
  }
  return NextResponse.json({
    ...view.data,
    job: { ...view.data.job, escrow: view.data.job.escrow === null ? null : formatUsd(view.data.job.escrow) },
  });
}
