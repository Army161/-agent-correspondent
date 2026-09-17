/**
 * Convoy Mode, server side.
 *
 * The arithmetic lives in `@acor/core`; this module gathers the real facts
 * (pooled spend, combined velocity) the same way `lib/security/sensors.ts`
 * gathers per-agent ones — read from the ledger, never a cached counter.
 */

import "server-only";

import {
  agentConvoyMembers,
  agentConvoys,
  agents,
  and,
  eq,
  getDb,
  gte,
  inArray,
  transactions,
  economicIntents,
} from "@acor/db";
import { checkConvoyPool, checkConvoyVelocity, newId, type ConvoyVelocityResult } from "@acor/core";

const HOUR_MS = 60 * 60 * 1000;

/** Default combined velocity thresholds. Configuration, not a hard rule. */
const DEFAULT_MAX_AUTHORIZATIONS_PER_HOUR = 120;
const DEFAULT_MAX_DISTINCT_COUNTERPARTIES_PER_HOUR = 20;

export interface Convoy {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly dailyPoolLimitNanos: bigint;
  readonly members: readonly string[];
}

export async function createConvoy(
  organizationId: string,
  name: string,
  dailyPoolLimitNanos: bigint,
): Promise<Convoy | null> {
  const db = getDb();
  if (!db) return null;
  const id = newId("convoy");
  try {
    await db.insert(agentConvoys).values({
      id,
      organizationId,
      name,
      dailyPoolLimitNanos: dailyPoolLimitNanos.toString(),
    });
    return { id, organizationId, name, dailyPoolLimitNanos, members: [] };
  } catch {
    return null;
  }
}

/** Add an agent to a convoy. Fails if the agent already belongs to another one. */
export async function addMember(
  organizationId: string,
  convoyId: string,
  agentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };

  const [convoyRows, agentRows] = await Promise.all([
    db
      .select({ id: agentConvoys.id })
      .from(agentConvoys)
      .where(and(eq(agentConvoys.id, convoyId), eq(agentConvoys.organizationId, organizationId)))
      .limit(1),
    db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
      .limit(1),
  ]);
  if (convoyRows.length === 0) return { ok: false, error: "No such convoy in this organization." };
  if (agentRows.length === 0) return { ok: false, error: "No such agent in this organization." };

  try {
    await db.insert(agentConvoyMembers).values({ id: newId("convoy"), convoyId, agentId });
    return { ok: true };
  } catch {
    // The unique index on agent_id is what actually enforces exclusivity;
    // this is the honest surface for that.
    return { ok: false, error: "This agent already belongs to a convoy." };
  }
}

export async function removeMember(
  organizationId: string,
  convoyId: string,
  agentId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const owned = await db
      .select({ id: agentConvoys.id })
      .from(agentConvoys)
      .where(and(eq(agentConvoys.id, convoyId), eq(agentConvoys.organizationId, organizationId)))
      .limit(1);
    if (owned.length === 0) return false;
    const deleted = await db
      .delete(agentConvoyMembers)
      .where(and(eq(agentConvoyMembers.convoyId, convoyId), eq(agentConvoyMembers.agentId, agentId)))
      .returning({ id: agentConvoyMembers.id });
    return deleted.length > 0;
  } catch {
    return false;
  }
}

