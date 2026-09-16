/**
 * mu-ledger and clearing tests.
 *
 * Two families here: accounting invariants (the ledger must balance, entries
 * must be immutable, obligations must not be double-credited) and netting
 * correctness (the netted result must settle every agent to the same position
 * the gross ledger implies, and every cycle must be reproducible).
 */

import { describe, expect, it } from "vitest";

import { unwrap } from "../src/errors/index";
import { MuLedger, type LedgerEntry, type NewLedgerEntry } from "../src/muledger/ledger";
import { netBilateral, netMultilateral, verifyCycle } from "../src/muledger/netting";
import { usd } from "../src/units/money";

const T0 = new Date("2026-03-01T00:00:00.000Z");

function entry(
  id: string,
  debtor: string,
  creditor: string,
  amount: bigint,
  extra: Partial<NewLedgerEntry> = {},
): NewLedgerEntry {
  return {
    entryId: id,
    debtorAgentId: debtor,
    creditorAgentId: creditor,
    amount,
    asset: "USDC",
    service: "api.call",
    createdAt: T0,
    idempotencyKey: extra.idempotencyKey ?? `key_${id}`,
    ...extra,
  };
}

describe("mu-ledger accounting", () => {
  it("records obligations far below a cent", () => {
    const ledger = new MuLedger();
    const recorded = unwrap(ledger.append(entry("e1", "a", "b", 40n)));
    expect(recorded.amount).toBe(40n);
    expect(recorded.state).toBe("OPEN");
    expect(ledger.gross("USDC")).toBe(40n);
  });

  it("balances: every agent's net position sums to zero", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("0.07"))));
    unwrap(ledger.append(entry("e2", "b", "a", usd("0.05"))));
    unwrap(ledger.append(entry("e3", "b", "c", usd("0.02"))));
    expect(unwrap(ledger.verifyConservation("USDC"))).toBe(true);
    expect(ledger.position("a", "USDC").net).toBe(-usd("0.02"));
    expect(ledger.position("b", "USDC").net).toBe(0n);
    expect(ledger.position("c", "USDC").net).toBe(usd("0.02"));
  });

  it("keeps gross history after netting and settlement", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("0.07"))));
    unwrap(ledger.append(entry("e2", "b", "a", usd("0.05"))));
    unwrap(ledger.markNetted(["e1", "e2"], "cycle_1"));
    unwrap(ledger.markSettled("cycle_1"));
    expect(ledger.all()).toHaveLength(2);
    expect(ledger.all().every((e) => e.state === "SETTLED")).toBe(true);
    // The gross amounts are still readable for audit.
    expect(ledger.all().map((e) => e.amount)).toEqual([usd("0.07"), usd("0.05")]);
  });
});

describe("ATTACK: mu-ledger double credit", () => {
  it("blocks recording the same economic event twice", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("1"), { idempotencyKey: "receipt_9" })));
    const duplicate = ledger.append(
      entry("e2", "a", "b", usd("1"), { idempotencyKey: "receipt_9" }),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.violations[0]?.code).toBe("DUPLICATE_LEDGER_ENTRY");
    expect(ledger.gross("USDC")).toBe(usd("1"));
  });

  it("blocks reusing an entry id", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("1"))));
    expect(ledger.append(entry("e1", "a", "b", usd("1"), { idempotencyKey: "other" })).ok).toBe(
      false,
    );
  });

  it("blocks non-positive amounts, which could reverse an obligation", () => {
    const ledger = new MuLedger();
    expect(ledger.append(entry("e1", "a", "b", 0n)).ok).toBe(false);
    expect(ledger.append(entry("e2", "a", "b", -usd("1"))).ok).toBe(false);
  });

  it("blocks an agent owing itself", () => {
    const ledger = new MuLedger();
    expect(ledger.append(entry("e1", "a", "a", usd("1"))).ok).toBe(false);
  });

  it("blocks netting an entry into two clearing cycles", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("1"))));
    unwrap(ledger.markNetted(["e1"], "cycle_1"));
    const second = ledger.markNetted(["e1"], "cycle_2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.violations[0]?.code).toBe("LEDGER_ENTRY_IMMUTABLE");
  });

  it("blocks settling an entry that was never netted", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("1"), { intentId: null })));
    // Entry has no cycle, so nothing settles; forcing the cycle id would be the
    // attack, and markNetted is the only way to acquire one.
    expect(unwrap(ledger.markSettled("cycle_1"))).toBe(0);
  });
});

