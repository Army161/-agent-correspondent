/**
 * Incident creation and evidence preservation.
 *
 * An incident is opened whenever Sentinel-5 returns anything other than
 * ALLOW. The full decision — every layer, in the order it was evaluated — is
 * the evidence, frozen at write time (see the append-only trigger on
 * `security_incidents`). Nothing here decides whether to contain; that is a
 * separate, explicit escalation a human or a narrowly-scoped auto-response
 * makes, recorded in `containmentActions`.
 */

import "server-only";

import { eq, getDb, securityIncidents } from "@acor/db";
import { newId, type SentinelDecision } from "@acor/core";

export type IncidentSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Map a Sentinel-5 outcome and code to a severity.
 *
 * A DENY at IDENTITY or AUTHORIZATION is routine — most of them are simply
 * someone probing an endpoint they are not entitled to, and the request
 * never got near money. A HOLD at ANOMALY on an in-flight payment, or any
 * DENY at BOUNDS (a signed authorization being exceeded), is the shape of an
 * actual attempt to move money wrongly, and is scored higher.
 */
export function severityFor(decision: SentinelDecision): IncidentSeverity {
  if (decision.outcome === "ALLOW") return "LOW";
  const layer = decision.decidedBy;
  if (layer === "BOUNDS") return "HIGH";
  if (layer === "ANOMALY") {
    if (decision.code === "MANDATE_RECENTLY_WIDENED" || decision.code === "PAYOUT_RECENTLY_CHANGED") {
      return "CRITICAL";
    }
    if (decision.code === "SPEND_SPIKE") return "HIGH";
    return "MEDIUM";
  }
  if (layer === "MANDATE") return decision.outcome === "HOLD" ? "MEDIUM" : "LOW";
  return "LOW";
}

export interface OpenIncidentInput {
  readonly organizationId: string | null;
  readonly decision: SentinelDecision;
  readonly summary: string;
}

/**
 * Open an incident for a non-ALLOW decision. Idempotent in spirit — callers
 * are expected to call this once per evaluated decision — but not
 * deduplicated here: a second identical hold ten seconds later is itself a
 * signal, not noise to be collapsed away.
 */
export async function openIncident(input: OpenIncidentInput): Promise<string | null> {
  if (input.decision.outcome === "ALLOW") return null;
  const db = getDb();
  if (!db) return null;

  const id = newId("inc");
  try {
    await db.insert(securityIncidents).values({
      id,
      organizationId: input.organizationId,
      severity: severityFor(input.decision),
      category: input.decision.decidedBy ?? "UNKNOWN",
      code: input.decision.code ?? "UNKNOWN",
      summary: input.summary,
      evidence: input.decision as unknown as Record<string, unknown>,
      status: "OPEN",
    });
    return id;
  } catch {
    // An incident that fails to record must never block or alter the
    // decision that produced it — the decision has already been made
    // deterministically by evaluateSentinel, before this function is called.
    return null;
  }
}

/** Record what containment was taken for an incident, without reopening it. */
export async function recordContainment(
  incidentId: string,
  actions: readonly { readonly action: string; readonly detail: string }[],
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .update(securityIncidents)
      .set({ containmentActions: actions as unknown as Record<string, unknown> })
      .where(eq(securityIncidents.id, incidentId));
  } catch {
    // Non-fatal: the incident row still exists with its frozen evidence even
    // if the containment note could not be attached.
  }
}

export type IncidentStatus = "OPEN" | "CONTAINED" | "RESOLVED";

/**
 * Advance an incident's status. Forward only, enforced again here (and by
 * the database trigger as the real backstop): OPEN -> CONTAINED -> RESOLVED.
 */
export async function advanceIncident(
  incidentId: string,
  status: IncidentStatus,
  resolvedByUserId: string | null,
  note: string | null,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const ORDER: readonly IncidentStatus[] = ["OPEN", "CONTAINED", "RESOLVED"];
  try {
    const rows = await db
      .select({ status: securityIncidents.status })
      .from(securityIncidents)
      .where(eq(securityIncidents.id, incidentId))
      .limit(1);
    const current = rows[0]?.status;
    if (!current) return false;
    if (ORDER.indexOf(status as IncidentStatus) < ORDER.indexOf(current as IncidentStatus)) {
      return false;
    }
    await db
      .update(securityIncidents)
      .set({
        status,
        resolvedAt: status === "RESOLVED" ? new Date() : null,
        resolvedByUserId: status === "RESOLVED" ? resolvedByUserId : null,
        resolutionNote: note,
      })
      .where(eq(securityIncidents.id, incidentId));
    return true;
  } catch {
    return false;
  }
}
