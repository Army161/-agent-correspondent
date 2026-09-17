/**
 * Convoy Mode: a pooled budget and correlated-behaviour check across a group
 * of an organization's own agents.
 *
 * The security case a per-agent mandate cannot cover: an attacker who has
 * taken over several agents in one fleet can spread authorizations across
 * them to stay under each agent's own velocity threshold while draining the
 * fleet as a whole. A pooled ceiling and a combined velocity count catch
 * that; nothing that looks only at one agent at a time can, by construction.
 *
 * Both checks here are pure arithmetic over facts the caller gathers from the
 * ledger — never a cached counter that could drift from it. A convoy's pool
 * is *in addition to*, never instead of, each member's own individual
 * mandate: passing here does not exempt an authorization from anything else
 * in Sentinel-5 or the mandate engine.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";

export interface ConvoyPoolCheck {
  readonly poolLimitNanos: bigint;
  /** Already spent today, summed across every member of the convoy. */
  readonly spentTodayNanos: bigint;
  /** The candidate authorization's USD value. */
  readonly candidateNanos: bigint;
}

export interface ConvoyPoolResult {
  readonly allowed: boolean;
  readonly remainingNanos: bigint;
}

/**
 * Whether one more authorization fits inside the convoy's shared daily pool.
 *
 * Fails closed the same way the per-agent mandate does: a negative pool limit
 * or a candidate that cannot be compared is refused rather than guessed at.
 */
export function checkConvoyPool(input: ConvoyPoolCheck): Outcome<ConvoyPoolResult> {
  if (input.poolLimitNanos < 0n) {
    return fail(violation("INVALID_AMOUNT", "a convoy pool limit must not be negative"));
  }
  if (input.candidateNanos < 0n) {
    return fail(violation("INVALID_AMOUNT", "a candidate spend must not be negative"));
  }
  const spent = input.spentTodayNanos < 0n ? 0n : input.spentTodayNanos;
  const remaining = input.poolLimitNanos - spent;
  const allowed = input.candidateNanos <= remaining;
  return ok({ allowed, remainingNanos: remaining < 0n ? 0n : remaining });
}

export interface ConvoyVelocityCheck {
  /** Authorizations across every convoy member in the last hour. */
  readonly authorizationsLastHour: number;
  /** Distinct counterparties across every convoy member in the last hour. */
  readonly distinctCounterpartiesLastHour: number;
  readonly maxAuthorizationsPerHour: number;
  readonly maxDistinctCounterpartiesPerHour: number;
}

export interface ConvoyVelocityResult {
  readonly withinLimits: boolean;
  readonly code: "CONVOY_VELOCITY" | "CONVOY_FANOUT" | null;
}

/**
 * Whether the convoy's *combined* activity is inside its own, separately
 * configurable, velocity thresholds.
 *
 * These are typically tighter than a single agent's own threshold multiplied
 * by the convoy's member count would suggest — the whole point is to catch
 * coordinated activity that looks unremarkable member by member.
 */
export function checkConvoyVelocity(input: ConvoyVelocityCheck): ConvoyVelocityResult {
  if (input.authorizationsLastHour > input.maxAuthorizationsPerHour) {
    return { withinLimits: false, code: "CONVOY_VELOCITY" };
  }
  if (input.distinctCounterpartiesLastHour > input.maxDistinctCounterpartiesPerHour) {
    return { withinLimits: false, code: "CONVOY_FANOUT" };
  }
  return { withinLimits: true, code: null };
}