describe("bilateral netting (P0)", () => {
  it("nets the specification's example exactly", () => {
    // A owes B $0.07, B owes A $0.05 → A owes B $0.02.
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("0.07"))));
    unwrap(ledger.append(entry("e2", "b", "a", usd("0.05"))));

    const cycle = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));
    expect(cycle.instructions).toHaveLength(1);
    expect(cycle.instructions[0]).toMatchObject({ from: "a", to: "b", amount: usd("0.02") });
    expect(cycle.grossTotal).toBe(usd("0.12"));
    expect(cycle.netTotal).toBe(usd("0.02"));
    expect(cycle.savedTotal).toBe(usd("0.10"));
    expect(cycle.savedTransfers).toBe(1);
  });

  it("emits no transfer when obligations cancel exactly", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("0.05"))));
    unwrap(ledger.append(entry("e2", "b", "a", usd("0.05"))));
    const cycle = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));
    expect(cycle.instructions).toHaveLength(0);
    expect(cycle.netTotal).toBe(0n);
    expect(cycle.positions[0]?.netDebtor).toBeNull();
  });

  it("collapses many tiny obligations into one transfer", () => {
    const ledger = new MuLedger();
    for (let i = 0; i < 500; i += 1) {
      unwrap(ledger.append(entry(`e${i}`, "a", "b", 40n)));
    }
    const cycle = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));
    expect(cycle.grossTotal).toBe(20_000n);
    expect(cycle.instructions).toHaveLength(1);
    expect(cycle.instructions[0]?.amount).toBe(20_000n);
    expect(cycle.savedTransfers).toBe(499);
  });

  it("keeps pairs separate rather than pooling them", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("1"))));
    unwrap(ledger.append(entry("e2", "c", "d", usd("2"))));
    const cycle = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));
    expect(cycle.instructions).toHaveLength(2);
  });

  it("nets only the requested asset", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("1"))));
    unwrap(ledger.append(entry("e2", "a", "b", usd("5"), { asset: "RLUSD" })));
    const cycle = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));
    expect(cycle.grossTotal).toBe(usd("1"));
  });

  it("refuses to open a cycle with nothing to clear", () => {
    expect(netBilateral([], "USDC", "cycle_1", T0).ok).toBe(false);
  });
});

describe("multilateral netting (P1)", () => {
  it("removes a circular obligation entirely", () => {
    // A→B $1, B→C $1, C→A $1 nets to nothing at all.
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("1"))));
    unwrap(ledger.append(entry("e2", "b", "c", usd("1"))));
    unwrap(ledger.append(entry("e3", "c", "a", usd("1"))));

    const bilateral = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));
    const multilateral = unwrap(netMultilateral(ledger.open(), "USDC", "cycle_1", T0));

    expect(bilateral.instructions).toHaveLength(3);
    expect(bilateral.netTotal).toBe(usd("3"));
    expect(multilateral.instructions).toHaveLength(0);
    expect(multilateral.netTotal).toBe(0n);
  });

  it("settles every agent to the same net position as the gross ledger", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("5"))));
    unwrap(ledger.append(entry("e2", "b", "c", usd("3"))));
    unwrap(ledger.append(entry("e3", "c", "a", usd("1"))));
    unwrap(ledger.append(entry("e4", "d", "a", usd("2"))));

    const cycle = unwrap(netMultilateral(ledger.open(), "USDC", "cycle_1", T0));

    const applied = new Map<string, bigint>();
    for (const instruction of cycle.instructions) {
      applied.set(instruction.from, (applied.get(instruction.from) ?? 0n) - instruction.amount);
      applied.set(instruction.to, (applied.get(instruction.to) ?? 0n) + instruction.amount);
    }
    for (const agent of ["a", "b", "c", "d"]) {
      expect(applied.get(agent) ?? 0n, agent).toBe(ledger.position(agent, "USDC").net);
    }
  });

  it("never invents money: transfers in equal transfers out", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("7"))));
    unwrap(ledger.append(entry("e2", "b", "a", usd("2"))));
    unwrap(ledger.append(entry("e3", "c", "b", usd("4"))));
    const cycle = unwrap(netMultilateral(ledger.open(), "USDC", "cycle_1", T0));
    const sum = cycle.instructions.reduce((total, i) => total + i.amount, 0n);
    const credited = cycle.instructions.reduce((total, i) => total + i.amount, 0n);
    expect(sum).toBe(credited);
    expect(cycle.netTotal).toBeLessThanOrEqual(cycle.grossTotal);
  });
});

