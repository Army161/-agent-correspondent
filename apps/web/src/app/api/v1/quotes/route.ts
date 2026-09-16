/**
 * Provider quotes, ranked on effective cost.
 *
 * The response includes the full cost breakdown for every provider, so a caller
 * can see why the winner won rather than being asked to trust a number.
 */

import { NextResponse } from "next/server";

import {
  agentCapabilities,
  agents,
  and,
  eq,
  fromNanosColumn,
  getDb,
} from "@acor/db";
import {
  explainRanking,
  formatUsd,
  matchProviders,
  normalizeProvider,
  parseUsd,
  rankProviders,
  type DiscoveredProvider,
} from "@acor/core";

import { authenticateRequest, notConnected, unauthorized, violations } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const db = getDb();
  if (!db) return notConnected();

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const capabilityId = url.searchParams.get("capabilityId");
  const maxPriceParam = url.searchParams.get("maxPriceUsd");
  const requireValidation = url.searchParams.get("requireValidation") === "true";

  let maxPrice: bigint | undefined;
  if (maxPriceParam) {
    const parsed = parseUsd(maxPriceParam);
    if (!parsed.ok) return violations(parsed.violations, 400);
    maxPrice = parsed.value;
  }

  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      erc8004: agents.erc8004AgentId,
      capabilityId: agentCapabilities.capabilityId,
      category: agentCapabilities.category,
      price: agentCapabilities.priceNanos,
      unit: agentCapabilities.unit,
      latencyMs: agentCapabilities.latencyMs,
      validationSupported: agentCapabilities.validationSupported,
    })
    .from(agentCapabilities)
    .innerJoin(agents, eq(agents.id, agentCapabilities.agentId))
    .where(and(eq(agents.organizationId, principal.organizationId), eq(agents.status, "ACTIVE")));

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    grouped.set(row.agentId, [...(grouped.get(row.agentId) ?? []), row]);
  }

  const providers: DiscoveredProvider[] = [];
  for (const [agentId, capabilities] of grouped) {
    const first = capabilities[0];
    if (!first) continue;
    const normalized = normalizeProvider({
      agentId,
      displayName: first.name,
      source: first.erc8004 ? "ERC8004" : "INTERNAL",
      verified: Boolean(first.erc8004),
      destination: agentId,
      settlementAssets: ["USDC"],
      networks: ["ARC", "MULEDGER"],
      rails: ["X402", "MULEDGER"],
      capabilities: capabilities.map((capability) => ({
        capabilityId: capability.capabilityId,
        category: capability.category,
        price: formatUsd(fromNanosColumn(capability.price)),
        unit: capability.unit,
        latencyMs: capability.latencyMs,
        validationSupported: capability.validationSupported,
      })),
    });
    if (normalized) providers.push(normalized);
  }

  const matches = matchProviders(providers, {
    ...(category ? { category: category as never } : {}),
    ...(capabilityId ? { capabilityId } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
    ...(requireValidation ? { requireValidation: true } : {}),
  });

  const ranked = rankProviders(matches, { ...(requireValidation ? { requireValidation: true } : {}) });

  return NextResponse.json({
    quotes: ranked.map((provider) => ({
      agentId: provider.agentId,
      displayName: provider.displayName,
      capabilityId: provider.capabilityId,
      price: formatUsd(provider.price),
      effectiveCost: formatUsd(provider.effectiveCost),
      latencyMs: provider.latencyMs,
      reputation: provider.reputation,
      verified: provider.verified,
      components: {
        price: formatUsd(provider.components.price),
        latencyPenalty: formatUsd(provider.components.latencyPenalty),
        failureRisk: formatUsd(provider.components.failureRisk),
        validationCost: formatUsd(provider.components.validationCost),
        counterpartyRisk: formatUsd(provider.components.counterpartyRisk),
      },
      explanation: explainRanking(provider),
    })),
    rankedBy: "effectiveCost",
  });
}
