/**
 * Exact decimal ↔ atomic-unit conversion.
 *
 * Every rail boundary in the system passes through here. There is no float path
 * through any function in this module, deliberately: the pattern this replaces —
 *
 *     BigInt(Math.round(Number(amount) * 10 ** decimals))
 *
 * — is wrong for financial amounts in three independent ways. `Number` silently
 * loses precision above 2^53, the multiplication introduces binary rounding
 * error, and `Math.round` conceals both. An 18-decimal token balance exceeds
 * `Number.MAX_SAFE_INTEGER` at about 0.009 tokens.
 *
 * Excess precision is an error rather than a rounding opportunity. If a caller
 * wants to round, it must say so and say which direction.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";

/** Widest scale we will accept. uint256 tops out near 10^77. */
export const MAX_DECIMALS = 36;

/**
 * A decimal literal: optional sign, then digits with at most one point.
 * Exponent notation is rejected — `1e6` is ambiguous about precision and has no
 * place in a wire format for money.
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export interface ParseDecimalOptions {
  /** Reject negatives outright. Defaults to allowing them. */
  readonly allowNegative?: boolean;
}

/**
 * Parse a decimal string into an integer count of an asset's smallest unit.
 *
 * `parseDecimalToAtomic("0.021", 6)` → `21000n` (USDC's smallest unit).
 *
 * Trailing zeros beyond the scale are accepted because they carry no
 * information: `"1.0000000000"` at 6 decimals is exactly `1000000n`. A non-zero
 * digit beyond the scale is `PRECISION_LOSS`, because honouring it is
 * impossible and discarding it moves someone's money.
 */
export function parseDecimalToAtomic(
  input: string | bigint,
  decimals: number,
  options: ParseDecimalOptions = {},
): Outcome<bigint> {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    return fail(
      violation("INVALID_AMOUNT", `unsupported decimal scale: ${decimals}`, { decimals }),
    );
  }

  const scale = 10n ** BigInt(decimals);

  if (typeof input === "bigint") {
    const atomic = input * scale;
    if (options.allowNegative === false && atomic < 0n) {
      return fail(violation("INVALID_AMOUNT", "amount must not be negative"));
    }
    return ok(atomic);
  }

  const raw = input.trim();
  if (!DECIMAL_RE.test(raw)) {
    return fail(
      violation("INVALID_AMOUNT", `not a decimal literal: ${JSON.stringify(input)}`, { raw }),
    );
  }

  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const [wholePart = "", fractionPart = ""] = unsigned.split(".");
  const whole = wholePart === "" ? "0" : wholePart;

  // Digits past the asset's scale must all be zero, or the value is not
  // representable on this rail at all.
  const significant = fractionPart.slice(0, decimals);
  const overflow = fractionPart.slice(decimals);
  if (/[1-9]/.test(overflow)) {
    return fail(
      violation(
        "PRECISION_LOSS",
        `${raw} has more precision than ${decimals} decimal places can represent`,
        { raw, decimals },
      ),
    );
  }

  const magnitude = BigInt(whole) * scale + BigInt(significant.padEnd(decimals, "0") || "0");
  const atomic = negative ? -magnitude : magnitude;

  if (options.allowNegative === false && atomic < 0n) {
    return fail(violation("INVALID_AMOUNT", "amount must not be negative", { raw }));
  }

  return ok(atomic);
}

export interface FormatAtomicOptions {
  /** Pad the fraction to at least this many places. */
  readonly minDecimals?: number;
  /** Group the integer part with commas. */
  readonly grouped?: boolean;
}

/**
 * Render an atomic quantity as an exact decimal string.
 *
 * Never rounds, never uses scientific notation, and never returns something a
 * subsequent `parseDecimalToAtomic` would read back as a different number.
 */
export function formatAtomic(
  atomic: bigint,
  decimals: number,
  options: FormatAtomicOptions = {},
): string {
  const negative = atomic < 0n;
  const magnitude = negative ? -atomic : atomic;
  const scale = 10n ** BigInt(decimals);

  const whole = (magnitude / scale).toString(10);
  let fraction = decimals === 0 ? "" : (magnitude % scale).toString(10).padStart(decimals, "0");

  fraction = fraction.replace(/0+$/, "");
  const minDecimals = options.minDecimals ?? 0;
  if (fraction.length < minDecimals) fraction = fraction.padEnd(minDecimals, "0");

  const wholeOut = options.grouped
    ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : whole;

  const body = fraction.length > 0 ? `${wholeOut}.${fraction}` : wholeOut;
  return negative ? `-${body}` : body;
}

export type RescaleRounding = "exact" | "down" | "up";

/**
 * Convert an atomic quantity from one decimal scale to another.
 *
 * `"exact"` is the default everywhere a caller is moving a specific authorized
 * number: if the value cannot be represented at the target scale, the caller
 * must decide what to do rather than have the converter quietly pick.
 *
 * `"down"` truncates toward negative infinity and `"up"` toward positive
 * infinity, so a fee rounded `"up"` is always at least the true fee and a payout
 * rounded `"down"` never exceeds it.
 */
export function scaleAtomic(
  atomic: bigint,
  fromDecimals: number,
  toDecimals: number,
  rounding: RescaleRounding = "exact",
): Outcome<bigint> {
  if (
    !Number.isInteger(fromDecimals) ||
    !Number.isInteger(toDecimals) ||
    fromDecimals < 0 ||
    toDecimals < 0 ||
    fromDecimals > MAX_DECIMALS ||
    toDecimals > MAX_DECIMALS
  ) {
    return fail(
      violation("INVALID_AMOUNT", `unsupported decimal scale: ${fromDecimals} → ${toDecimals}`),
    );
  }

  if (toDecimals >= fromDecimals) {
    return ok(atomic * 10n ** BigInt(toDecimals - fromDecimals));
  }

  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  const quotient = atomic / divisor; // truncates toward zero
  const remainder = atomic % divisor;
  if (remainder === 0n) return ok(quotient);

  switch (rounding) {
    case "exact":
      return fail(
        violation(
          "PRECISION_LOSS",
          `value cannot be represented exactly at ${toDecimals} decimal places`,
          { fromDecimals, toDecimals },
        ),
      );
    case "down":
      return ok(atomic < 0n ? quotient - 1n : quotient);
    case "up":
      return ok(atomic < 0n ? quotient : quotient + 1n);
  }
}
