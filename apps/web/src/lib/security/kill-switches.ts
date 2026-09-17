/**
 * The kill switch.
 *
 * State is derived from a log, never stored as a flag: the most recent
 * ENGAGE/DISENGAGE event for a (scope, target) pair is the current state.
 * That makes containment reversible by construction — disengaging is a new
 * row, not an edit — and it means there is exactly one place this can ever
 * disagree with itself.
 *
 * Nothing here is reachable from a chat tool. Engaging a kill switch is an
 * operator action (`POST /api/v1/security/kill-switch`) or an automatic
 * response to a Sentinel-5 HOLD/DENY that this module's caller decides to
 * escalate — never something a language model can trigger directly, and
 * never something a language model can *disengage* at all: containment can
 * only be reversed through the authenticated operator endpoint, which
 * requires a fresh session.
 */

import "server-only";

import { and, desc, eq, getDb, isNull, killSwitchEvents } from "@acor/db";
import { newId } from "@acor/core";

export type KillSwitchScope = "GLOBAL" | "RAIL" | "AGENT" | "WALLET" | "PROVIDER";

/**
 * The canonical WALLET-scope target key.
 *
 * Address is lowercased so an EVM address's inconsistent checksumming can
 * never let the same wallet be frozen under one casing and used under
 * another. XRPL addresses are case-significant and untouched.
 */
export function walletKillSwitchKey(agentId: string, network: string, address: string): string {
  const normalized = network.startsWith("XRPL") ? address.trim() : address.trim().toLowerCase();
  return `${agentId}:${network}:${normalized}`;
}

export interface KillSwitchState {
  readonly engaged: boolean;
  readonly reason: string | null;
  readonly since: Date | null;
  readonly actor: string | null;
}

const NOT_ENGAGED: KillSwitchState = {
  engaged: false,
  reason: null,
  since: null,
  actor: null,
};

/** Current state for one (scope, target) pair. GLOBAL has no target. */
export async function killSwitchState(
  scope: KillSwitchScope,
  target: string | null = null,
): Promise<KillSwitchState> {
  const db = getDb();
  if (!db) return NOT_ENGAGED;

  try {
    const rows = await db
      .select()
      .from(killSwitchEvents)
      .where(
        and(
          eq(killSwitchEvents.scope, scope),
          target === null ? isNull(killSwitchEvents.target) : eq(killSwitchEvents.target, target),
        ),
      )
      .orderBy(desc(killSwitchEvents.createdAt))
      .limit(1);

    const latest = rows[0];
    if (!latest || latest.action === "DISENGAGE") return NOT_ENGAGED;
    return {
      engaged: true,
      reason: latest.reason,
      since: latest.createdAt,
      actor: latest.actor,
    };
  } catch {
    // An unreadable kill-switch log must fail toward safety, not toward
    // "unengaged". If containment state cannot be read, treat it as engaged
    // and let the caller decide how to degrade — never silently proceed as
    // if nothing were wrong.
    return { engaged: true, reason: "kill-switch state could not be read", since: null, actor: null };
  }
}

/**
 * Whether *anything* relevant to this execution is killed: global, the rail,
 * the agent, and (when given) the specific wallet.
 *
 * Checked as one call because a caller needs a single yes/no, and because
 * checking in this order — broadest first — gives the clearest reason when
 * several are engaged at once.
 */
export async function anyKillSwitchEngaged(input: {
  network?: string | null;
  agentId?: string | null;
  walletKey?: string | null;
}): Promise<KillSwitchState & { readonly scope: KillSwitchScope | null }> {
  const global = await killSwitchState("GLOBAL");
  if (global.engaged) return { ...global, scope: "GLOBAL" };

  if (input.network) {
    const rail = await killSwitchState("RAIL", input.network);
    if (rail.engaged) return { ...rail, scope: "RAIL" };
  }
  if (input.agentId) {
    const agent = await killSwitchState("AGENT", input.agentId);
    if (agent.engaged) return { ...agent, scope: "AGENT" };
  }
  if (input.walletKey) {
    const wallet = await killSwitchState("WALLET", input.walletKey);
    if (wallet.engaged) return { ...wallet, scope: "WALLET" };
  }
  return { ...NOT_ENGAGED, scope: null };
}

export interface EngageInput {
  readonly scope: KillSwitchScope;
  readonly target?: string | null;
  readonly reason: string;
  readonly actorUserId: string | null;
  readonly actor: string;
  readonly organizationId?: string | null;
}

/** Engage a kill switch. Always succeeds if the database is reachable — containment must not itself be refusable. */
export async function engageKillSwitch(input: EngageInput): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (input.scope !== "GLOBAL" && !input.target) return false;
  try {
    await db.insert(killSwitchEvents).values({
      id: newId("kill"),
      organizationId: input.organizationId ?? null,
      scope: input.scope,
      target: input.scope === "GLOBAL" ? null : (input.target as string),
      action: "ENGAGE",
      reason: input.reason,
      actorUserId: input.actorUserId,
      actor: input.actor,
    });
    return true;
  } catch {
    return false;
  }
}

export async function disengageKillSwitch(input: EngageInput): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (input.scope !== "GLOBAL" && !input.target) return false;
  try {
    await db.insert(killSwitchEvents).values({
      id: newId("kill"),
      organizationId: input.organizationId ?? null,
      scope: input.scope,
      target: input.scope === "GLOBAL" ? null : (input.target as string),
      action: "DISENGAGE",
      reason: input.reason,
      actorUserId: input.actorUserId,
      actor: input.actor,
    });
    return true;
  } catch {
    return false;
  }
}

/** The full history for one pair, newest first. For the security page and incident evidence. */
export async function killSwitchHistory(
  scope: KillSwitchScope,
  target: string | null = null,
  limit = 50,
) {
  const db = getDb();
  if (!db) return [];
  try {
    return await db
      .select()
      .from(killSwitchEvents)
      .where(
        and(
          eq(killSwitchEvents.scope, scope),
          target === null ? isNull(killSwitchEvents.target) : eq(killSwitchEvents.target, target),
        ),
      )
      .orderBy(desc(killSwitchEvents.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

export interface EngagedKillSwitch extends KillSwitchState {
  readonly scope: KillSwitchScope;
  readonly target: string | null;
}

/** Every scope/target pair currently engaged. For the security dashboard. */
export async function allEngagedKillSwitches(): Promise<readonly EngagedKillSwitch[]> {
  const db = getDb();
  if (!db) return [];
  try {
    // Latest event per (scope, target), kept only if it is an ENGAGE. Done in
    // application code rather than a window-function query: the table is
    // small (containment is rare by design) and the logic stays as readable
    // as killSwitchState's.
    const rows = await db
      .select()
      .from(killSwitchEvents)
      .orderBy(desc(killSwitchEvents.createdAt));
    const seen = new Set<string>();
    const engaged: EngagedKillSwitch[] = [];
    for (const row of rows) {
      const key = `${row.scope}:${row.target ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.action === "ENGAGE") {
        engaged.push({
          scope: row.scope,
          target: row.target,
          engaged: true,
          reason: row.reason,
          since: row.createdAt,
          actor: row.actor,
        });
      }
    }
    return engaged;
  } catch {
    return [];
  }
}
