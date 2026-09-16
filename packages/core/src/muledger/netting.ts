/**
 * Netting and clearing.
 *
 * P0 is bilateral: between any two agents, offsetting obligations cancel and a
 * single net transfer remains. P1 is multilateral: across a whole cycle, only
 * each agent's net position matters, and the set of transfers that realises
 * those positions can be much smaller than the bilateral set.
 *
 * Both are pure functions of the entries handed in. Gross history is never
 * modified, so any cycle can be recomputed and audited from the ledger alone.
 */

import { canonicalHash } from "../canonical/json";
import { fail, ok, violation, type Outcome } from "../errors/index";
import { absNanos, formatUsd, type Nanos } from "../units/money";
import { pairKey, type LedgerEntry } from "./ledger";

export interface BilateralPosition {
  readonly agentA: string;
  readonly agentB: string;
  /** Gross owed by A to B before netting. */
  readonly grossAToB: Nanos;
  /** Gross owed by B to A before netting. */
  readonly grossBToA: Nanos;
  /** After netting: who pays, and how much. `null` when it cancels exactly. */
  readonly netDebtor: string | null;
  readonly netCreditor: string | null;
  readonly netAmount: Nanos;
  readonly entryIds: readonly string[];
}

export interface SettlementInstruction {
  readonly from: string;
  readonly to: string;
  readonly amount: Nanos;
  readonly asset: string;
}

export interface ClearingCycle {
  readonly cycleId: string;
  readonly asset: string;
  readonly mode: "BILATERAL" | "MULTILATERAL";
  readonly openedAt: Date;
  readonly entryIds: readonly string[];
  /** Sum of every obligation before netting. */
  readonly grossTotal: Nanos;
  /** Sum of the transfers that actually need to move. */
  readonly netTotal: Nanos;
  /** grossTotal - netTotal: what netting saved. */
  readonly savedTotal: Nanos;
  /** Number of transfers avoided. */
  readonly savedTransfers: number;
  readonly positions: readonly BilateralPosition[];
  readonly instructions: readonly SettlementInstruction[];
  /** Canonical hash over the inputs and outputs: the reproducibility anchor. */
  readonly proofHash: string;
}

/**
 * Bilateral netting (P0).
 *
 * "A owes B $0.07, B owes A $0.05" becomes "A owes B $0.02" — one transfer
 * instead of two, and a smaller one.
 */
export function netBilateral(
  entries: readonly LedgerEntry[],
  asset: string,
  cycleId: string,
  openedAt: Date,
): Outcome<ClearingCycle> {
  const eligible = entries.filter(
    (entry) => entry.state === "OPEN" && entry.asset === asset.toUpperCase(),
  );
  if (eligible.length === 0) {
    return fail(
      violation("CONTEXT_INCOMPLETE", `no open ${asset} obligations to clear`, { asset }),
    );
  }

  const pairs = new Map<
    string,
    { a: string; b: string; aToB: Nanos; bToA: Nanos; entryIds: string[] }
  >();

  for (const entry of eligible) {
    const key = pairKey(entry.debtorAgentId, entry.creditorAgentId);
    const [first = "", second = ""] = key.split("|");
    const bucket = pairs.get(key) ?? { a: first, b: second, aToB: 0n, bToA: 0n, entryIds: [] };
    if (entry.debtorAgentId === bucket.a) bucket.aToB += entry.amount;
    else bucket.bToA += entry.amount;
    bucket.entryIds.push(entry.entryId);
    pairs.set(key, bucket);
  }

  const positions: BilateralPosition[] = [];
  const instructions: SettlementInstruction[] = [];
  let grossTotal = 0n;
  let netTotal = 0n;

  // Sorted iteration keeps the cycle — and therefore its proof hash —
  // independent of map insertion order.
  for (const key of [...pairs.keys()].sort()) {
    const bucket = pairs.get(key) as NonNullable<ReturnType<typeof pairs.get>>;
    const delta = bucket.aToB - bucket.bToA;
    grossTotal += bucket.aToB + bucket.bToA;

    const position: BilateralPosition = {
      agentA: bucket.a,
      agentB: bucket.b,
      grossAToB: bucket.aToB,
      grossBToA: bucket.bToA,
      netDebtor: delta === 0n ? null : delta > 0n ? bucket.a : bucket.b,
      netCreditor: delta === 0n ? null : delta > 0n ? bucket.b : bucket.a,
      netAmount: absNanos(delta),
      entryIds: [...bucket.entryIds].sort(),
    };
    positions.push(position);

    if (position.netDebtor && position.netCreditor && position.netAmount > 0n) {
      instructions.push({
        from: position.netDebtor,
        to: position.netCreditor,
        amount: position.netAmount,
        asset: asset.toUpperCase(),
      });
      netTotal += position.netAmount;
    }
  }

  const entryIds = eligible.map((entry) => entry.entryId).sort();
  const cycle: Omit<ClearingCycle, "proofHash"> = {
    cycleId,
    asset: asset.toUpperCase(),
    mode: "BILATERAL",
    openedAt,
    entryIds,
    grossTotal,
    netTotal,
    savedTotal: grossTotal - netTotal,
    savedTransfers: eligible.length - instructions.length,
    positions,
    instructions,
  };

  return ok({ ...cycle, proofHash: hashCycle(cycle) });
}

