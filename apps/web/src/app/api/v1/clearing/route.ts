import { NextResponse } from "next/server";

import { formatUsd } from "@acor/core";

import { authenticateRequest, notConnected, unauthorized } from "@/lib/api";
import { getClearing } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const asset = new URL(request.url).searchParams.get("asset") ?? "USDC";
  const view = await getClearing(principal.organizationId, asset);

  if (view.state === "NOT_CONNECTED") return notConnected();
  if (view.state === "ERROR") {
    return NextResponse.json({ error: "QUERY_FAILED", message: view.reason }, { status: 500 });
  }
  if (view.state === "EMPTY") {
    return NextResponse.json({ asset, openEntries: 0, gross: null, projected: null, cycles: [] });
  }

  const { grossTotal, openEntries, projected, recentCycles } = view.data;

  return NextResponse.json({
    asset,
    openEntries,
    gross: formatUsd(grossTotal),
    projected: projected
      ? {
          mode: projected.mode,
          gross: formatUsd(projected.grossTotal),
          net: formatUsd(projected.netTotal),
          saved: formatUsd(projected.savedTotal),
          savedTransfers: projected.savedTransfers,
          proofHash: projected.proofHash,
          instructions: projected.instructions.map((instruction) => ({
            from: instruction.from,
            to: instruction.to,
            amount: formatUsd(instruction.amount),
            asset: instruction.asset,
          })),
        }
      : null,
    cycles: recentCycles.map((cycle) => ({
      id: cycle.id,
      mode: cycle.mode,
      asset: cycle.asset,
      gross: formatUsd(cycle.gross),
      net: formatUsd(cycle.net),
      entryCount: cycle.entryCount,
      instructionCount: cycle.instructionCount,
      proofHash: cycle.proofHash,
      openedAt: cycle.openedAt.toISOString(),
      settledAt: cycle.settledAt?.toISOString() ?? null,
    })),
  });
}
