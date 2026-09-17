import { NextResponse } from "next/server";
import { z } from "zod";

import { formatUsd } from "@acor/core";

import { authenticateRequest, badRequest, notConnected, unauthorized, readJson } from "@/lib/api";
import { runClearing } from "@/lib/clearing";
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

const runSchema = z.object({
  asset: z.string().min(1).max(16).default("USDC"),
  mode: z.enum(["BILATERAL", "MULTILATERAL"]).default("BILATERAL"),
});

/**
 * Actually run a clearing cycle: net every OPEN entry for this organization
 * and asset, persist the cycle, and flip the consumed entries to NETTED. See
 * `lib/clearing.ts` for why this never marks anything SETTLED.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const body = await readJson(request);
  const parsed = runSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const result = await runClearing(
    principal.organizationId,
    parsed.data.asset.toUpperCase(),
    parsed.data.mode,
  );
  if (!result.ok) {
    return NextResponse.json({ error: "NOT_RUN", message: result.error }, { status: 409 });
  }

  const { cycle } = result;
  return NextResponse.json(
    {
      cycleId: cycle.cycleId,
      asset: cycle.asset,
      mode: cycle.mode,
      gross: formatUsd(cycle.grossTotal),
      net: formatUsd(cycle.netTotal),
      saved: formatUsd(cycle.savedTotal),
      savedTransfers: cycle.savedTransfers,
      entryCount: cycle.entryIds.length,
      instructionCount: cycle.instructions.length,
      proofHash: cycle.proofHash,
      instructions: cycle.instructions.map((instruction) => ({
        from: instruction.from,
        to: instruction.to,
        amount: formatUsd(instruction.amount),
        asset: instruction.asset,
      })),
      openedAt: cycle.openedAt.toISOString(),
    },
    { status: 201 },
  );
}
