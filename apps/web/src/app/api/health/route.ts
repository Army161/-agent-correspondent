/**
 * Health endpoint.
 *
 * Reports what this deployment can actually do. It is deliberately blunt: a
 * platform with no database and no rails says so, rather than returning 200 OK
 * and implying it is ready to move money.
 */

import { NextResponse } from "next/server";

import { probeDatabase } from "@acor/db";
import { getSettlementPlane, probeAll } from "@acor/adapters";
import { serviceStates } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [database, adapters] = await Promise.all([probeDatabase(), probeAll()]);
  const { capabilities, configurationErrors, config } = getSettlementPlane();

  const ready = database.status === "CONNECTED" && configurationErrors.length === 0;

  return NextResponse.json(
    {
      status: ready ? "READY" : "DEGRADED",
      environment: config.production ? "production" : "development",
      database,
      services: serviceStates().map((service) => ({
        id: service.id,
        configured: service.configured,
        requires: service.requires,
      })),
      adapters: adapters.map((adapter) => ({
        adapter: adapter.adapter,
        status: adapter.status,
        detail: adapter.detail,
      })),
      capabilities: capabilities.list().map((capability) => ({
        id: capability.id,
        state: capability.state,
        source: capability.source,
      })),
      configurationErrors,
      checkedAt: new Date().toISOString(),
    },
    { status: ready ? 200 : 503 },
  );
}
