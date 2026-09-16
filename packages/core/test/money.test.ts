import { describe, expect, it } from "vitest";

import {
  applyBps,
  baseUnitsToNanos,
  formatUsd,
  nanosToBaseUnits,
  parseUsd,
  slippageBps,
  usd,
} from "../src/units/money";

describe("nanodollar parsing", () => {
  it("parses whole and fractional dollars exactly", () => {
    expect(usd("1")).toBe(1_000_000_000n);
    expect(usd("0.025")).toBe(25_000_000n);
    expect(usd("0.000000001")).toBe(1n);
    expect(usd("1234.567891234")).toBe(1_234_567_891_234n);
  });

  it("never loses precision through float arithmetic", () => {
    // The canonical float failure: 0.1 + 0.2 !== 0.3.
    expect(usd("0.1") + usd("0.2")).toBe(usd("0.3"));
  });

  it("rejects amounts finer than one nanodollar instead of rounding them", () => {
    const result = parseUsd("0.0000000001");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("PRECISION_LOSS");
  });

  it("rejects non-numeric and non-finite input", () => {
    for (const bad of ["", "abc", "1.2.3", "1e5", " ", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseUsd(bad as string | number).ok).toBe(false);
    }
  });

  it("round-trips through formatting", () => {
    for (const value of ["0.01", "1.00", "0.000000040", "999999.999999999"]) {
      const nanos = usd(value);
      expect(usd(formatUsd(nanos))).toBe(nanos);
    }
  });

  it("shows sub-cent amounts rather than collapsing them to $0.00", () => {
    expect(formatUsd(40n, { symbol: true })).toBe("$0.00000004");
    expect(formatUsd(usd("0.021"), { symbol: true })).toBe("$0.021");
  });
});

describe("on-chain unit conversion", () => {
  it("converts USDC (6 decimals) on Arc", () => {
    const result = nanosToBaseUnits(usd("1.50"), "ARC", "USDC");
    expect(result.ok && result.value).toBe(1_500_000n);
  });

  it("converts RLUSD on Arc at 18 decimals, not 6", () => {
    const result = nanosToBaseUnits(usd("1"), "ARC", "RLUSD");
    expect(result.ok && result.value).toBe(1_000_000_000_000_000_000n);
  });

  it("ATTACK: a decimal mismatch must not silently move 10x the money", () => {
    // $1 in USDC base units is 1_000_000; in an 18-decimal token it is 1e18.
    // Reading one as the other is the §23 parity failure this guards.
    const usdc = nanosToBaseUnits(usd("1"), "ARC", "USDC");
    const rlusd = nanosToBaseUnits(usd("1"), "ARC", "RLUSD");
    expect(usdc.ok && rlusd.ok && usdc.value).not.toBe(rlusd.ok && rlusd.value);
    // Both must round-trip back to exactly one dollar.
    expect(usdc.ok && baseUnitsToNanos(usdc.value, "ARC", "USDC")).toMatchObject({
      ok: true,
      value: usd("1"),
    });
    expect(rlusd.ok && baseUnitsToNanos(rlusd.value, "ARC", "RLUSD")).toMatchObject({
      ok: true,
      value: usd("1"),
    });
  });

  it("refuses to round an authorized amount that the rail cannot express", () => {
    // $0.0000005 has more precision than USDC's 6 decimals can carry.
    const result = nanosToBaseUnits(usd("0.0000005"), "ARC", "USDC");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("PRECISION_LOSS");
  });

  it("rounds only when the caller explicitly asks", () => {
    expect(nanosToBaseUnits(usd("0.0000005"), "ARC", "USDC", "down")).toMatchObject({
      ok: true,
      value: 0n,
    });
    expect(nanosToBaseUnits(usd("0.0000005"), "ARC", "USDC", "up")).toMatchObject({
      ok: true,
      value: 1n,
    });
  });

  it("rejects unknown assets", () => {
    expect(nanosToBaseUnits(usd("1"), "ARC", "DOGE").ok).toBe(false);
  });
});

describe("basis points", () => {
  it("applies bps with half-up rounding", () => {
    expect(applyBps(usd("100"), 50)).toBe(usd("0.5"));
    expect(applyBps(usd("1"), 10_000)).toBe(usd("1"));
  });

  it("measures slippage conservatively (rounds against the user)", () => {
    expect(slippageBps(usd("1"), usd("1"))).toBe(0);
    expect(slippageBps(usd("1"), usd("0.99"))).toBe(100);
    // A drift that is not a whole number of bps rounds up, never down:
    // 0.00505 / 1.00 is 50.5 bps, which must be reported as 51, not 50.
    expect(slippageBps(usd("1"), usd("0.99495"))).toBe(51);
    // A drift of half a basis point still registers as one.
    expect(slippageBps(usd("1"), usd("0.999949"))).toBe(1);
  });
});
