/**
 * Deterministic sensors for Sentinel-5's anomaly layer.
 *
 * Every fact here is a count or a timestamp read straight from our own
 * tables — never a model's summary of the account's behaviour. A "risk
 * score" nobody can point at a row in the database is not something anyone
 * can audit, argue with, or tune.
 */

import "server-only";

import {
  agents,
  agentWallets,
  and,
  economicIntents,
  economicMandates,
  eq,
  gte,
  isNotNull,
  getDb,
  transactions,
} from "@acor/db";
import type { AnomalyFacts } from "@acor/core";

const HOUR_MS = 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * HOUR_MS;

/**
 * Whether the most recent mandate version *widened* any limit relative to the
 * one before it, and if so, how long ago.
 *
 * A narrowed mandate (tightening a limit) is not a signal worth holding on —
 * only a widening matters, because that is the move that benefits an
 * attacker who has taken over a session.
 */
async function mandateWidenedSecondsAgo(agentId: string, now: Date): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(economicMandates)
    .where(eq(economicMandates.agentId, agentId))
    .orderBy(economicMandates.version)
    .limit(1000);
  if (rows.length < 2) return null;

  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  if (!latest || !previous) return null;

  const widened =
    BigInt(latest.dailySpendLimitNanos) > BigInt(previous.dailySpendLimitNanos) ||
    BigInt(latest.maxTransactionNanos) > BigInt(previous.maxTransactionNanos) ||
    BigInt(latest.unverifiedCounterpartyLimitNanos) >
      BigInt(previous.unverifiedCounterpartyLimitNanos) ||
    BigInt(latest.humanApprovalAboveNanos) > BigInt(previous.humanApprovalAboveNanos) ||
    (latest.creditAllowed && !previous.creditAllowed) ||
    (latest.tokenTradingAllowed && !previous.tokenTradingAllowed);

  if (!widened) return null;
  return Math.floor((now.getTime() - latest.createdAt.getTime()) / 1000);
}

/** Seconds since a verified payout wallet was most recently bound on this network. */
async function payoutChangedSecondsAgo(
  agentId: string,
  network: string,
  now: Date,
): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select({ createdAt: agentWallets.createdAt })
    .from(agentWallets)
    .where(
      and(
        eq(agentWallets.agentId, agentId),
        eq(agentWallets.network, network),
        isNotNull(agentWallets.verifiedAt),
      ),
    )
    .orderBy(agentWallets.createdAt);
  const latest = rows[rows.length - 1];
  if (!latest) return null;
  return Math.floor((now.getTime() - latest.createdAt.getTime()) / 1000);
}

/**
 * Gather the anomaly facts for one candidate authorization.
 *
 * `amountNanos` is the USD-valued size of the *candidate* spend, supplied by
 * the caller (the mandate layer already required a valuation for anything
 * this needs to compare against). Everything else is read from history.
 */
export async function anomalySensors(input: {
  buyerAgentId: string;
  providerAgentId: string;
  network: string;
  amountNanos: bigint;
  now?: Date;
}): Promise<AnomalyFacts> {
  const db = getDb();
  const now = input.now ?? new Date();
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);

  if (!db) {
    // No database means no history to compare against, which must not be
    // read as "nothing to worry about" — largestRecentSpendNanos stays null,
    // which the anomaly layer already treats as "cannot compute a spike".
    return {
      authorizationsLastHour: 0,
      distinctCounterpartiesLastHour: 0,
      counterpartySeenBefore: false,
      counterpartyVerified: false,
      secondsSinceMandateWidened: null,
      secondsSincePayoutChanged: null,
      amountNanos: input.amountNanos,
      largestRecentSpendNanos: null,
    };
  }

  const [recentIntents, everIntents, provider, mandateWidened, payoutChanged] = await Promise.all([
    db
      .select({ providerAgentId: economicIntents.providerAgentId })
      .from(economicIntents)
      .where(
        and(
          eq(economicIntents.buyerAgentId, input.buyerAgentId),
          gte(economicIntents.createdAt, hourAgo),
        ),
      ),
    db
      .select({ id: economicIntents.id })
      .from(economicIntents)
      .where(
        and(
          eq(economicIntents.buyerAgentId, input.buyerAgentId),
          eq(economicIntents.providerAgentId, input.providerAgentId),
        ),
      )
      .limit(1),
    db
      .select({ erc8004: agents.erc8004AgentId })
      .from(agents)
      .where(eq(agents.id, input.providerAgentId))
      .limit(1),
    mandateWidenedSecondsAgo(input.buyerAgentId, now),
    payoutChangedSecondsAgo(input.buyerAgentId, input.network, now),
  ]);

  const distinctCounterparties = new Set(recentIntents.map((row) => row.providerAgentId));

  const spendRows = await db
    .select({ usd: transactions.amountUsdNanos })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, input.buyerAgentId),
        eq(transactions.direction, "OUT"),
        gte(transactions.createdAt, thirtyDaysAgo),
      ),
    );
  let largest: bigint | null = null;
  for (const row of spendRows) {
    if (row.usd === null) continue;
    const value = BigInt(row.usd);
    if (largest === null || value > largest) largest = value;
  }

  return {
    authorizationsLastHour: recentIntents.length,
    distinctCounterpartiesLastHour: distinctCounterparties.size,
    counterpartySeenBefore: everIntents.length > 0,
    counterpartyVerified: provider[0]?.erc8004 !== null && provider[0]?.erc8004 !== undefined,
    secondsSinceMandateWidened: mandateWidened,
    secondsSincePayoutChanged: payoutChanged,
    amountNanos: input.amountNanos,
    largestRecentSpendNanos: largest,
  };
}
