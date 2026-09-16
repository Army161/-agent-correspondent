/**
 * Agents API.
 *
 * Creating an agent creates its mandate in the same transaction. There is no
 * window in which an agent exists without a spending policy, because an agent
 * without a mandate that could later acquire one by default is a hole.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  agentCapabilities,
  agents,
  economicMandates,
  getDb,
  toNanosColumn,
} from "@acor/db";
import {
  DEFAULT_MANDATE,
  economicMandateSchema,
  MULEDGER_USD,
  newId,
  parseAmount,
} from "@acor/core";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized, violations } from "@/lib/api";
import { canCreateAgent } from "@/lib/billing/limits";
import { listAgents, recordAudit } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const view = await listAgents(principal.organizationId);
  if (view.state === "NOT_CONNECTED") return notConnected();
  if (view.state === "ERROR") {
    return NextResponse.json({ error: "QUERY_FAILED", message: view.reason }, { status: 500 });
  }
  return NextResponse.json({ agents: view.state === "READY" ? view.data : [] });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  provider: z.enum(["anthropic", "openai", "local"]).default("anthropic"),
  model: z.string().min(1).max(120),
  systemPrompt: z.string().max(20_000).optional(),
  mandate: z.record(z.string(), z.unknown()).optional(),
  capabilities: z
    .array(
      z.object({
        capabilityId: z.string().min(1).max(120),
        category: z.string().min(1).max(60),
        priceUsd: z.string(),
        unit: z.string().max(30).default("call"),
        latencyMs: z.number().int().min(0).default(0),
        validationSupported: z.boolean().default(false),
      }),
    )
    .max(50)
    .optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const db = getDb();
  if (!db) return notConnected();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  // The plan limit is checked here, against a server-side read of the
  // subscription, rather than in the UI. A limit the browser enforces is a
  // suggestion.
  const limit = await canCreateAgent(principal.organizationId);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "PLAN_LIMIT",
        message: limit.reason,
        plan: limit.planId,
        limit: limit.limit,
        current: limit.current,
      },
      { status: 402 },
    );
  }

  const mandateParse = economicMandateSchema.safeParse(parsed.data.mandate ?? DEFAULT_MANDATE);
  if (!mandateParse.success) {
    return badRequest(
      `mandate.${mandateParse.error.issues[0]?.path.join(".") ?? ""}: ${mandateParse.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const mandate = mandateParse.data;

  // Capability prices are quoted in US dollars, so they are parsed against the
  // μLedger's USD unit of account rather than against a rail asset. The asset
  // identity is stored with the price: a bare number is not a price.
  const capabilityRows: {
    capabilityId: string;
    category: string;
    price: bigint;
    unit: string;
    latencyMs: number;
    validationSupported: boolean;
  }[] = [];
  for (const capability of parsed.data.capabilities ?? []) {
    const price = parseAmount(capability.priceUsd, MULEDGER_USD, { allowNegative: false });
    if (!price.ok) return violations(price.violations, 400);
    capabilityRows.push({
      capabilityId: capability.capabilityId,
      category: capability.category,
      price: price.value.atomic,
      unit: capability.unit,
      latencyMs: capability.latencyMs,
      validationSupported: capability.validationSupported,
    });
  }

  const agentId = newId("agent");

  // An agent and its mandate are written together: at no point does a
  // spend-capable record exist without the policy that bounds it.
  await db.transaction(async (tx) => {
    await tx.insert(agents).values({
      id: agentId,
      organizationId: principal.organizationId,
      ownerUserId: principal.kind === "session" ? principal.id : null,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      provider: parsed.data.provider,
      model: parsed.data.model,
      systemPrompt: parsed.data.systemPrompt ?? null,
      status: "ACTIVE",
      allowedTools: [],
    });

    await tx.insert(economicMandates).values({
      id: newId("mandate"),
      agentId,
      dailySpendLimitNanos: toNanosColumn(mandate.dailySpendLimitUsd),
      maxTransactionNanos: toNanosColumn(mandate.maxTransactionUsd),
      minimumReserveNanos: toNanosColumn(mandate.minimumReserveUsd),
      unverifiedCounterpartyLimitNanos: toNanosColumn(mandate.unverifiedCounterpartyLimitUsd),
      humanApprovalAboveNanos: toNanosColumn(mandate.humanApprovalAboveUsd),
      creditAllowed: mandate.creditAllowed,
      tokenTradingAllowed: mandate.tokenTradingAllowed,
      allowedAssets: [...mandate.allowedAssets],
      allowedNetworks: [...mandate.allowedNetworks],
      version: 1,
      authorizedByUserId: principal.kind === "session" ? principal.id : null,
    });

    for (const capability of capabilityRows) {
      await tx.insert(agentCapabilities).values({
        id: newId("agent"),
        agentId,
        capabilityId: capability.capabilityId,
        category: capability.category,
        priceNanos: toNanosColumn(capability.price),
        priceAtomic: toNanosColumn(capability.price),
        priceAssetId: MULEDGER_USD,
        priceDecimals: 9,
        unit: capability.unit,
        latencyMs: capability.latencyMs,
        validationSupported: capability.validationSupported,
      });
    }
  });

  await recordAudit({
    organizationId: principal.organizationId,
    actor: `${principal.kind}:${principal.id}`,
    action: "agent.created",
    subject: agentId,
    outcome: "ALLOW",
    detail: { name: parsed.data.name, model: parsed.data.model },
  });

  return NextResponse.json({ agentId, mandateVersion: 1 }, { status: 201 });
}
