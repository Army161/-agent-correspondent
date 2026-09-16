import { NextResponse } from "next/server";

import { getSettlementPlane, probeAll } from "@acor/adapters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live network capabilities.
 *
 * Probing happens on request so the answer reflects the network now, not at
 * boot. `UNKNOWN` means exactly that: not verified, and therefore not usable.
 */
export async function GET(): Promise<NextResponse> {
  await probeAll();
  const { capabilities } = getSettlementPlane();
  return NextResponse.json({
    capabilities: capabilities.list().map((capability) => ({
      id: capability.id,
      state: capability.state,
      source: capability.source,
      note: capability.note ?? null,
      checkedAt: capability.checkedAt?.toISOString() ?? null,
    })),
  });
}