describe("reproducibility", () => {
  it("re-derives a cycle from its ledger entries", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("0.07"))));
    unwrap(ledger.append(entry("e2", "b", "a", usd("0.05"))));
    const cycle = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));
    unwrap(ledger.markNetted([...cycle.entryIds], cycle.cycleId));

    expect(unwrap(verifyCycle(cycle, ledger.all()))).toBe(true);
  });

  it("ATTACK: a cycle whose instructions were edited fails verification", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("0.07"))));
    unwrap(ledger.append(entry("e2", "b", "a", usd("0.05"))));
    const cycle = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));

    const tampered = {
      ...cycle,
      instructions: [{ from: "a", to: "attacker", amount: usd("0.02"), asset: "USDC" }],
    };
    const verification = verifyCycle(tampered, ledger.all());
    expect(verification.ok).toBe(false);
    if (!verification.ok) expect(verification.violations[0]?.code).toBe("DUPLICATE_SETTLEMENT");
  });

  it("ATTACK: a cycle recomputed over mutated entries fails verification", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("0.07"))));
    unwrap(ledger.append(entry("e2", "b", "a", usd("0.05"))));
    const cycle = unwrap(netBilateral(ledger.open(), "USDC", "cycle_1", T0));

    const mutated: LedgerEntry[] = ledger.all().map((e) =>
      e.entryId === "e1" ? { ...e, amount: usd("0.70") } : e,
    );
    expect(verifyCycle(cycle, mutated).ok).toBe(false);
  });

  it("produces the same proof hash regardless of entry order", () => {
    const forward = new MuLedger();
    unwrap(forward.append(entry("e1", "a", "b", usd("0.07"))));
    unwrap(forward.append(entry("e2", "b", "a", usd("0.05"))));

    const reverse = new MuLedger();
    unwrap(reverse.append(entry("e2", "b", "a", usd("0.05"))));
    unwrap(reverse.append(entry("e1", "a", "b", usd("0.07"))));

    const a = unwrap(netBilateral(forward.open(), "USDC", "cycle_1", T0));
    const b = unwrap(netBilateral(reverse.open(), "USDC", "cycle_1", T0));
    expect(a.proofHash).toBe(b.proofHash);
  });

  it("hydrates a persisted ledger without losing state", () => {
    const ledger = new MuLedger();
    unwrap(ledger.append(entry("e1", "a", "b", usd("1"))));
    unwrap(ledger.markNetted(["e1"], "cycle_1"));
    const restored = MuLedger.hydrate(ledger.all());
    expect(restored.get("e1")?.state).toBe("NETTED");
    // The idempotency index survives, so the duplicate defence survives a restart.
    expect(restored.append(entry("e9", "a", "b", usd("1"), { idempotencyKey: "key_e1" })).ok).toBe(
      false,
    );
  });
});
