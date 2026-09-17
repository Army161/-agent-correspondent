/**
 * Provider and integration quarantine.
 *
 * Narrower than a kill switch: a kill switch stops *this deployment* from
 * acting on a rail or an agent; quarantine marks an external provider or
 * capability as untrustworthy so it can be checked wherever a decision
 * depends on trusting that provider, independent of whatever its own live
 * probe reports. A provider whose API has started returning suspicious data
 * is still "AVAILABLE" by every health check; quarantine is the mechanism to
 * say "AVAILABLE, and also do not use it."
 */

import "server-only";

import { eq, getDb, isNull, providerQuarantines } from "@acor/db";
import { newId } from "@acor/core";

import { recordAudit } from "../platform";

export async function isQuarantined(providerId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const rows = await db
      .select({ liftedAt: providerQuarantines.liftedAt })
      .from(providerQuarantines)
      .where(eq(providerQuarantines.providerId, providerId))
      .limit(1);
    const row = rows[0];
    return row !== undefined && row.liftedAt === null;
  } catch {
    // Unreadable quarantine state fails toward "quarantined": a provider
    // this deployment cannot confirm is trusted is not treated as trusted.
    return true;
  }
}

export async function quarantineProvider(
  providerId: string,
  reason: string,
  actorUserId: string | null,
  actor: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    await db
      .insert(providerQuarantines)
      .values({ id: newId("sec"), providerId, reason, actorUserId, actor, liftedAt: null })
      .onConflictDoUpdate({
        target: providerQuarantines.providerId,
        set: { reason, actorUserId, actor, quarantinedAt: new Date(), liftedAt: null },
      });
    await recordAudit({
      organizationId: null,
      actor,
      action: "security.provider_quarantined",
      subject: providerId,
      outcome: "ALLOW",
      detail: { reason },
    });
    return true;
  } catch {
    return false;
  }
}

export async function liftQuarantine(
  providerId: string,
  actorUserId: string | null,
  actor: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    await db
      .update(providerQuarantines)
      .set({ liftedAt: new Date() })
      .where(eq(providerQuarantines.providerId, providerId));
    await recordAudit({
      organizationId: null,
      actor,
      action: "security.provider_quarantine_lifted",
      subject: providerId,
      outcome: "ALLOW",
      detail: {},
    });
    return true;
  } catch {
    return false;
  }
}

export async function listQuarantines() {
  const db = getDb();
  if (!db) return [];
  try {
    return await db.select().from(providerQuarantines).where(isNull(providerQuarantines.liftedAt));
  } catch {
    return [];
  }
}
