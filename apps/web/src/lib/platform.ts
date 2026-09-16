/**
 * Platform data access.
 *
 * Every function returns a `DataView`: either live data, or an explicit reason
 * why there is none. Screens render the reason. Nothing in this file can
 * produce a number that did not come from the database or a live network read
 * (PRODUCT_SPEC §39).
 */

import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentCapabilities,
  agents,
  agentWallets,
  auditLogs,
  clearingCycles,
  economicMandates,
  economicIntents,
  economicReceipts,
  fromNanosColumn,
  getDb,
  isDatabaseConfigured,
  jobs,
  muledgerEntries,
  reputationEvents,
  transactions,
  type Database,
} from "@acor/db";
import {
  computeReputation,
  MuLedger,
  netBilateral,
  type ClearingCycle,
  type EconomicMandate,
  type LedgerEntry,
  type Nanos,
  type ReputationEvent,
  type ReputationSnapshot,
} from "@acor/core";

export type DataView<T> =
  | { readonly state: "READY"; readonly data: T }
  | { readonly state: "EMPTY" }
  | { readonly state: "NOT_CONNECTED"; readonly reason: string }
  | { readonly state: "ERROR"; readonly reason: string };

const NOT_CONNECTED: DataView<never> = {
  state: "NOT_CONNECTED",
  reason: "No database is configured. Set DATABASE_URL and run the migrations in packages/db.",
};

async function withDb<T>(run: (db: Database) => Promise<DataView<T>>): Promise<DataView<T>> {
  if (!isDatabaseConfigured()) return NOT_CONNECTED;
  const db = getDb();
  if (!db) return NOT_CONNECTED;
  try {
    return await run(db);
  } catch (error) {
    return {
      state: "ERROR",
      reason: error instanceof Error ? error.message : "database query failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly provider: string;
  readonly model: string;
  readonly status: "ACTIVE" | "PAUSED" | "DISABLED";
  readonly capabilityCount: number;
  readonly walletCount: number;
  readonly hasMandate: boolean;
  readonly createdAt: Date;
}

export async function listAgents(organizationId: string): Promise<DataView<AgentSummary[]>> {
  return withDb<AgentSummary[]>(async (db) => {
    // Counted with joins rather than correlated subqueries: Drizzle renders a
    // column interpolated into a `sql` subquery without its table
    // qualification, so `where agent_id = id` silently resolves against the
    // inner table and every count comes back zero. COUNT(DISTINCT ...) keeps
    // the three joins from multiplying each other.
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        description: agents.description,
        provider: agents.provider,
        model: agents.model,
        status: agents.status,
        createdAt: agents.createdAt,
        capabilityCount: sql<number>`count(distinct ${agentCapabilities.id})`,
        walletCount: sql<number>`count(distinct ${agentWallets.id})`,
        mandateCount: sql<number>`count(distinct ${economicMandates.id})`,
      })
      .from(agents)
      .leftJoin(agentCapabilities, eq(agentCapabilities.agentId, agents.id))
      .leftJoin(agentWallets, eq(agentWallets.agentId, agents.id))
      .leftJoin(economicMandates, eq(economicMandates.agentId, agents.id))
      .where(eq(agents.organizationId, organizationId))
      .groupBy(agents.id)
      .orderBy(desc(agents.createdAt));

    if (rows.length === 0) return { state: "EMPTY" };

    return {
      state: "READY",
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        provider: row.provider,
        model: row.model,
        status: row.status,
        capabilityCount: Number(row.capabilityCount),
        walletCount: Number(row.walletCount),
        hasMandate: Number(row.mandateCount) > 0,
        createdAt: row.createdAt,
      })),
    };
  });
}

export interface AgentDetail {
  readonly agent: AgentSummary;
  readonly capabilities: {
    capabilityId: string;
    category: string;
    price: Nanos;
    unit: string;
    latencyMs: number;
    validationSupported: boolean;
  }[];
  readonly wallets: {
    network: string;
    address: string;
    custody: string;
    isPrimary: boolean;
  }[];
  readonly mandate: (EconomicMandate & { version: number }) | null;
  readonly reputation: ReputationSnapshot;
  readonly ledger: { receivable: Nanos; payable: Nanos; net: Nanos };
}

