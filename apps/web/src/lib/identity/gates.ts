/**
 * Where identity verification is actually enforced.
 *
 * Kept in one module so the answer to "what needs KYC?" is a list you can read,
 * not something to be discovered by grepping for the gate.
 */

import "server-only";

import { requireVerification } from "./index";

/**
 * Networks on which value moves for real.
 *
 * The μLedger records obligations and moves nothing. A testnet moves nothing of
 * value. Everything else does, and needs a verified identity behind it.
 */
const NON_VALUE_NETWORKS = new Set(["MULEDGER"]);

export function movesRealValue(network: string): boolean {
  if (NON_VALUE_NETWORKS.has(network)) return false;
  return !network.endsWith("_TESTNET");
}

export interface GateResult {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/**
 * Whether this organization may authorize a payment on this network.
 *
 * Called before the relay sees a signed intent. The relay's own checks are
 * about the intent; this one is about who is behind the account, and it is
 * cheaper and clearer to answer first.
 */
export async function canAuthorizeOn(
  organizationId: string,
  network: string,
): Promise<GateResult> {
  if (!movesRealValue(network)) return { allowed: true, reason: null };

  const decision = await requireVerification(organizationId, "LIVE_SETTLEMENT");
  return {
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.remedy,
  };
}
