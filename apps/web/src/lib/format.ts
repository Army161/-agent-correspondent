/**
 * Display formatting.
 *
 * Every economic value that reaches a screen passes through here, so that the
 * rules — sub-cent amounts stay visible, unknown is never rendered as zero —
 * are applied in one place.
 */

import { formatUsd, type Nanos } from "@acor/core";

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