export async function getAgent(
  organizationId: string,
  agentId: string,
): Promise<DataView<AgentDetail>> {
  return withDb<AgentDetail>(async (db) => {
    const agentRows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.organizationId, organizationId), eq(agents.id, agentId)))
      .limit(1);
    const agent = agentRows[0];
    if (!agent) return { state: "EMPTY" };

    const [capabilityRows, walletRows, mandateRows, reputationRows, ledgerRows] = await Promise.all([
      db.select().from(agentCapabilities).where(eq(agentCapabilities.agentId, agentId)),
      db.select().from(agentWallets).where(eq(agentWallets.agentId, agentId)),
      db
        .select()
        .from(economicMandates)
        .where(eq(economicMandates.agentId, agentId))
        .orderBy(desc(economicMandates.version))
        .limit(1),
      db.select().from(reputationEvents).where(eq(reputationEvents.agentId, agentId)),
      db
        .select()
        .from(muledgerEntries)
        .where(
          and(
            eq(muledgerEntries.organizationId, organizationId),
            inArray(muledgerEntries.state, ["OPEN", "NETTED"]),
          ),
        ),
    ]);

    const mandateRow = mandateRows[0];
    const mandate = mandateRow
      ? {
          dailySpendLimitUsd: fromNanosColumn(mandateRow.dailySpendLimitNanos),
          maxTransactionUsd: fromNanosColumn(mandateRow.maxTransactionNanos),
          minimumReserveUsd: fromNanosColumn(mandateRow.minimumReserveNanos),
          unverifiedCounterpartyLimitUsd: fromNanosColumn(
            mandateRow.unverifiedCounterpartyLimitNanos,
          ),
          humanApprovalAboveUsd: fromNanosColumn(mandateRow.humanApprovalAboveNanos),
          creditAllowed: mandateRow.creditAllowed,
          tokenTradingAllowed: mandateRow.tokenTradingAllowed,
          allowedAssets: mandateRow.allowedAssets as EconomicMandate["allowedAssets"],
          allowedNetworks: mandateRow.allowedNetworks as EconomicMandate["allowedNetworks"],
          version: mandateRow.version,
        }
      : null;

    const events: ReputationEvent[] = reputationRows.map((row) => ({
      eventId: row.id,
      agentId: row.agentId,
      counterpartyAgentId: row.counterpartyAgentId,
      kind: row.kind as ReputationEvent["kind"],
      value: fromNanosColumn(row.valueNanos),
      occurredAt: row.occurredAt,
      receiptId: row.receiptId,
    }));

    const ledger = MuLedger.hydrate(ledgerRows.map(toLedgerEntry));

    return {
      state: "READY",
      data: {
        agent: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          provider: agent.provider,
          model: agent.model,
          status: agent.status,
          capabilityCount: capabilityRows.length,
          walletCount: walletRows.length,
          hasMandate: mandate !== null,
          createdAt: agent.createdAt,
        },
        capabilities: capabilityRows.map((row) => ({
          capabilityId: row.capabilityId,
          category: row.category,
          price: fromNanosColumn(row.priceNanos),
          unit: row.unit,
          latencyMs: row.latencyMs,
          validationSupported: row.validationSupported,
        })),
        wallets: walletRows.map((row) => ({
          network: row.network,
          address: row.address,
          custody: row.custody,
          isPrimary: row.isPrimary,
        })),
        mandate,
        reputation: computeReputation(agentId, events),
        ledger: ledger.position(agentId, "USDC"),
      },
    };
  });
}

