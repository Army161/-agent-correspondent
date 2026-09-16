/**
 * The deterministic tool surface exposed to the language model.
 *
 * Every tool here is read-only or compile-only. The model can discover
 * providers, rank them, test a spend against a mandate, compile a signable
 * intent and read the ledger. It cannot sign, cannot settle, cannot mutate a
 * mandate and cannot create an obligation.
 *
 * That is the boundary the whole product rests on: a prompt injection that
 * fully captures the model still cannot move a cent, because there is no tool
 * on the other side of this file that moves one.
 */

import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  agentCapabilities,
  agents,
  economicMandates,
  fromNanosColumn,
  getDb,
  muledgerEntries,
  transactions,
} from "@acor/db";
import {
  compileIntent,
  describeIntent,
  economicMandateSchema,
  evaluateMandate,
  explainRanking,
  formatUsd,
  matchProviders,
  MuLedger,
  normalizeProvider,
  parseUsd,
  rankProviders,
  routeIntent,
  summarizeDecision,
  type DiscoveredProvider,
  type EconomicMandate,
  type LedgerEntry,
  type Nanos,
} from "@acor/core";
import { getSettlementPlane } from "@acor/adapters";

export interface ToolContext {
  readonly organizationId: string;
  readonly userId: string;
}

const NO_DB = {
  error: "NOT_CONNECTED",
  message:
    "No database is configured for this deployment, so the platform has no agents, balances or history to read. Set DATABASE_URL and run the migrations.",
} as const;

async function loadProviders(organizationId: string): Promise<DiscoveredProvider[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      status: agents.status,
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
    .where(and(eq(agents.organizationId, organizationId), eq(agents.status, "ACTIVE")));

  const byAgent = new Map<string, { name: string; erc8004: string | null; caps: typeof rows }>();
  for (const row of rows) {
    const bucket = byAgent.get(row.agentId) ?? { name: row.name, erc8004: row.erc8004, caps: [] };
    bucket.caps.push(row);
    byAgent.set(row.agentId, bucket);
  }

  const providers: DiscoveredProvider[] = [];
  for (const [agentId, bucket] of byAgent) {
    const normalized = normalizeProvider({
      agentId,
      displayName: bucket.name,
      source: bucket.erc8004 ? "ERC8004" : "INTERNAL",
      // An agent is "verified" only when it carries a registry identity.
      verified: Boolean(bucket.erc8004),
      destination: agentId,
      settlementAssets: ["USDC"],
      networks: ["ARC", "MULEDGER"],
      rails: ["X402", "MULEDGER"],
      capabilities: bucket.caps.map((cap) => ({
        capabilityId: cap.capabilityId,
        category: cap.category,
        price: formatUsd(fromNanosColumn(cap.price)),
        unit: cap.unit,
        latencyMs: cap.latencyMs,
        validationSupported: cap.validationSupported,
      })),
    });
    if (normalized) providers.push(normalized);
  }
  return providers;
}

async function loadMandate(agentId: string): Promise<EconomicMandate | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(economicMandates)
    .where(eq(economicMandates.agentId, agentId))
    .orderBy(sql`${economicMandates.version} desc`)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const parsed = economicMandateSchema.safeParse({
    dailySpendLimitUsd: formatUsd(fromNanosColumn(row.dailySpendLimitNanos)),
    maxTransactionUsd: formatUsd(fromNanosColumn(row.maxTransactionNanos)),
    minimumReserveUsd: formatUsd(fromNanosColumn(row.minimumReserveNanos)),
    unverifiedCounterpartyLimitUsd: formatUsd(fromNanosColumn(row.unverifiedCounterpartyLimitNanos)),
    humanApprovalAboveUsd: formatUsd(fromNanosColumn(row.humanApprovalAboveNanos)),
    creditAllowed: row.creditAllowed,
    tokenTradingAllowed: row.tokenTradingAllowed,
    allowedAssets: row.allowedAssets,
    allowedNetworks: row.allowedNetworks,
  });
  return parsed.success ? parsed.data : null;
}

async function spentToday(agentId: string): Promise<Nanos | null> {
  const db = getDb();
  if (!db) return null;
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ amount: transactions.amountNanos, fee: transactions.feeNanos })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        eq(transactions.direction, "OUT"),
        gte(transactions.createdAt, startOfDay),
      ),
    );
  let total = 0n;
  for (const row of rows) total += fromNanosColumn(row.amount) + fromNanosColumn(row.fee);
  return total;
}

/**
 * The tool set handed to the model.
 *
 * Annotated as `ToolSet` rather than inferred: pnpm's nested layout makes the
 * inferred type unnameable across the workspace boundary.
 */
