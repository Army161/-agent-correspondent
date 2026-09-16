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

export function usdDisplay(nanos: Nanos | null | undefined, fallback = AWAITING): string {
  if (nanos === null || nanos === undefined) return fallback;
  return formatUsd(nanos, { symbol: true, grouped: true });
}

/**
 * Amounts below a cent are the normal case here, so they get their full
 * precision; larger amounts are rounded to cents for scanability.
 */
export function usdSmart(nanos: Nanos | null | undefined, fallback = AWAITING): string {
  if (nanos === null || nanos === undefined) return fallback;
  const magnitude = nanos < 0n ? -nanos : nanos;
  if (magnitude > 0n && magnitude < 10_000_000n) {
    return formatUsd(nanos, { symbol: true });
  }
  return formatUsd(nanos, { symbol: true, decimals: 2, grouped: true });
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