function toLedgerEntry(row: typeof muledgerEntries.$inferSelect): LedgerEntry {
  return {
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
    ...(row.cycleId ? { cycleId: row.cycleId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobDetail {
  readonly job: JobSummary;
  readonly intentId: string | null;
  readonly resultHash: string | null;
  readonly evaluator: string | null;
}

export interface JobSummary {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly state: string;
  readonly buyerAgentId: string;
  readonly providerAgentId: string | null;
  readonly escrow: Nanos | null;
  readonly settlementAsset: string | null;
  readonly network: string | null;
  readonly createdAt: Date;
}

export async function listJobs(organizationId: string): Promise<DataView<JobSummary[]>> {
  return withDb<JobSummary[]>(async (db) => {
    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.organizationId, organizationId))
      .orderBy(desc(jobs.createdAt))
      .limit(100);
    if (rows.length === 0) return { state: "EMPTY" };
    return {
      state: "READY",
      data: rows.map((row) => ({
        id: row.id,
        title: row.title,
        service: row.service,
        state: row.state,
        buyerAgentId: row.buyerAgentId,
        providerAgentId: row.providerAgentId,
        escrow: row.escrowNanos === null ? null : fromNanosColumn(row.escrowNanos),
        settlementAsset: row.settlementAsset,
        network: row.network,
        createdAt: row.createdAt,
      })),
    };
  });
}

export async function getJob(
  organizationId: string,
  jobId: string,
): Promise<DataView<JobDetail>> {
  return withDb<JobDetail>(async (db) => {
    const rows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, jobId)))
      .limit(1);
    const row = rows[0];
    if (!row) return { state: "EMPTY" };
    return {
      state: "READY",
      data: {
        job: {
          id: row.id,
          title: row.title,
          service: row.service,
          state: row.state,
          buyerAgentId: row.buyerAgentId,
          providerAgentId: row.providerAgentId,
          escrow: row.escrowNanos === null ? null : fromNanosColumn(row.escrowNanos),
          settlementAsset: row.settlementAsset,
          network: row.network,
          createdAt: row.createdAt,
        },
        intentId: row.intentId,
        resultHash: row.resultHash,
        evaluator: row.evaluator,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

export interface ClearingView {
  readonly grossTotal: Nanos;
  readonly openEntries: number;
  /** The cycle that *would* be produced if clearing ran right now. */
  readonly projected: ClearingCycle | null;
  readonly recentCycles: {
    id: string;
    asset: string;
    mode: string;
    gross: Nanos;
    net: Nanos;
    entryCount: number;
    instructionCount: number;
    proofHash: string;
    openedAt: Date;
    settledAt: Date | null;
  }[];
}

export async function getClearing(
  organizationId: string,
  asset = "USDC",
): Promise<DataView<ClearingView>> {
  return withDb<ClearingView>(async (db) => {
    const [entryRows, cycleRows] = await Promise.all([
      db
        .select()
        .from(muledgerEntries)
        .where(
          and(
            eq(muledgerEntries.organizationId, organizationId),
            eq(muledgerEntries.asset, asset),
            eq(muledgerEntries.state, "OPEN"),
          ),
        ),
      db
        .select()
        .from(clearingCycles)
        .where(eq(clearingCycles.organizationId, organizationId))
        .orderBy(desc(clearingCycles.openedAt))
        .limit(10),
    ]);

    if (entryRows.length === 0 && cycleRows.length === 0) return { state: "EMPTY" };

    const entries = entryRows.map(toLedgerEntry);
    const ledger = MuLedger.hydrate(entries);
    const projection =
      entries.length > 0
        ? netBilateral(entries, asset, "cycle_projection", new Date())
        : null;

    return {
      state: "READY",
      data: {
        grossTotal: ledger.gross(asset),
        openEntries: entries.length,
        projected: projection?.ok ? projection.value : null,
        recentCycles: cycleRows.map((row) => ({
          id: row.id,
          asset: row.asset,
          mode: row.mode,
          gross: fromNanosColumn(row.grossTotalNanos),
          net: fromNanosColumn(row.netTotalNanos),
          entryCount: row.entryCount,
          instructionCount: row.instructionCount,
          proofHash: row.proofHash,
          openedAt: row.openedAt,
          settledAt: row.settledAt,
        })),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export interface WalletRow {
  readonly agentId: string;
  readonly agentName: string;
  readonly network: string;
  readonly address: string;
  readonly custody: string;
}

export async function listWallets(organizationId: string): Promise<DataView<WalletRow[]>> {
  return withDb<WalletRow[]>(async (db) => {
    const rows = await db
      .select({
        agentId: agents.id,
        agentName: agents.name,
        network: agentWallets.network,
        address: agentWallets.address,
        custody: agentWallets.custody,
      })
      .from(agentWallets)
      .innerJoin(agents, eq(agents.id, agentWallets.agentId))
      .where(eq(agents.organizationId, organizationId));
    if (rows.length === 0) return { state: "EMPTY" };
    return { state: "READY", data: rows };
  });
}

export interface LedgerTotals {
  readonly receivable: Nanos;
  readonly payable: Nanos;
  readonly pendingEscrow: Nanos;
}

export async function getLedgerTotals(organizationId: string): Promise<DataView<LedgerTotals>> {
  return withDb<LedgerTotals>(async (db) => {
    const [entryRows, escrowRows] = await Promise.all([
      db
        .select()
        .from(muledgerEntries)
        .where(
          and(
            eq(muledgerEntries.organizationId, organizationId),
            inArray(muledgerEntries.state, ["OPEN", "NETTED"]),
          ),
        ),
      db
        .select({ escrow: jobs.escrowNanos })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organizationId),
            inArray(jobs.state, ["FUNDED", "IN_PROGRESS", "SUBMITTED", "EVALUATING"]),
          ),
        ),
    ]);

    if (entryRows.length === 0 && escrowRows.length === 0) return { state: "EMPTY" };

    let receivable = 0n;
    let payable = 0n;
    for (const row of entryRows) {
      receivable += fromNanosColumn(row.amountNanos);
      payable += fromNanosColumn(row.amountNanos);
    }
    // Receivables and payables are the same set seen from two sides; report the
    // gross book rather than pretending one side is larger.
    let pendingEscrow = 0n;
    for (const row of escrowRows) pendingEscrow += fromNanosColumn(row.escrow);

    return { state: "READY", data: { receivable, payable, pendingEscrow } };
  });
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly outcome: string;
  readonly at: Date;
}

export async function listActivity(organizationId: string): Promise<DataView<ActivityItem[]>> {
  return withDb<ActivityItem[]>(async (db) => {
    const [auditRows, receiptRows, intentRows, txRows] = await Promise.all([
      db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, organizationId))
        .orderBy(desc(auditLogs.createdAt))
        .limit(50),
      db
        .select()
        .from(economicReceipts)
        .where(eq(economicReceipts.organizationId, organizationId))
        .orderBy(desc(economicReceipts.createdAt))
        .limit(25),
      db
        .select()
        .from(economicIntents)
        .where(eq(economicIntents.organizationId, organizationId))
        .orderBy(desc(economicIntents.createdAt))
        .limit(25),
      db
        .select()
        .from(transactions)
        .where(eq(transactions.organizationId, organizationId))
        .orderBy(desc(transactions.createdAt))
        .limit(25),
    ]);

    const items: ActivityItem[] = [
      ...auditRows.map((row) => ({
        id: row.id,
        kind: row.action,
        title: row.action.replaceAll(".", " "),
        detail: `${row.actor} → ${row.subject ?? "—"}`,
        outcome: row.outcome,
        at: row.createdAt,
      })),
      ...receiptRows.map((row) => ({
        id: row.id,
        kind: "receipt.issued",
        title: "receipt issued",
        detail: `${row.service} · ${row.settlementRail}`,
        outcome: row.evaluationResult,
        at: row.createdAt,
      })),
      ...intentRows.map((row) => ({
        id: row.id,
        kind: "intent.created",
        title: "economic intent",
        detail: `${row.service} · ${row.settlementAsset} on ${row.network}`,
        outcome: row.status,
        at: row.createdAt,
      })),
      ...txRows.map((row) => ({
        id: row.id,
        kind: "transaction",
        title: `${row.direction} ${row.asset}`,
        detail: `${row.rail} on ${row.network}`,
        outcome: row.status,
        at: row.createdAt,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    if (items.length === 0) return { state: "EMPTY" };
    return { state: "READY", data: items.slice(0, 80) };
  });
}

/** Record an economic decision. Used by every path that allows or denies money. */
export async function recordAudit(entry: {
  organizationId: string | null;
  actor: string;
  action: string;
  subject?: string | null;
  outcome: string;
  detail?: unknown;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const { newId } = await import("@acor/core");
    await db.insert(auditLogs).values({
      id: newId("evt"),
      organizationId: entry.organizationId,
      actor: entry.actor,
      action: entry.action,
      subject: entry.subject ?? null,
      outcome: entry.outcome,
      detail: (entry.detail ?? null) as never,
    });
  } catch {
    // An audit write must never break the request that produced it; the
    // decision itself has already been made deterministically.
  }
}
