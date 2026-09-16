/**
 * The production intent relay.
 *
 * Wires the kernel's `IntentRelay` to Postgres stores, real EIP-712 signature
 * recovery, agent-ownership lookup, live mandate and balance state, and the
 * audit log.
 *
 * The relay holds no keys and has no path to spend. An attacker who fully owns
 * this process and its database can publish garbage and delete good intents — a
 * denial of service — but cannot make a signature appear, and therefore cannot
 * cause a payment.
 */

import "server-only";

import {
  agents,
  agentWallets,
  and,
  auditLogs,
  economicMandates,
  eq,
  fromNanosColumn,
  getDb,
  gte,
  inArray,
  muledgerEntries,
  sql,
  transactions,
} from "@acor/db";
import {
  economicMandateSchema,
  formatUsd,
  IntentRelay,
  newId,
  verifyIntentSignature,
  type EconomicIntent,
  type EconomicMandate,
  type MandateContext,
  type Nanos,
  type PriceQuote,
  type ProviderState,
} from "@acor/core";
import { keccak256 } from "@acor/adapters";

import { createRelayStores } from "./stores";

export interface RelayContext {
  readonly organizationId: string;
}

/**
 * Which wallets may commit an agent's money.
 *
 * Ownership is a bound wallet on the agent, in the caller's organization. A
 * valid signature from an unbound wallet proves someone signed; it does not
 * make them entitled to this agent's balance.
 */
async function authorizeSigner(
  organizationId: string,
  buyerAgentId: string,
  signer: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select({ address: agentWallets.address })
    .from(agentWallets)
    .innerJoin(agents, eq(agents.id, agentWallets.agentId))
    .where(
      and(
        eq(agentWallets.agentId, buyerAgentId),
        eq(agents.organizationId, organizationId),
        eq(agents.status, "ACTIVE"),
      ),
    );
  const normalized = signer.trim().toLowerCase();
  return rows.some((row) => row.address.trim().toLowerCase() === normalized);
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
    unverifiedCounterpartyLimitUsd: formatUsd(
      fromNanosColumn(row.unverifiedCounterpartyLimitNanos),
    ),
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
    .select({ usd: transactions.amountUsdNanos, fee: transactions.feeNanos })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        eq(transactions.direction, "OUT"),
        gte(transactions.createdAt, startOfDay),
      ),
    );
  let total = 0n;
  for (const row of rows) {
    // A transaction with no USD valuation cannot be counted against a dollar
    // limit. Returning null denies the spend rather than under-counting the
    // day's total, which would let an unvaluable payment widen the budget.
    if (row.usd === null) return null;
    total += fromNanosColumn(row.usd);
  }
  return total;
}

/**
 * Spendable balance for the asset and network this intent would spend on.
 *
 * Two genuinely different cases:
 *
 *  - **μLedger.** An obligation moves no funds, and the agent's position is
 *    computable from the ledger itself: what it is owed, less what it owes.
 *    That is a real balance read from real rows, not an assumption.
 *  - **Every external rail.** The balance lives on a chain, and reading it
 *    needs a configured adapter and a bound treasury address. Until then the
 *    answer is `null` — unknown — and the mandate engine denies the spend. A
 *    reserve floor cannot be enforced against a number nobody has read.
 */
async function availableBalance(
  organizationId: string,
  intent: EconomicIntent,
): Promise<Nanos | null> {
  const db = getDb();
  if (!db) return null;
  if (intent.network !== "MULEDGER") return null;

  const rows = await db
    .select({
      debtor: muledgerEntries.debtorAgentId,
      creditor: muledgerEntries.creditorAgentId,
      atomic: muledgerEntries.amountAtomic,
    })
    .from(muledgerEntries)
    .where(
      and(
        eq(muledgerEntries.organizationId, organizationId),
        inArray(muledgerEntries.state, ["OPEN", "NETTED"]),
      ),
    );

  let position = 0n;
  for (const row of rows) {
    if (row.atomic === null) continue;
    const amount = fromNanosColumn(row.atomic);
    if (row.creditor === intent.buyerAgentId) position += amount;
    if (row.debtor === intent.buyerAgentId) position -= amount;
  }
  return position;
}

/**
 * A price for an asset with no registered USD peg.
 *
 * No oracle is configured in this deployment, so this returns null and any
 * intent in a non-pegged asset is denied for want of a valuation.
 */
async function loadPriceQuote(_assetId: string): Promise<PriceQuote | null> {
  return null;
}

async function lookupProvider(
  organizationId: string,
  intent: EconomicIntent,
): Promise<ProviderState | null> {
  const agentId = intent.providerAgentId;
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select({
      id: agents.id,
      status: agents.status,
      erc8004: agents.erc8004AgentId,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // On the μLedger nothing moves on a chain, so the payee is the agent itself.
  // On every other network the payout must go to a wallet bound for *that*
  // network — an Arc address cannot receive an XRPL payment.
  let destination = row.id;
  if (intent.network !== "MULEDGER") {
    const wallets = await db
      .select({ address: agentWallets.address, isPrimary: agentWallets.isPrimary })
      .from(agentWallets)
      .where(
        and(eq(agentWallets.agentId, agentId), eq(agentWallets.network, intent.network)),
      );
    const primary = wallets.find((wallet) => wallet.isPrimary) ?? wallets[0];
    if (!primary) return null; // no payout address on this network: not payable
    destination = primary.address;
  }

  return {
    agentId: row.id,
    available: row.status === "ACTIVE",
    destination,
    // Verification means a registry identity, not merely existing in our database.
    verified: Boolean(row.erc8004),
  };
}

/** Build the relay for one organization, or null when there is no database. */
export function createRelay(context: RelayContext): IntentRelay | null {
  const stores = createRelayStores(context.organizationId);
  if (!stores) return null;
  const db = getDb();

  return new IntentRelay({
    nonces: stores.nonces,
    intents: stores.intents,

    async verifySignature(intent, signature, signer) {
      const result = await verifyIntentSignature(intent, signature, signer, keccak256);
      return result.ok;
    },

    authorizeSigner: (buyerAgentId, signer) =>
      authorizeSigner(context.organizationId, buyerAgentId, signer),

    lookupProvider: (intent) => lookupProvider(context.organizationId, intent),

    async loadBuyerPolicy(intent) {
      const mandate = await loadMandate(intent.buyerAgentId);
      if (!mandate) return null;
      const mandateContext: MandateContext = {
        availableBalance: await availableBalance(context.organizationId, intent),
        spentToday: await spentToday(intent.buyerAgentId),
      };
      return { mandate, context: mandateContext };
    },

    loadPriceQuote,

    async audit(event) {
      if (!db) return;
      await db.insert(auditLogs).values({
        id: newId("evt"),
        organizationId: context.organizationId,
        actor: event.signer ? `wallet:${event.signer}` : "system",
        action: event.action,
        subject: event.intentId,
        outcome: event.outcome,
        detail: event.detail as never,
      });
    },
  });
}
