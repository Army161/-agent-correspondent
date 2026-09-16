/**
 * The μLedger.
 *
 * Not a token, not a coin, not transferable: it is double-entry accounting for
 * obligations too small to be worth a transaction. A 40-nanodollar API call
 * costs more in gas than it is worth; the μLedger records it, and settlement
 * happens later, in aggregate, once the netted position is worth moving.
 *
 * Two invariants hold everywhere in this module:
 *  1. Entries are append-only. Nothing is ever edited or deleted; state changes
 *     are new entries or explicit status transitions with an audit trail.
 *  2. Every settlement is reproducible by replaying entries. If a netting run
 *     cannot be recomputed from the ledger, it is a bug, not a rounding
 *     difference.
 */

import { canonicalHash } from "../canonical/json";
import { fail, ok, violation, type Outcome } from "../errors/index";
import { absNanos, formatUsd, type Nanos } from "../units/money";

export type LedgerEntryState = "OPEN" | "NETTED" | "SETTLED" | "VOID";

export interface LedgerEntry {
  readonly entryId: string;
  readonly debtorAgentId: string;
  readonly creditorAgentId: string;
  /** Always positive: direction lives in debtor/creditor, never in the sign. */
  readonly amount: Nanos;
  readonly asset: string;
  readonly service: string;
  readonly intentId: string | null;
  readonly receiptId: string | null;
  readonly createdAt: Date;
  readonly state: LedgerEntryState;
  /**
   * Uniqueness key for the economic event behind this entry. Two entries with
   * the same key are the same obligation recorded twice.
   */
  readonly idempotencyKey: string;
  /** Clearing cycle that consumed this entry, once netted. */
  readonly cycleId?: string;
}

export interface NewLedgerEntry {
  readonly entryId: string;
  readonly debtorAgentId: string;
  readonly creditorAgentId: string;
  readonly amount: Nanos;
  readonly asset: string;
  readonly service: string;
  readonly intentId?: string | null;
  readonly receiptId?: string | null;
  readonly createdAt: Date;
  readonly idempotencyKey: string;
}

/** Canonical hash of an entry, used to detect after-the-fact mutation. */
export function hashEntry(entry: LedgerEntry): string {
  return canonicalHash({
    entryId: entry.entryId,
    debtorAgentId: entry.debtorAgentId,
    creditorAgentId: entry.creditorAgentId,
    amount: entry.amount,
    asset: entry.asset,
    service: entry.service,
    intentId: entry.intentId,
    receiptId: entry.receiptId,
    createdAt: entry.createdAt.toISOString(),
    idempotencyKey: entry.idempotencyKey,
  });
}

/**
 * Append-only μLedger.
 *
 * The idempotency index is the double-credit defence: a provider that submits
 * the same completed job twice, or a webhook that fires twice, produces one
 * obligation.
 */
export class MuLedger {
  private readonly entries: LedgerEntry[] = [];
  private readonly byId = new Map<string, LedgerEntry>();
  private readonly byIdempotencyKey = new Map<string, string>();

  /** Record a new obligation. Rejects duplicates and non-positive amounts. */
  append(entry: NewLedgerEntry): Outcome<LedgerEntry> {
    if (entry.amount <= 0n) {
      return fail(
        violation("INVALID_AMOUNT", "ledger entries must carry a positive amount", {
          amount: entry.amount,
        }),
      );
    }
    if (entry.debtorAgentId === entry.creditorAgentId) {
      return fail(
        violation("DUPLICATE_LEDGER_ENTRY", "an agent cannot owe itself", {
          agentId: entry.debtorAgentId,
        }),
      );
    }
    if (this.byId.has(entry.entryId)) {
      return fail(
        violation("DUPLICATE_LEDGER_ENTRY", `entry ${entry.entryId} already exists`, {
          entryId: entry.entryId,
        }),
      );
    }
    const existingId = this.byIdempotencyKey.get(entry.idempotencyKey);
    if (existingId) {
      return fail(
        violation(
          "DUPLICATE_LEDGER_ENTRY",
          `an entry for ${entry.idempotencyKey} already exists (${existingId}); refusing to double-credit`,
          { idempotencyKey: entry.idempotencyKey, existingEntryId: existingId },
        ),
      );
    }

    const stored: LedgerEntry = {
      entryId: entry.entryId,
      debtorAgentId: entry.debtorAgentId,
      creditorAgentId: entry.creditorAgentId,
      amount: entry.amount,
      asset: entry.asset.toUpperCase(),
      service: entry.service,
      intentId: entry.intentId ?? null,
      receiptId: entry.receiptId ?? null,
      createdAt: entry.createdAt,
      state: "OPEN",
      idempotencyKey: entry.idempotencyKey,
    };

    this.entries.push(stored);
    this.byId.set(stored.entryId, stored);
    this.byIdempotencyKey.set(stored.idempotencyKey, stored.entryId);
    return ok(stored);
  }

