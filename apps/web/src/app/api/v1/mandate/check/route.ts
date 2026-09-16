/**
 * Test a spend against an agent's mandate.
 *
 * This is the same function the chat tools and the relay call. It is exposed
 * publicly so an integrator can ask "would this be allowed?" without attempting
 * it — and get exactly the answer the engine would give.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { economicMandates, fromNanosColumn, getDb, transactions, agents } from "@acor/db";
import {
  economicMandateSchema,
  evaluateMandate,
  formatUsd,
  parseUsd,
  summarizeDecision,
} from "@acor/core";

import { authenticateRequest, badRequest, notConnected, readJson, unauthorized, violations } from "@/lib/api";
import { recordAudit } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  agentId: z.string().min(1),
  amountUsd: z.string(),
  asset: z.string().default("USDC"),
  network: z.string().default("ARC"),
  counterpartyVerified: z.boolean().default(false),
  incursCredit: z.boolean().default(false),
  isTokenTrade: z.boolean().default(false),
  /** Live spendable balance in decimal USD, when the caller has read one. */
  availableBalanceUsd: z.string().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await authenticateRequest(request);
  if (!principal) return unauthorized();

  const db = getDb();
  if (!db) return notConnected();

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid request.");
  }

  const amount = parseUsd(parsed.data.amountUsd);
  if (!amount.ok) return violations(amount.violations, 400);

  // Scope check: an API key for one organization cannot probe another's agents.
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.id, parsed.data.agentId), eq(agents.organizationId, principal.organizationId)),
    )
    .limit(1);
  if (owned.length === 0) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such agent in this organization." },
      { status: 404 },
    );
  }

  const mandateRows = await db
    .select()
    .from(economicMandates)
    .where(eq(economicMandates.agentId, parsed.data.agentId))
    .orderBy(sql`${economicMandates.version} desc`)
    .limit(1);
  const mandateRow = mandateRows[0];

  const mandate = mandateRow
    ? economicMandateSchema.safeParse({
        dailySpendLimitUsd: formatUsd(fromNanosColumn(mandateRow.dailySpendLimitNanos)),
        maxTransactionUsd: formatUsd(fromNanosColumn(mandateRow.maxTransactionNanos)),
        minimumReserveUsd: formatUsd(fromNanosColumn(mandateRow.minimumReserveNanos)),
        unverifiedCounterpartyLimitUsd: formatUsd(
          fromNanosColumn(mandateRow.unverifiedCounterpartyLimitNanos),
        ),
        humanApprovalAboveUsd: formatUsd(fromNanosColumn(mandateRow.humanApprovalAboveNanos)),
        creditAllowed: mandateRow.creditAllowed,
        tokenTradingAllowed: mandateRow.tokenTradingAllowed,
        allowedAssets: mandateRow.allowedAssets,
        allowedNetworks: mandateRow.allowedNetworks,
      })
    : null;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const spendRows = await db
    .select({ amount: transactions.amountNanos, fee: transactions.feeNanos })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, parsed.data.agentId),
        eq(transactions.direction, "OUT"),
        gte(transactions.createdAt, startOfDay),
      ),
    );
  let spentToday = 0n;
  for (const row of spendRows) spentToday += fromNanosColumn(row.amount) + fromNanosColumn(row.fee);

  // An unstated balance is unknown, and unknown is a denial — the caller is not
  // permitted to omit it and have the engine assume funds exist.
  let availableBalance: bigint | null = null;
  if (parsed.data.availableBalanceUsd !== undefined) {
    const balance = parseUsd(parsed.data.availableBalanceUsd);
    if (!balance.ok) return violations(balance.violations, 400);
    availableBalance = balance.value;
  }

  const decision = evaluateMandate(
    mandate?.success ? mandate.data : null,
    {
      amount: amount.value,
      asset: parsed.data.asset,
      network: parsed.data.network,
      counterpartyVerified: parsed.data.counterpartyVerified,
      incursCredit: parsed.data.incursCredit,
      isTokenTrade: parsed.data.isTokenTrade,
    },
    { availableBalance, spentToday },
  );

  await recordAudit({
    organizationId: principal.organizationId,
    actor: `${principal.kind}:${principal.id}`,
    action: "mandate.check",
    subject: parsed.data.agentId,
    outcome: decision.decision,
    detail: { amount: formatUsd(amount.value), codes: decision.violations.map((v) => v.code) },
  });

  return NextResponse.json({
    decision: decision.decision,
    summary: summarizeDecision(decision),
    violations: decision.violations.map((v) => ({ code: v.code, message: v.message })),
    checks: decision.checks,
    remainingDailyLimit:
      decision.remainingDailyLimit === null ? null : formatUsd(decision.remainingDailyLimit),
  });
}
