/**
 * Nanodollar money math.
 *
 * Every value that can become an obligation is an integer count of
 * *nanodollars* (1 USD = 1_000_000_000 nanos). Floats never touch an amount:
 * `0.1 + 0.2 !== 0.3` is a rounding bug in a spreadsheet and a loss of funds in
 * a settlement engine.
 *
 * Nanodollars also let the mu-ledger hold obligations far below anything worth
 * broadcasting on a chain (a 40-nanodollar API call is a real debt here).
 */

import { fail, ok, violation, type Outcome } from "../errors/index";

export type Nanos = bigint;

export const NANOS_PER_USD = 1_000_000_000n;
export const NANO_DECIMALS = 9;

export type SettlementAsset = "USDC" | "RLUSD" | "XRP" | "EURC";

export interface AssetSpec {
  readonly symbol: SettlementAsset;
  /** Decimals of the smallest on-chain unit of this asset on the given rail. */
  readonly decimals: number;
  /** True when one unit of the asset is intended to track one US dollar. */
  readonly usdPegged: boolean;
}

/**
 * Asset decimals are rail-specific: USDC is 6 decimals on Arc/EVM, XRP is 6
 * (drops). RLUSD is 6 on XRPL issued-currency rails as integrated here and 18
 * on EVM; the EVM variant is registered separately so a conversion can never
 * silently pick the wrong scale.
 */
const ASSETS: Readonly<Record<string, AssetSpec>> = Object.freeze({
  USDC: { symbol: "USDC", decimals: 6, usdPegged: true },
  RLUSD: { symbol: "RLUSD", decimals: 6, usdPegged: true },
  EURC: { symbol: "EURC", decimals: 6, usdPegged: false },
  XRP: { symbol: "XRP", decimals: 6, usdPegged: false },
});

const EVM_DECIMAL_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({
  "ARC:USDC": 6,
  "ARC:RLUSD": 18,
  "ARC:EURC": 6,
});

export function assetSpec(symbol: string): AssetSpec | undefined {
  return ASSETS[symbol];
}

export function isSettlementAsset(symbol: string): symbol is SettlementAsset {
  return symbol in ASSETS;
}

/** On-chain decimals for an asset on a specific network. */
export function assetDecimals(network: string, symbol: string): Outcome<number> {
  const override = EVM_DECIMAL_OVERRIDES[`${network.toUpperCase()}:${symbol.toUpperCase()}`];
  if (override !== undefined) return ok(override);
  const spec = ASSETS[symbol.toUpperCase()];
  if (!spec) {
    return fail(violation("UNKNOWN_ASSET", `unknown asset ${symbol}`, { symbol, network }));
  }
  return ok(spec.decimals);
}

const DECIMAL_RE = /^-?(?:\d+)(?:\.\d+)?$/;

/**
 * Parse a human decimal string into nanos with no rounding, ever.
 *
 * `"0.000000001"` is the smallest representable value; anything finer is a
 * `PRECISION_LOSS` violation rather than a silent truncation. Accepting a
 * number is allowed for ergonomics but restricted to safe integers-in-disguise
 * by round-tripping through the string form.
 */
export function parseUsd(input: string | number | bigint): Outcome<Nanos> {
  if (typeof input === "bigint") return ok(input * NANOS_PER_USD);
  const raw = typeof input === "number" ? numberToDecimalString(input) : input.trim();
  if (raw === null) {
    return fail(violation("INVALID_AMOUNT", `amount is not a finite decimal: ${String(input)}`));
  }
  if (!DECIMAL_RE.test(raw)) {
    return fail(violation("INVALID_AMOUNT", `amount is not a decimal string: ${raw}`, { raw }));
  }
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > NANO_DECIMALS) {
    return fail(
      violation("PRECISION_LOSS", `amount ${raw} is finer than 1 nanodollar`, {
        raw,
        maxDecimals: NANO_DECIMALS,
      }),
    );
  }
  const padded = fraction.padEnd(NANO_DECIMALS, "0");
  const magnitude = BigInt(whole) * NANOS_PER_USD + BigInt(padded === "" ? "0" : padded);
  return ok(negative ? -magnitude : magnitude);
}

function numberToDecimalString(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  // Exponential notation ("1e-7") would break the decimal regex.
  if (Math.abs(value) < 1e-6 || Math.abs(value) >= 1e21) {
    const fixed = value.toFixed(NANO_DECIMALS);
    return Number(fixed) === value ? fixed : String(value);
  }
  return String(value);
}

/** Parse, or throw. Only for constants and test fixtures — never for input. */
export function usd(input: string | number | bigint): Nanos {
  const parsed = parseUsd(input);
  if (!parsed.ok) {
    throw new Error(`usd(${String(input)}): ${parsed.violations[0]?.message ?? "invalid"}`);
  }
  return parsed.value;
}

export interface FormatUsdOptions {
  /** Fixed number of decimals. Defaults to the shortest exact representation. */
  readonly decimals?: number;
  /** Render a leading `$`. */
  readonly symbol?: boolean;
  /** Group the integer part with commas. */
  readonly grouped?: boolean;
}