  get(entryId: string): LedgerEntry | undefined {
    return this.byId.get(entryId);
  }

  /** Full history, in append order. Never filtered by state. */
  all(): readonly LedgerEntry[] {
    return [...this.entries];
  }

  open(asset?: string): readonly LedgerEntry[] {
    return this.entries.filter(
      (entry) => entry.state === "OPEN" && (!asset || entry.asset === asset.toUpperCase()),
    );
  }

  /**
   * Transition entries into a cycle. Only OPEN entries may be netted, so an
   * entry can never be counted into two clearing runs.
   */
  markNetted(entryIds: readonly string[], cycleId: string): Outcome<number> {
    for (const id of entryIds) {
      const entry = this.byId.get(id);
      if (!entry) {
        return fail(violation("DUPLICATE_LEDGER_ENTRY", `unknown entry ${id}`, { entryId: id }));
      }
      if (entry.state !== "OPEN") {
        return fail(
          violation(
            "LEDGER_ENTRY_IMMUTABLE",
            `entry ${id} is ${entry.state} and cannot be netted again`,
            { entryId: id, state: entry.state },
          ),
        );
      }
    }
    for (const id of entryIds) {
      const entry = this.byId.get(id) as LedgerEntry;
      const updated: LedgerEntry = { ...entry, state: "NETTED", cycleId };
      this.byId.set(id, updated);
      this.entries[this.entries.indexOf(entry)] = updated;
    }
    return ok(entryIds.length);
  }

  markSettled(cycleId: string): Outcome<number> {
    let count = 0;
    for (const entry of [...this.entries]) {
      if (entry.cycleId !== cycleId) continue;
      if (entry.state !== "NETTED") {
        return fail(
          violation(
            "LEDGER_ENTRY_IMMUTABLE",
            `entry ${entry.entryId} is ${entry.state}; only NETTED entries can settle`,
            { entryId: entry.entryId, state: entry.state },
          ),
        );
      }
      const updated: LedgerEntry = { ...entry, state: "SETTLED" };
      this.byId.set(entry.entryId, updated);
      this.entries[this.entries.indexOf(entry)] = updated;
      count += 1;
    }
    return ok(count);
  }

  /** Receivables minus payables for one agent, across OPEN and NETTED entries. */
  position(agentId: string, asset: string): { receivable: Nanos; payable: Nanos; net: Nanos } {
    let receivable = 0n;
    let payable = 0n;
    for (const entry of this.entries) {
      if (entry.asset !== asset.toUpperCase()) continue;
      if (entry.state === "SETTLED" || entry.state === "VOID") continue;
      if (entry.creditorAgentId === agentId) receivable += entry.amount;
      if (entry.debtorAgentId === agentId) payable += entry.amount;
    }
    return { receivable, payable, net: receivable - payable };
  }

  /** Total gross obligations outstanding. */
  gross(asset: string): Nanos {
    let total = 0n;
    for (const entry of this.entries) {
      if (entry.asset !== asset.toUpperCase()) continue;
      if (entry.state === "SETTLED" || entry.state === "VOID") continue;
      total += entry.amount;
    }
    return total;
  }

  /**
   * Conservation check: with no settlements, the sum of every agent's net
   * position is exactly zero. Every obligation has two sides, so any non-zero
   * total means an entry was created or mutated outside `append`.
   */
  verifyConservation(asset: string): Outcome<true> {
    const agents = new Set<string>();
    for (const entry of this.entries) {
      agents.add(entry.debtorAgentId);
      agents.add(entry.creditorAgentId);
    }
    let total = 0n;
    for (const agent of agents) total += this.position(agent, asset).net;
    if (total !== 0n) {
      return fail(
        violation(
          "DUPLICATE_LEDGER_ENTRY",
          `ledger does not balance: net positions sum to ${formatUsd(total, { symbol: true })}`,
          { total },
        ),
      );
    }
    return ok(true);
  }

  /** Restore a ledger from persisted entries, preserving state. */
  static hydrate(entries: readonly LedgerEntry[]): MuLedger {
    const ledger = new MuLedger();
    for (const entry of entries) {
      ledger.entries.push(entry);
      ledger.byId.set(entry.entryId, entry);
      ledger.byIdempotencyKey.set(entry.idempotencyKey, entry.entryId);
    }
    return ledger;
  }
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function describeEntry(entry: LedgerEntry): string {
  return `${entry.debtorAgentId} owes ${entry.creditorAgentId} ${formatUsd(entry.amount, { symbol: true })} ${entry.asset}`;
}

export function totalAbs(values: readonly Nanos[]): Nanos {
  let total = 0n;
  for (const value of values) total += absNanos(value);
  return total;
}
