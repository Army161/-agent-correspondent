/**
 * Kill switches.
 *
 * `POST` engages or disengages one. Every action requires a **fresh**
 * session — a stolen cookie must not be enough to disengage containment any
 * more than it should be enough to move money — and is itself written to
 * the audit log and the append-only kill-switch event log.
 *
 * Scoping:
 *  - AGENT and WALLET switches are self-service: any signed-in owner may
 *    freeze their own organization's agent or wallet. This is a safety
 *    control, not a privileged one — a customer who suspects their own agent
 *    is compromised should not need to wait for an operator.
 *  - RAIL and GLOBAL affect every tenant, and require the caller's email to
 *    be on the `PLATFORM_OPERATOR_EMAILS` allowlist. Without that
 *    configured, nobody can engage one — see lib/security/operators.ts.
 *
 * Nothing here is reachable from a chat tool, and disengaging is never
 * automatic: only this authenticated, fresh-session endpoint can undo
 * containment.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { agents, agentWallets, and, eq, getDb } from "@acor/db";

import { badRequest, readJson } from "@/lib/api";
import { requireFreshSession } from "@/lib/auth";
import {
  allEngagedKillSwitches,
  disengageKillSwitch,
  engageKillSwitch,
  killSwitchHistory,
  walletKillSwitchKey,
  type KillSwitchScope,
} from "@/lib/security/kill-switches";
import { isPlatformOperator, platformOperatorsConfigured } from "@/lib/security/operators";
import { recordAudit } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  scope: z.enum(["GLOBAL", "RAIL", "AGENT", "WALLET", "PROVIDER"]),
  action: z.enum(["ENGAGE", "DISENGAGE"]),
  /** A rail id, an agent id, or `agentId:network:address` for WALLET. Omit for GLOBAL. */
  target: z.string().min(1).max(256).optional(),
  reason: z.string().min(3).max(500),
});

/**
 * Resolve a WALLET target the caller wrote as `agentId:network:address` into
 * the canonical key, after confirming the wallet belongs to their
 * organization. An org-scoped caller must never be able to freeze a wallet
 * that is not theirs by guessing another organization's agent id.
 */
async function resolveOwnedWalletTarget(
  organizationId: string,
  raw: string,
): Promise<string | null> {
  const [agentId, network, address] = raw.split(":");
  if (!agentId || !network || !address) return null;
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select({ address: agentWallets.address })
    .from(agentWallets)
    .innerJoin(agents, eq(agents.id, agentWallets.agentId))
    .where(
      and(
        eq(agentWallets.agentId, agentId),
        eq(agents.organizationId, organizationId),
        eq(agentWallets.network, network),
      ),
    );
  const normalized = network.startsWith("XRPL") ? address.trim() : address.trim().toLowerCase();
  const match = rows.find(
    (row) =>
      (network.startsWith("XRPL") ? row.address.trim() : row.address.trim().toLowerCase()) ===
      normalized,
  );
  if (!match) return null;
  return walletKillSwitchKey(agentId, network, match.address);
}

async function ownsAgent(organizationId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
    .limit(1);
  return rows.length > 0;
}

export async function GET(): Promise<NextResponse> {
  const fresh = await requireFreshSession();
  if (!fresh.ok) return NextResponse.json({ error: "NOT_AUTHORIZED", message: fresh.reason }, { status: 401 });

  const engaged = await allEngagedKillSwitches();
  const operator = isPlatformOperator(fresh.user.email);

  // An org owner sees platform-wide switches (they are affected by them) but
  // not other organizations' AGENT/WALLET switches — those carry another
  // tenant's agent ids, which is not this caller's information to have.
  const visible = engaged.filter(
    (entry) => entry.scope === "GLOBAL" || entry.scope === "RAIL" || operator,
  );

  return NextResponse.json({ engaged: visible, isOperator: operator });
}

export async function POST(request: Request): Promise<NextResponse> {
  const fresh = await requireFreshSession();
  if (!fresh.ok) return NextResponse.json({ error: "NOT_AUTHORIZED", message: fresh.reason }, { status: 401 });

  const body = await readJson(request);
  if (body === null) return badRequest("Body must be JSON.");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      `${parsed.error.issues[0]?.path.join(".") ?? "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const scope = parsed.data.scope as KillSwitchScope;
  let target: string | null = null;
  let organizationId: string | null = null;

  if (scope === "GLOBAL" || scope === "RAIL" || scope === "PROVIDER") {
    if (!platformOperatorsConfigured() || !isPlatformOperator(fresh.user.email)) {
      return NextResponse.json(
        {
          error: "NOT_A_PLATFORM_OPERATOR",
          message: platformOperatorsConfigured()
            ? "This account is not on the platform operator allowlist."
            : "No platform operators are configured on this deployment (PLATFORM_OPERATOR_EMAILS), so no platform-wide switch can be engaged by anyone.",
        },
        { status: 403 },
      );
    }
    if (scope !== "GLOBAL") {
      if (!parsed.data.target) return badRequest("target is required for this scope.");
      target = parsed.data.target;
    }
  } else if (scope === "AGENT") {
    if (!parsed.data.target) return badRequest("target (an agent id) is required.");
    if (!(await ownsAgent(fresh.user.organizationId, parsed.data.target))) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "No such agent in this organization." },
        { status: 404 },
      );
    }
    target = parsed.data.target;
    organizationId = fresh.user.organizationId;
  } else if (scope === "WALLET") {
    if (!parsed.data.target) {
      return badRequest("target (agentId:network:address) is required.");
    }
    const resolved = await resolveOwnedWalletTarget(fresh.user.organizationId, parsed.data.target);
    if (!resolved) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "No such wallet in this organization." },
        { status: 404 },
      );
    }
    target = resolved;
    organizationId = fresh.user.organizationId;
  }

  const engagedBefore = parsed.data.action === "DISENGAGE";
  const applied = engagedBefore
    ? await disengageKillSwitch({
        scope,
        target,
        reason: parsed.data.reason,
        actorUserId: fresh.user.id,
        actor: `user:${fresh.user.id}`,
        organizationId,
      })
    : await engageKillSwitch({
        scope,
        target,
        reason: parsed.data.reason,
        actorUserId: fresh.user.id,
        actor: `user:${fresh.user.id}`,
        organizationId,
      });

  await recordAudit({
    organizationId,
    actor: `user:${fresh.user.id}`,
    action: `security.kill_switch.${parsed.data.action.toLowerCase()}`,
    subject: target ?? scope,
    outcome: applied ? "ALLOW" : "ERROR",
    detail: { scope, target, reason: parsed.data.reason },
  });

  if (!applied) {
    return NextResponse.json({ error: "NOT_APPLIED", message: "Could not record this action." }, { status: 503 });
  }

  const history = await killSwitchHistory(scope, target, 1);
  return NextResponse.json({ ok: true, scope, target, action: parsed.data.action, event: history[0] ?? null });
}
