/**
 * The Sentinel-5 pre-check for an economic authorization.
 *
 * This runs *before* the relay, and answers four of the five layers itself:
 * IDENTITY (the caller already authenticated to reach this route), a kill
 * switch and resource-ownership check for AUTHORIZATION, and the real
 * ANOMALY sensors. MANDATE and BOUNDS are **not** re-implemented here — they
 * stay the relay's job, because it already does that correctly and
 * atomically with signature verification, and a second implementation is a
 * second place for the two to drift apart. This pre-check passes them
 * through as "not yet evaluated" so the sequence can still reach ANOMALY;
 * the relay call immediately afterward is what actually enforces them.
 *
 * What this pre-check adds that the relay does not have: a kill switch that
 * can be engaged out-of-band, and behavioural comparison against the
 * account's own history. Both can refuse a request the relay alone would
 * have accepted, and both do so *before* a nonce is burned or an intent is
 * recorded — a request Sentinel-5 holds leaves no trace in the relay at all.
 */

import "server-only";

import { agents, and, eq, getDb } from "@acor/db";
import {
  amountFromAtomic,
  assetDefinition,
  evaluateSentinel,
  intentAssetId,
  valueInUsd,
  type AnomalyFacts,
  type EconomicIntent,
  type SentinelDecision,
} from "@acor/core";

import { anomalySensors } from "./sensors";
import { anyKillSwitchEngaged, engageKillSwitch } from "./kill-switches";
import { openIncident, recordContainment, severityFor } from "./incidents";
import { isQuarantined } from "./quarantine";

/** The external provider id underlying a settlement network, for quarantine lookups. */
function providerIdFor(network: string): string | null {
  if (network.startsWith("ARC")) return "arc";
  if (network.startsWith("XRPL")) return "xrpl";
  // MULEDGER settles nothing on an external rail — there is no provider to
  // quarantine.
  return null;
}

export interface PreCheckInput {
  readonly organizationId: string;
  readonly intent: EconomicIntent;
  readonly principalKind: string;
  readonly verified: boolean;
  readonly verificationRemedy: string | null;
}

export interface PreCheckResult {
  readonly decision: SentinelDecision;
  readonly incidentId: string | null;
}

/**
 * Best-effort USD value of the intent's maxSpend, for the anomaly comparison
 * only.
 *
 * `intent.maxSpend` is an atomic quantity of the settlement asset, not
 * dollars — treating it as dollars is how 5 USDC becomes "half a cent". An
 * unregistered asset or an unvaluable amount is already a hard DENY in the
 * mandate engine the relay runs immediately after this; falling back to 0
 * here only affects whether the *anomaly heuristic* fires early, never
 * whether money can move.
 */
function candidateAmountNanos(intent: EconomicIntent): bigint {
  const assetId = intentAssetId(intent);
  if (!assetDefinition(assetId)) return 0n;
  const amount = amountFromAtomic(intent.maxSpend, assetId);
  const valued = valueInUsd(amount, { now: new Date() });
  return valued.ok ? valued.value.nanos : 0n;
}

export async function preCheckIntent(input: PreCheckInput): Promise<PreCheckResult> {
  const db = getDb();

  const amountNanos = candidateAmountNanos(input.intent);
  const providerId = providerIdFor(input.intent.network);
  const [ownsAgent, killSwitchRaw, quarantined] = await Promise.all([
    db
      ? db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.id, input.intent.buyerAgentId),
              eq(agents.organizationId, input.organizationId),
            ),
          )
          .limit(1)
          .then((rows) => rows.length > 0)
      : Promise.resolve(false),
    anyKillSwitchEngaged({
      network: input.intent.network,
      agentId: input.intent.buyerAgentId,
    }),
    providerId ? isQuarantined(providerId) : Promise.resolve(false),
  ]);

  // A quarantined rail is refused exactly like a killed one: the reason
  // differs, but from the caller's side both mean "not usable right now".
  const killSwitch = quarantined
    ? { engaged: true, reason: `The ${providerId} rail is currently quarantined pending review.`, since: null, actor: null, scope: "PROVIDER" as const }
    : killSwitchRaw;

  let anomaly: AnomalyFacts;
  if (killSwitch.engaged) {
    // No point spending four queries on behavioural history when the request
    // is about to be refused on the first check anyway.
    anomaly = {
      authorizationsLastHour: 0,
      distinctCounterpartiesLastHour: 0,
      counterpartySeenBefore: false,
      counterpartyVerified: false,
      secondsSinceMandateWidened: null,
      secondsSincePayoutChanged: null,
      amountNanos,
      largestRecentSpendNanos: null,
    };
  } else {
    anomaly = await anomalySensors({
      buyerAgentId: input.intent.buyerAgentId,
      providerAgentId: input.intent.providerAgentId,
      network: input.intent.network,
      amountNanos,
    });
  }

  const decision = evaluateSentinel({
    identity: {
      authenticated: true,
      principalKind: input.principalKind,
      fresh: true,
      requiresFresh: false,
    },
    authorization: {
      killSwitchEngaged: killSwitch.engaged,
      killSwitchReason: killSwitch.reason,
      ownsResource: ownsAgent,
      planPermits: true,
      verified: input.verified,
      verificationRemedy: input.verificationRemedy,
    },
    // Not yet evaluated here — the relay call that follows is authoritative
    // for both. See the module docstring.
    mandate: { authorized: true, code: null, message: null, humanApprovalRequired: false },
    bounds: { authorized: true, code: null, message: null },
    anomaly,
  });

  let incidentId: string | null = null;
  if (decision.outcome !== "ALLOW") {
    incidentId = await openIncident({
      organizationId: input.organizationId,
      decision,
      summary: `${decision.outcome} at ${decision.decidedBy ?? "unknown"} on intent submission for agent ${input.intent.buyerAgentId}: ${decision.message ?? ""}`,
    });

    // CRITICAL is reserved for the two patterns that specifically look like
    // a compromised session widening its own room to move and then draining
    // it — see LAYER_DESCRIPTIONS / the anomaly layer. Containing further
    // attempts by this agent automatically is proportionate there, and
    // reversible: it takes an authenticated, fresh-session call to
    // /api/v1/security/kill-switch to lift it, which is exactly the
    // deliberate human decision this is meant to force before more money
    // moves. It never engages anything broader than this one agent.
    if (incidentId && severityFor(decision) === "CRITICAL") {
      const engaged = await engageKillSwitch({
        scope: "AGENT",
        target: input.intent.buyerAgentId,
        reason: `Automatic containment: ${decision.code ?? "anomaly"} (incident ${incidentId}).`,
        actorUserId: null,
        actor: "sentinel:auto",
        organizationId: input.organizationId,
      });
      if (engaged) {
        await recordContainment(incidentId, [
          {
            action: "AGENT_KILL_SWITCH_ENGAGED",
            detail: `Agent ${input.intent.buyerAgentId} automatically suspended pending review.`,
          },
        ]);
      }
    }
  }

  return { decision, incidentId };
}