/** Render nanos as an exact decimal string. Never rounds away a non-zero tail silently. */
export function formatUsd(nanos: Nanos, options: FormatUsdOptions = {}): string {
  const { symbol = false, grouped = false } = options;
  const negative = nanos < 0n;
  const magnitude = negative ? -nanos : nanos;
  const whole = magnitude / NANOS_PER_USD;
  const fraction = (magnitude % NANOS_PER_USD).toString().padStart(NANO_DECIMALS, "0");

  let fractionOut: string;
  if (options.decimals === undefined) {
    fractionOut = fraction.replace(/0+$/, "");
    if (fractionOut.length < 2) fractionOut = fractionOut.padEnd(2, "0");
  } else {
    const d = Math.max(0, Math.min(NANO_DECIMALS, options.decimals));
    fractionOut = fraction.slice(0, d);
  }

  const wholeOut = grouped ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole.toString();
  const body = fractionOut.length > 0 ? `${wholeOut}.${fractionOut}` : wholeOut;
  return `${negative ? "-" : ""}${symbol ? "$" : ""}${body}`;
}

/**
 * Render a value that may be far below a cent without lying about it.
 * `$0.000000040` stays visible instead of collapsing to `$0.00`.
 */
export function formatUsdPrecise(nanos: Nanos): string {
  return formatUsd(nanos, { symbol: true });
}

export type RoundingMode = "exact" | "down" | "up";

/**
 * Convert nanos to an asset's smallest on-chain unit.
 *
 * `"exact"` is the default everywhere a user authorized a specific number:
 * if $0.0000005 cannot be expressed in USDC's 6 decimals, the caller must
 * decide what to do — the converter will not quietly move the money.
 */
export function nanosToBaseUnits(
  nanos: Nanos,
  network: string,
  asset: string,
  rounding: RoundingMode = "exact",
): Outcome<bigint> {
  const decimals = assetDecimals(network, asset);
  if (!decimals.ok) return decimals as Outcome<bigint>;
  const d = decimals.value;
  if (d > NANO_DECIMALS) {
    return ok(nanos * 10n ** BigInt(d - NANO_DECIMALS));
  }
  const divisor = 10n ** BigInt(NANO_DECIMALS - d);
  const quotient = nanos / divisor;
  const remainder = nanos % divisor;
  if (remainder === 0n) return ok(quotient);
  switch (rounding) {
    case "exact":
      return fail(
        violation(
          "PRECISION_LOSS",
          `${formatUsd(nanos)} USD cannot be represented exactly in ${asset} on ${network}`,
          { asset, network, decimals: d, nanos },
        ),
      );
    case "down":
      return ok(nanos < 0n ? quotient - 1n : quotient);
    case "up":
      return ok(nanos < 0n ? quotient : quotient + 1n);
  }
}

/** Convert an asset's smallest on-chain unit back to nanos. */
export function baseUnitsToNanos(
  base: bigint,
  network: string,
  asset: string,
  rounding: RoundingMode = "exact",
): Outcome<Nanos> {
  const decimals = assetDecimals(network, asset);
  if (!decimals.ok) return decimals as Outcome<Nanos>;
  const d = decimals.value;
  if (d <= NANO_DECIMALS) {
    return ok(base * 10n ** BigInt(NANO_DECIMALS - d));
  }
  const divisor = 10n ** BigInt(d - NANO_DECIMALS);
  const quotient = base / divisor;
  const remainder = base % divisor;
  if (remainder === 0n) return ok(quotient);
  if (rounding === "exact") {
    return fail(
      violation("PRECISION_LOSS", `${base} base units of ${asset} is finer than 1 nanodollar`, {
        asset,
        network,
        decimals: d,
      }),
    );
  }
  return ok(rounding === "down" ? quotient : quotient + 1n);
}

export function maxNanos(a: Nanos, b: Nanos): Nanos {
  return a > b ? a : b;
}

export function minNanos(a: Nanos, b: Nanos): Nanos {
  return a < b ? a : b;
}

export function absNanos(a: Nanos): Nanos {
  return a < 0n ? -a : a;
}

export function sumNanos(values: Iterable<Nanos>): Nanos {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/** Basis points applied to nanos, rounded half-up. 1 bps = 0.01%. */
export function applyBps(nanos: Nanos, bps: number): Nanos {
  invariantBps(bps);
  const scaled = nanos * BigInt(Math.round(bps * 100));
  const divisor = 1_000_000n; // 10_000 bps * 100 sub-bps
  const quotient = scaled / divisor;
  const remainder = scaled % divisor;
  const half = divisor / 2n;
  if (remainder >= half) return quotient + 1n;
  if (remainder <= -half) return quotient - 1n;
  return quotient;
}

/** Slippage between an expected and an actual amount, in basis points (rounded up). */
export function slippageBps(expected: Nanos, actual: Nanos): number {
  if (expected === 0n) return actual === 0n ? 0 : Number.POSITIVE_INFINITY;
  const delta = absNanos(expected - actual);
  const bps = (delta * 10_000n) / absNanos(expected);
  const exact = (delta * 10_000n) % absNanos(expected) === 0n;
  return Number(bps) + (exact ? 0 : 1);
}

function invariantBps(bps: number): void {
  if (!Number.isFinite(bps) || bps < 0) {
    throw new Error(`invalid basis points: ${bps}`);
  }
}
