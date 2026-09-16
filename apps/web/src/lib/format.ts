/**
 * Display formatting.
 *
 * Every economic value that reaches a screen passes through here, so that the
 * rules — sub-cent amounts stay visible, unknown is never rendered as zero —
 * are applied in one place.
 */

import { formatAmount, formatUsd, type AssetAmount, type Nanos, type UsdValue } from "@acor/core";

/** A value the platform does not have. Never rendered as `$0.00`. */
export const AWAITING = "AWAITING DATA";
export const NOT_CONNECTED = "NOT CONNECTED";

/**
 * Render an amount exactly.
 *
 * Never rounds. A capability priced at $0.021 shows as `$0.021`, not `$0.02`:
 * rounding a machine-scale price to cents throws away most of the information
 * in it, and this product's whole premise is that those digits matter.
 * Large amounts get thousands separators; the fraction is the shortest exact
 * representation, with at least two decimal places.
 */
export function usdDisplay(nanos: Nanos | null | undefined, fallback = AWAITING): string {
  if (nanos === null || nanos === undefined) return fallback;
  return formatUsd(nanos, { symbol: true, grouped: true });
}

/**
 * Render a quantity of an asset, in that asset.
 *
 * Never converts and never implies dollars: 12 XRP renders as `12 XRP`, because
 * that is what it is. What it is worth is a separate question with a separate
 * answer, rendered by `usdValueDisplay`.
 */
export function assetDisplay(amount: AssetAmount | null | undefined, fallback = AWAITING): string {
  if (!amount) return fallback;
  return formatAmount(amount, { grouped: true, minDecimals: 2 });
}

/**
 * Render a USD valuation, or say that there isn't one.
 *
 * An asset with no registered peg and no live price has no dollar figure, and
 * the honest rendering of that is a dash with an explanation — not `$0.00`,
 * which would read as "this is worth nothing".
 */
export function usdValueDisplay(value: UsdValue | null | undefined): string {
  if (!value) return NO_VALUATION;
  return formatUsd(value.nanos, { symbol: true, grouped: true });
}

/** Shown where a USD figure would go when the asset cannot be valued. */
export const NO_VALUATION = "NO PRICE";

export function valuationSourceLabel(value: UsdValue | null | undefined): string | null {
  if (!value) return null;
  switch (value.source.kind) {
    case "PEG":
      return `peg · ${value.source.authority}`;
    case "ORACLE":
      return `price · ${value.source.name}`;
    case "MANUAL":
      return `manual · ${value.source.note}`;
  }
}

export function scoreDisplay(score: number | null | undefined): string {
  return score === null || score === undefined ? "—" : String(score);
}

export function percentDisplay(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? "—" : `${(rate * 100).toFixed(1)}%`;
}

export function relativeTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const value = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.round((Date.now() - value.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  const abs = Math.abs(seconds);
  if (abs < 60) return seconds >= 0 ? `${abs}s ago` : `in ${abs}s`;
  if (abs < 3600) return seconds >= 0 ? `${Math.round(abs / 60)}m ago` : `in ${Math.round(abs / 60)}m`;
  if (abs < 86400) return seconds >= 0 ? `${Math.round(abs / 3600)}h ago` : `in ${Math.round(abs / 3600)}h`;
  return value.toISOString().slice(0, 10);
}

export function truncateMiddle(value: string, lead = 8, tail = 6): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function latencyDisplay(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