export function buildTools(context: ToolContext): ToolSet {
  return {
    discover_providers: tool({
      description:
        "Find agents that can perform a service, filtered by category, maximum unit price and latency. Returns normalized providers with their real prices from the database.",
      inputSchema: z.object({
        category: z
          .enum([
            "research",
            "summarization",
            "extraction",
            "classification",
            "generation",
            "analysis",
            "validation",
            "execution",
            "other",
          ])
          .optional(),
        maxPriceUsd: z.string().optional().describe("Decimal USD string, e.g. '0.10'"),
        maxLatencyMs: z.number().int().positive().optional(),
        requireValidation: z.boolean().optional(),
      }),
      execute: async (input) => {
        if (!getDb()) return NO_DB;
        const providers = await loadProviders(context.organizationId);
        if (providers.length === 0) {
          return {
            providers: [],
            message:
              "No active agents with priced capabilities exist in this organization yet. Create one on the Agents page.",
          };
        }
        const maxPrice = input.maxPriceUsd ? parseUsd(input.maxPriceUsd) : null;
        if (maxPrice && !maxPrice.ok) {
          return { error: "INVALID_AMOUNT", message: maxPrice.violations[0]?.message };
        }
        const matches = matchProviders(providers, {
          ...(input.category ? { category: input.category } : {}),
          ...(maxPrice?.ok ? { maxPrice: maxPrice.value } : {}),
          ...(input.maxLatencyMs ? { maxLatencyMs: input.maxLatencyMs } : {}),
          ...(input.requireValidation ? { requireValidation: true } : {}),
        });
        const ranked = rankProviders(matches, {
          ...(input.requireValidation ? { requireValidation: true } : {}),
        });
        return {
          providers: ranked.map((provider) => ({
            agentId: provider.agentId,
            displayName: provider.displayName,
            capabilityId: provider.capabilityId,
            price: formatUsd(provider.price, { symbol: true }),
            effectiveCost: formatUsd(provider.effectiveCost, { symbol: true }),
            latencyMs: provider.latencyMs,
            reputation: provider.reputation,
            verified: provider.verified,
            ranking: explainRanking(provider),
          })),
          note: "Ranked on effective cost (price + latency + failure risk + validation + counterparty risk), not sticker price.",
        };
      },
    }),

    check_mandate: tool({
      description:
        "Test a proposed spend against an agent's economic mandate. This is the deterministic policy engine; its decision is final and cannot be overridden.",
      inputSchema: z.object({
        agentId: z.string(),
        amountUsd: z.string().describe("Decimal USD string, e.g. '0.025'"),
        asset: z.string().default("USDC"),
        network: z.string().default("ARC"),
        counterpartyVerified: z.boolean().default(false),
      }),
      execute: async (input) => {
        if (!getDb()) return NO_DB;
        const amount = parseUsd(input.amountUsd);
        if (!amount.ok) {
          return { error: "INVALID_AMOUNT", message: amount.violations[0]?.message };
        }
        const mandate = await loadMandate(input.agentId);
        const spent = await spentToday(input.agentId);
        const decision = evaluateMandate(
          mandate,
          {
            amount: amount.value,
            asset: input.asset,
            network: input.network,
            counterpartyVerified: input.counterpartyVerified,
          },
          // Balance is unknown without a live wallet read, and the engine
          // denies on unknown balance rather than assuming funds exist.
          { availableBalance: null, spentToday: spent },
        );
        return {
          decision: decision.decision,
          summary: summarizeDecision(decision),
          violations: decision.violations.map((v) => ({ code: v.code, message: v.message })),
          checks: decision.checks,
        };
      },
    }),

    compile_intent: tool({
      description:
        "Compile a signable EconomicIntent. This produces an authorization for the user to review and sign; it does not spend anything and does not commit the platform to anything.",
      inputSchema: z.object({
        buyerAgentId: z.string(),
        providerAgentId: z.string(),
        service: z.string(),
        maxSpendUsd: z.string(),
        minReceiveUsd: z.string().optional(),
        settlementAsset: z.enum(["USDC", "RLUSD", "EURC", "XRP"]).default("USDC"),
        network: z.enum(["ARC", "ARC_TESTNET", "XRPL", "XRPL_TESTNET", "MULEDGER"]).default("ARC"),
        ttlSeconds: z.number().int().min(30).max(3600).default(300),
      }),
      execute: async (input) => {
        if (!getDb()) return NO_DB;
        const chainId = Number(process.env.ARC_CHAIN_ID ?? 5042);
        const verifier = process.env.ARC_INTENT_VERIFIER_ADDRESS;
        if (!verifier) {
          return {
            error: "CAPABILITY_UNAVAILABLE",
            message:
              "No intent verifier contract is configured (ARC_INTENT_VERIFIER_ADDRESS), so an intent cannot be bound to a contract. Nothing can be signed until one is deployed.",
          };
        }
        const compiled = compileIntent(
          {
            buyerAgentId: input.buyerAgentId,
            providerAgentId: input.providerAgentId,
            service: input.service,
            servicePayload: { service: input.service },
            maxSpend: input.maxSpendUsd,
            minReceive: input.minReceiveUsd ?? "0",
            settlementAsset: input.settlementAsset,
            allowedRails: input.network === "MULEDGER" ? ["MULEDGER"] : ["X402"],
            network: input.network,
            destination: input.providerAgentId,
            evaluator: "evaluator.default.v1",
            chainId,
            verifyingContract: verifier,
            ttlSeconds: input.ttlSeconds,
          },
          new Date(),
        );
        if (!compiled.ok) {
          return {
            error: "INTENT_MALFORMED",
            violations: compiled.violations.map((v) => ({ code: v.code, message: v.message })),
          };
        }
        return { intent: describeIntent(compiled.value), status: "AWAITING_SIGNATURE" };
      },
    }),

    route_payment: tool({
      description:
        "Ask the economic router which rail, mechanism and settlement timing a payment should use. Only routes whose network primitives are verified live are returned.",
      inputSchema: z.object({
        buyerAgentId: z.string(),
        providerAgentId: z.string(),
        amountUsd: z.string(),
        asynchronous: z.boolean().default(false),
        requiresEvaluation: z.boolean().default(false),
        recurringCounterparty: z.boolean().default(false),
      }),
      execute: async (input) => {
        const amount = parseUsd(input.amountUsd);
        if (!amount.ok) {
          return { error: "INVALID_AMOUNT", message: amount.violations[0]?.message };
        }
        const { capabilities } = getSettlementPlane();
        const decision = routeIntent(
          {
            buyerAgentId: input.buyerAgentId,
            providerAgentId: input.providerAgentId,
            amount: amount.value,
            settlementAsset: "USDC",
            buyerNetwork: "ARC",
            providerNetwork: "ARC",
            asynchronous: input.asynchronous,
            requiresEvaluation: input.requiresEvaluation,
            recurringCounterparty: input.recurringCounterparty,
            counterpartyVerified: false,
          },
          capabilities,
        );
        if (!decision.ok) {
          return {
            error: "NO_ELIGIBLE_ROUTE",
            violations: decision.violations.map((v) => ({ code: v.code, message: v.message })),
          };
        }
        return {
          rail: decision.value.plan.rail,
          mechanism: decision.value.plan.mechanism,
          network: decision.value.plan.network,
          timing: decision.value.plan.timing,
          validation: decision.value.plan.validation,
          rationale: decision.value.plan.rationale,
          rejected: decision.value.rejected,
        };
      },
    }),

    ledger_summary: tool({
      description:
        "Read the mu-ledger: outstanding obligations for the organization, and what bilateral netting would reduce them to.",
      inputSchema: z.object({ asset: z.string().default("USDC") }),
      execute: async (input) => {
        const db = getDb();
        if (!db) return NO_DB;
        const rows = await db
          .select()
          .from(muledgerEntries)
          .where(
            and(
              eq(muledgerEntries.organizationId, context.organizationId),
              eq(muledgerEntries.asset, input.asset.toUpperCase()),
              eq(muledgerEntries.state, "OPEN"),
            ),
          );
        if (rows.length === 0) {
          return { openObligations: 0, message: "No open obligations on the mu-ledger." };
        }
        const entries: LedgerEntry[] = rows.map((row) => ({
          entryId: row.id,
          debtorAgentId: row.debtorAgentId,
          creditorAgentId: row.creditorAgentId,
          amount: fromNanosColumn(row.amountNanos),
          asset: row.asset,
          service: row.service,
          intentId: row.intentId,
          receiptId: row.receiptId,
          createdAt: row.createdAt,
          state: row.state,
          idempotencyKey: row.idempotencyKey,
        }));
        const ledger = MuLedger.hydrate(entries);
        return {
          openObligations: entries.length,
          gross: formatUsd(ledger.gross(input.asset), { symbol: true }),
          asset: input.asset.toUpperCase(),
        };
      },
    }),

    spend_report: tool({
      description:
        "Report what an agent has spent so far today, from settled transactions. Returns null when there is no data rather than zero.",
      inputSchema: z.object({ agentId: z.string() }),
      execute: async (input) => {
        if (!getDb()) return NO_DB;
        const spent = await spentToday(input.agentId);
        if (spent === null) return NO_DB;
        return {
          agentId: input.agentId,
          spentTodayUsd: formatUsd(spent, { symbol: true }),
          since: new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString(),
        };
      },
    }),
  };
}
