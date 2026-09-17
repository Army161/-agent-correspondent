/**
 * Clearing execution.
 *
 * Computing a projected cycle (`getClearing` in `lib/platform.ts`) and
 * actually running one are different operations. This module is the second
 * one: it nets the organization's OPEN μLedger entries, persists the cycle
 * — proof hash, instructions and all — and moves every entry it consumed
 * from OPEN to NETTED.
 *
 * It never marks anything SETTLED. Netting only reduces *how many* transfers
 * are owed and how large they are; it does not move money. Nothing in this
 * deployment has signing authority on a funded settlement rail (see
 * docs/ARC.md, docs/XRPL.md), so claiming SETTLED here would be exactly the
 * fabricated transaction this codebase's rules forbid. An operator who has
 * actually paid a netted instruction marks it settled through a separate,
 * explicit action — not implemented yet; see the note at the end of this file.
 */

import "server-only";

import {
  and,
  clearingCycles,
  eq,
  getDb,
  inArray,
  muledgerEntries,
  toNanosColumn,
} from "@acor/db";
import { netBilateral, netMultilateral, newId, type ClearingCycle } from "@acor/core";

function toLedgerEntry(row: typeof muledgerEntries.$inferSelect) {
  return {
    entryId: row.id,
    debtorAgentId: row.debtorAgentId,
    creditorAgentId: row.creditorAgentId,
    amount: BigInt(row.amountNanos),
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

class ClearingRaceError extends Error {}

export type ClearingRunResult =
  | { readonly ok: true; readonly cycle: ClearingCycle }
  | { readonly ok: false; readonly error: string };

/**
 * Run a clearing cycle for one organization and asset.
 *
 * Reads every OPEN entry, nets it (bilateral or multilateral), and — inside
 * one transaction — writes the cycle and flips the consumed entries to
 * NETTED. A concurrent settlement of one of those entries between the read
 * and the write is caught by the `WHERE state = 'OPEN'` guard on the update:
 * if the row count does not match what was netted, the whole run is rolled
 * back rather than persisting a cycle whose inputs already moved.
 */
export async function runClearing(
  organizationId: string,
  asset: string,
  mode: "BILATERAL" | "MULTILATERAL",
): Promise<ClearingRunResult> {
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(muledgerEntries)
        .where(
          and(
            eq(muledgerEntries.organizationId, organizationId),
            eq(muledgerEntries.asset, asset.toUpperCase()),
            eq(muledgerEntries.state, "OPEN"),
          ),
        );

      if (rows.length === 0) {
        return { ok: false, error: `No open ${asset} obligations to clear.` };
      }

      const entries = rows.map(toLedgerEntry);
      const cycleId = newId("cycle");
      const openedAt = new Date();
      const netted =
        mode === "MULTILATERAL"
          ? netMultilateral(entries, asset, cycleId, openedAt)
          : netBilateral(entries, asset, cycleId, openedAt);
      if (!netted.ok) {
        return {
          ok: false,
          error: netted.violations[0]?.message ?? "Could not net these entries.",
        };
      }
      const cycle = netted.value;

      const entryIds = entries.map((entry) => entry.entryId);
      const updated = await tx
        .update(muledgerEntries)
        .set({ state: "NETTED", cycleId })
        .where(and(inArray(muledgerEntries.id, entryIds), eq(muledgerEntries.state, "OPEN")))
        .returning({ id: muledgerEntries.id });

      if (updated.length !== entryIds.length) {
        // Something else moved one of these entries between the read above and
        // this write (e.g. a concurrent clearing run). Throwing rolls the
        // transaction back; persisting a cycle whose proof no longer matches
        // reality is not an option, so this is caught below instead of
        // returned as a normal result.
        throw new ClearingRaceError();
      }

      await tx.insert(clearingCycles).values({
        id: cycleId,
        organizationId,
        asset: asset.toUpperCase(),
        mode: cycle.mode,
        grossTotalNanos: toNanosColumn(cycle.grossTotal),
        netTotalNanos: toNanosColumn(cycle.netTotal),
        grossTotalAtomic: toNanosColumn(cycle.grossTotal),
        netTotalAtomic: toNanosColumn(cycle.netTotal),
        entryCount: entries.length,
        instructionCount: cycle.instructions.length,
        proofHash: cycle.proofHash,
        // jsonb via JSON.stringify cannot carry a bigint; the amount is
        // serialized to its decimal string, same as every other nanos value
        // this codebase persists.
        instructions: cycle.instructions.map((instruction) => ({
          ...instruction,
          amount: instruction.amount.toString(),
        })) as unknown as Record<string, unknown>,
        openedAt,
      });

      return { ok: true, cycle };
    });
  } catch (error) {
    if (error instanceof ClearingRaceError) {
      return { ok: false, error: "Entries changed while clearing was running; try again." };
    }
    throw error;
  }
}

/**
 * Not yet built: marking a clearing cycle's instructions as actually paid.
 *
 * That requires a real payment on a real rail — the netted instructions are
 * still only obligations, exactly like the entries they replaced — and no
 * settlement rail has signing authority configured in this deployment (see
 * docs/ARC.md, docs/XRPL.md). Recording SETTLED without a real payment behind
 * it would be exactly the fabricated transaction this codebase refuses to
 * produce, so `clearing_cycles.settled_at` stays null until that exists.
 */
export const SETTLEMENT_NOT_IMPLEMENTED = true;
