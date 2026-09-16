/**
 * Exact decimal ↔ atomic-unit conversion.
 *
 * This is the primitive every rail boundary depends on. It replaces the
 * `BigInt(Math.round(Number(amount) * 10 ** decimals))` pattern, which is
 * wrong for financial amounts in three separate ways: `Number` loses precision
 * above 2^53, `*` introduces binary rounding error, and `Math.round` hides
 * both. There is no float path through any function in this module.
 */

import { describe, expect, it } from "vitest";

import { formatAtomic, parseDecimalToAtomic, scaleAtomic } from "../src/units/decimal";

function unwrapAtomic(result: ReturnType<typeof parseDecimalToAtomic>): bigint {
  if (!result.ok) throw new Error(result.violations[0]?.message ?? "parse failed");
  return result.value;
}

describe("parseDecimalToAtomic", () => {
  it("parses whole and fractional values at the asset's own scale", () => {
    expect(unwrapAtomic(parseDecimalToAtomic("1", 6))).toBe(1_000_000n);
    expect(unwrapAtomic(parseDecimalToAtomic("0.000001", 6))).toBe(1n);
    expect(unwrapAtomic(parseDecimalToAtomic("1.000001", 6))).toBe(1_000_001n);
    expect(unwrapAtomic(parseDecimalToAtomic("0", 6))).toBe(0n);
    expect(unwrapAtomic(parseDecimalToAtomic("1", 18))).toBe(10n ** 18n);
    expect(unwrapAtomic(parseDecimalToAtomic("1", 0))).toBe(1n);
  });

  it("handles values far beyond Number.MAX_SAFE_INTEGER exactly", () => {
    // 10 billion units of an 18-decimal token is 1e28 — about 2^93.
    const atomic = unwrapAtomic(parseDecimalToAtomic("10000000000.000000000000000001", 18));
    expect(atomic).toBe(10_000_000_000n * 10n ** 18n + 1n);
    // The float path would have silently lost that trailing 1.
    expect(atomic).not.toBe(BigInt(Math.round(Number("10000000000.000000000000000001") * 1e18)));
  });

  it("does not lose the last digit of a large 6-decimal balance", () => {
    const atomic = unwrapAtomic(parseDecimalToAtomic("123456789012.345679", 6));
    expect(atomic).toBe(123_456_789_012_345_679n);
    expect(formatAtomic(atomic, 6)).toBe("123456789012.345679");
  });

  it("rejects excess precision rather than rounding it away", () => {
    const result = parseDecimalToAtomic("0.0000001", 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("PRECISION_LOSS");
  });

  it("accepts trailing zeros beyond the scale, since they lose nothing", () => {
    expect(unwrapAtomic(parseDecimalToAtomic("1.0000000000", 6))).toBe(1_000_000n);
    expect(unwrapAtomic(parseDecimalToAtomic("0.1000", 2))).toBe(10n);
  });

  it("rejects malformed input instead of coercing it", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "1.2.3",
      "1e6",
      "1E6",
      "0x10",
      "1,000",
      "--1",
      "1-",
      ".",
      "1..2",
      "NaN",
      "Infinity",
      "1 000",
    ]) {
      const result = parseDecimalToAtomic(bad, 6);
      expect(result.ok, `"${bad}" must be rejected`).toBe(false);
    }
  });

  it("accepts a leading sign and a bare fractional form", () => {
    expect(unwrapAtomic(parseDecimalToAtomic("-1.5", 2))).toBe(-150n);
    expect(unwrapAtomic(parseDecimalToAtomic("+1.5", 2))).toBe(150n);
    expect(unwrapAtomic(parseDecimalToAtomic(".5", 2))).toBe(50n);
    expect(unwrapAtomic(parseDecimalToAtomic("5.", 2))).toBe(500n);
  });

  it("rejects a negative value when the caller forbids one", () => {
    const result = parseDecimalToAtomic("-1", 6, { allowNegative: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("INVALID_AMOUNT");
  });

  it("rejects an implausible scale rather than producing a nonsense number", () => {
    expect(parseDecimalToAtomic("1", -1).ok).toBe(false);
    expect(parseDecimalToAtomic("1", 78).ok).toBe(false);
  });

  it("accepts a bigint as an exact whole-unit quantity", () => {
    expect(unwrapAtomic(parseDecimalToAtomic(3n, 6))).toBe(3_000_000n);
  });
});

describe("formatAtomic", () => {
  it("round-trips every parsed value", () => {
    for (const [value, decimals] of [
      ["1", 6],
      ["0.000001", 6],
      ["123456789012.345679", 6],
      ["0.000000000000000001", 18],
      ["-1.5", 2],
      ["0", 6],
    ] as const) {
      const atomic = unwrapAtomic(parseDecimalToAtomic(value, decimals));
      expect(unwrapAtomic(parseDecimalToAtomic(formatAtomic(atomic, decimals), decimals))).toBe(
        atomic,
      );
    }
  });

  it("renders the shortest exact form, never scientific notation", () => {
    expect(formatAtomic(1n, 18)).toBe("0.000000000000000001");
    expect(formatAtomic(10n ** 18n, 18)).toBe("1");
    expect(formatAtomic(1_500_000n, 6)).toBe("1.5");
    expect(formatAtomic(0n, 6)).toBe("0");
    expect(formatAtomic(-150n, 2)).toBe("-1.5");
  });

  it("pads a minimum number of decimals when asked", () => {
    expect(formatAtomic(10n ** 18n, 18, { minDecimals: 2 })).toBe("1.00");
    expect(formatAtomic(1_500_000n, 6, { minDecimals: 2 })).toBe("1.50");
  });

  it("groups the integer part when asked", () => {
    expect(formatAtomic(1_234_567_000_000n, 6, { grouped: true })).toBe("1,234,567");
  });
});

describe("scaleAtomic", () => {
  it("rescales between decimal scales exactly", () => {
    expect(scaleAtomic(1_000_000n, 6, 18)).toMatchObject({ ok: true, value: 10n ** 18n });
    expect(scaleAtomic(10n ** 18n, 18, 6)).toMatchObject({ ok: true, value: 1_000_000n });
  });

  it("refuses to drop a non-zero remainder unless told how to round", () => {
    const exact = scaleAtomic(1n, 18, 6);
    expect(exact.ok).toBe(false);
    if (!exact.ok) expect(exact.violations[0]?.code).toBe("PRECISION_LOSS");
    expect(scaleAtomic(1n, 18, 6, "down")).toMatchObject({ ok: true, value: 0n });
    expect(scaleAtomic(1n, 18, 6, "up")).toMatchObject({ ok: true, value: 1n });
  });

  it("rounds a negative remainder away from zero for 'up' and toward zero for 'down'", () => {
    expect(scaleAtomic(-1n, 18, 6, "down")).toMatchObject({ ok: true, value: -1n });
    expect(scaleAtomic(-1n, 18, 6, "up")).toMatchObject({ ok: true, value: 0n });
  });
});