/**
 * Multilateral netting (P1).
 *
 * Each agent's net position across the whole cycle is computed, then debtors
 * are matched against creditors largest-first. The resulting transfer set is
 * minimal in count for the given positions and settles every agent to exactly
 * the same net position as the bilateral result — it just avoids routing money
 * around a cycle (A→B→C→A) that nets to nothing.
 */
export function netMultilateral(
  entries: readonly LedgerEntry[],
  asset: string,
  cycleId: string,
  openedAt: Date,
): Outcome<ClearingCycle> {
  const bilateral = netBilateral(entries, asset, cycleId, openedAt);
  if (!bilateral.ok) return bilateral;

  const positions = new Map<string, Nanos>();
  const eligible = entries.filter(
    (entry) => entry.state === "OPEN" && entry.asset === asset.toUpperCase(),
  );
  for (const entry of eligible) {
    positions.set(entry.debtorAgentId, (positions.get(entry.debtorAgentId) ?? 0n) - entry.amount);
    positions.set(entry.creditorAgentId, (positions.get(entry.creditorAgentId) ?? 0n) + entry.amount);
  }

  const debtors = [...positions.entries()]
    .filter(([, net]) => net < 0n)
    .map(([agent, net]) => ({ agent, amount: -net }))
    .sort((x, y) => (y.amount === x.amount ? (x.agent < y.agent ? -1 : 1) : y.amount > x.amount ? 1 : -1));
  const creditors = [...positions.entries()]
    .filter(([, net]) => net > 0n)
    .map(([agent, net]) => ({ agent, amount: net }))
    .sort((x, y) => (y.amount === x.amount ? (x.agent < y.agent ? -1 : 1) : y.amount > x.amount ? 1 : -1));

  const instructions: SettlementInstruction[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i] as { agent: string; amount: Nanos };
    const creditor = creditors[j] as { agent: string; amount: Nanos };
    const amount = debtor.amount < creditor.amount ? debtor.amount : creditor.amount;
    if (amount > 0n) {
      instructions.push({ from: debtor.agent, to: creditor.agent, amount, asset: asset.toUpperCase() });
    }
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount === 0n) i += 1;
    if (creditor.amount === 0n) j += 1;
  }

  let netTotal = 0n;
  for (const instruction of instructions) netTotal += instruction.amount;

  const cycle: Omit<ClearingCycle, "proofHash"> = {
    ...bilateral.value,
    mode: "MULTILATERAL",
    netTotal,
    savedTotal: bilateral.value.grossTotal - netTotal,
    savedTransfers: eligible.length - instructions.length,
    instructions,
  };

  return ok({ ...cycle, proofHash: hashCycle(cycle) });
}

function hashCycle(cycle: Omit<ClearingCycle, "proofHash">): string {
  return canonicalHash({
    cycleId: cycle.cycleId,
    asset: cycle.asset,
    mode: cycle.mode,
    openedAt: cycle.openedAt.toISOString(),
    entryIds: [...cycle.entryIds],
    grossTotal: cycle.grossTotal,
    netTotal: cycle.netTotal,
    instructions: cycle.instructions.map((instruction) => ({
      from: instruction.from,
      to: instruction.to,
      amount: instruction.amount,
      asset: instruction.asset,
    })),
  });
}

/**
 * Verify a recorded clearing cycle.
 *
 * A clearing run that cannot be reproduced from its inputs is not a clearing
 * run — it is an unexplained movement of money.
 */
export function verifyCycle(
  cycle: ClearingCycle,
  entries: readonly LedgerEntry[],
): Outcome<true> {
  // Two independent checks, because they catch different tampering.
  //
  // First: does the cycle commit to its own contents? Editing a settlement
  // instruction after the fact — redirecting a payout, say — leaves the stored
  // proof hash describing the instructions that *were* there.
  const selfHash = hashCycle(cycle);
  if (selfHash !== cycle.proofHash) {
    return fail(
      violation("DUPLICATE_SETTLEMENT", "clearing cycle does not match its own proof hash", {
        recorded: cycle.proofHash,
        recomputed: selfHash,
      }),
    );
  }

  // Second: do the ledger entries still produce this cycle? Re-derivation needs
  // the entries as they were when the cycle opened, i.e. OPEN rather than their
  // current NETTED/SETTLED state.
  const replay = entries
    .filter((entry) => cycle.entryIds.includes(entry.entryId))
    .map((entry) => ({ ...entry, state: "OPEN" as const }));

  const recomputed =
    cycle.mode === "BILATERAL"
      ? netBilateral(replay, cycle.asset, cycle.cycleId, cycle.openedAt)
      : netMultilateral(replay, cycle.asset, cycle.cycleId, cycle.openedAt);

  if (!recomputed.ok) return recomputed as Outcome<true>;
  if (recomputed.value.proofHash !== cycle.proofHash) {
    return fail(
      violation("DUPLICATE_SETTLEMENT", "clearing cycle does not reproduce from its ledger entries", {
        recorded: cycle.proofHash,
        recomputed: recomputed.value.proofHash,
      }),
    );
  }
  return ok(true);
}

export function describeSavings(cycle: ClearingCycle): string {
  if (cycle.grossTotal === 0n) return "no obligations";
  const pct = Number((cycle.savedTotal * 10_000n) / cycle.grossTotal) / 100;
  return `${formatUsd(cycle.grossTotal, { symbol: true })} gross → ${formatUsd(cycle.netTotal, { symbol: true })} net (${pct.toFixed(2)}% avoided, ${cycle.savedTransfers} fewer transfers)`;
}