/** The convoy an agent belongs to, if any. */
export async function convoyForAgent(
  organizationId: string,
  agentId: string,
): Promise<Convoy | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select({
        convoyId: agentConvoys.id,
        organizationId: agentConvoys.organizationId,
        name: agentConvoys.name,
        dailyPoolLimitNanos: agentConvoys.dailyPoolLimitNanos,
      })
      .from(agentConvoyMembers)
      .innerJoin(agentConvoys, eq(agentConvoys.id, agentConvoyMembers.convoyId))
      .where(
        and(eq(agentConvoyMembers.agentId, agentId), eq(agentConvoys.organizationId, organizationId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const members = await db
      .select({ agentId: agentConvoyMembers.agentId })
      .from(agentConvoyMembers)
      .where(eq(agentConvoyMembers.convoyId, row.convoyId));

    return {
      id: row.convoyId,
      organizationId: row.organizationId,
      name: row.name,
      dailyPoolLimitNanos: BigInt(row.dailyPoolLimitNanos),
      members: members.map((member) => member.agentId),
    };
  } catch {
    return null;
  }
}

export interface ConvoyCheckResult {
  readonly ok: boolean;
  readonly code: "CONVOY_POOL_EXCEEDED" | "CONVOY_VELOCITY" | "CONVOY_FANOUT" | null;
  readonly message: string | null;
}

/**
 * Check a candidate authorization against its convoy's pooled budget and
 * combined velocity, if the buyer agent belongs to one.
 *
 * `candidateNanos` should already be the best-effort USD valuation used for
 * the Sentinel-5 anomaly check, so the two never disagree about what an
 * intent is "worth".
 */
export async function checkConvoy(
  organizationId: string,
  agentId: string,
  candidateNanos: bigint,
  now: Date = new Date(),
): Promise<ConvoyCheckResult> {
  const convoy = await convoyForAgent(organizationId, agentId);
  if (!convoy) return { ok: true, code: null, message: null };

  const db = getDb();
  if (!db) return { ok: true, code: null, message: null };

  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const hourAgo = new Date(now.getTime() - HOUR_MS);

  const [spendRows, intentRows] = await Promise.all([
    db
      .select({ usd: transactions.amountUsdNanos })
      .from(transactions)
      .where(
        and(
          inArray(transactions.agentId, convoy.members),
          eq(transactions.direction, "OUT"),
          gte(transactions.createdAt, startOfDay),
        ),
      ),
    db
      .select({ providerAgentId: economicIntents.providerAgentId })
      .from(economicIntents)
      .where(
        and(inArray(economicIntents.buyerAgentId, convoy.members), gte(economicIntents.createdAt, hourAgo)),
      ),
  ]);

  let spentToday = 0n;
  for (const row of spendRows) {
    if (row.usd === null) continue;
    spentToday += BigInt(row.usd);
  }

  const pool = checkConvoyPool({
    poolLimitNanos: convoy.dailyPoolLimitNanos,
    spentTodayNanos: spentToday,
    candidateNanos,
  });
  if (!pool.ok || !pool.value.allowed) {
    return {
      ok: false,
      code: "CONVOY_POOL_EXCEEDED",
      message: pool.ok
        ? `Convoy "${convoy.name}" has ${pool.value.remainingNanos} nanodollars left in its shared daily pool, which this authorization exceeds.`
        : "This authorization could not be checked against the convoy's pool.",
    };
  }

  const velocity: ConvoyVelocityResult = checkConvoyVelocity({
    authorizationsLastHour: intentRows.length,
    distinctCounterpartiesLastHour: new Set(intentRows.map((row) => row.providerAgentId)).size,
    maxAuthorizationsPerHour: DEFAULT_MAX_AUTHORIZATIONS_PER_HOUR,
    maxDistinctCounterpartiesPerHour: DEFAULT_MAX_DISTINCT_COUNTERPARTIES_PER_HOUR,
  });
  if (!velocity.withinLimits) {
    return {
      ok: false,
      code: velocity.code,
      message: `Convoy "${convoy.name}"'s combined activity across its ${convoy.members.length} agents looks coordinated rather than routine and is held for review.`,
    };
  }

  return { ok: true, code: null, message: null };
}

/** Fetch a convoy's members, scoped to the caller's own organization. */
export async function getConvoy(organizationId: string, convoyId: string): Promise<Convoy | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(agentConvoys)
    .where(and(eq(agentConvoys.id, convoyId), eq(agentConvoys.organizationId, organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const members = await db
    .select({ agentId: agentConvoyMembers.agentId })
    .from(agentConvoyMembers)
    .where(eq(agentConvoyMembers.convoyId, convoyId));
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    dailyPoolLimitNanos: BigInt(row.dailyPoolLimitNanos),
    members: members.map((member) => member.agentId),
  };
}

export async function listConvoys(organizationId: string): Promise<readonly Convoy[]> {
  const db = getDb();
  if (!db) return [];
  const convoys = await db
    .select()
    .from(agentConvoys)
    .where(eq(agentConvoys.organizationId, organizationId));
  const members = await db
    .select({ convoyId: agentConvoyMembers.convoyId, agentId: agentConvoyMembers.agentId })
    .from(agentConvoyMembers)
    .where(
      inArray(
        agentConvoyMembers.convoyId,
        convoys.map((convoy) => convoy.id),
      ),
    );
  return convoys.map((convoy) => ({
    id: convoy.id,
    organizationId: convoy.organizationId,
    name: convoy.name,
    dailyPoolLimitNanos: BigInt(convoy.dailyPoolLimitNanos),
    members: members.filter((member) => member.convoyId === convoy.id).map((member) => member.agentId),
  }));
}
