/**
 * The EconomicIntent is the unit of authorization in Agent Correspondent.
 *
 * It is what a human (or a mandate-bound agent) signs, and it is the only thing
 * a settlement adapter is allowed to act on. Everything the executor is
 * permitted to do is inside the struct; anything not stated is forbidden.
 */

import { z } from "zod";

import { parseUsd, type Nanos } from "../units/money";
import { ASSET_SYMBOLS, NETWORK_IDS } from "../mandate/schema";

export const INTENT_VERSION = 1 as const;

export const SETTLEMENT_RAILS = [
  "X402",
  "CIRCLE_NANOPAYMENT",
  "ERC8183_ESCROW",
  "XRPL_PAYMENT",
  "XRPL_PATHFINDING",
  "XRPL_ESCROW",
  "MULEDGER",
] as const;

export type SettlementRail = (typeof SETTLEMENT_RAILS)[number];

const nanoAmount = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value, ctx): Nanos => {
    const parsed = parseUsd(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.violations[0]?.message ?? "invalid amount" });
      return 0n;
    }
    return parsed.value;
  });

const nonNegative = nanoAmount.refine((n) => n >= 0n, { message: "amount must not be negative" });

const hex32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "must be a 0x-prefixed 32-byte lowercase hex string");

const isoTimestamp = z
  .union([z.string(), z.date()])
  .transform((value, ctx): number => {
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({ code: "custom", message: `invalid timestamp: ${String(value)}` });
      return 0;
    }
    // Canonical time is whole seconds: milliseconds do not survive a round trip
    // through a uint256 on-chain deadline.
    return Math.floor(ms / 1000);
  });

export const economicIntentSchema = z.object({
  intentId: z.string().min(3).max(128),
  version: z.literal(INTENT_VERSION),
  buyerAgentId: z.string().min(1).max(128),
  providerAgentId: z.string().min(1).max(128),
  /** Human-readable service identifier, e.g. `research.summarize`. */
  service: z.string().min(1).max(256),
  /** Hash of the full service request payload the provider must perform. */
  serviceHash: hex32,
  /** Hard ceiling on everything that leaves the buyer, fees included. */
  maxSpend: nonNegative,
  /** Floor on what the provider must receive, for FX/bridged routes. */
  minReceive: nonNegative,
  settlementAsset: z.enum(ASSET_SYMBOLS),
  allowedRails: z.array(z.enum(SETTLEMENT_RAILS)).min(1),
  maxFxSlippageBps: z.number().int().min(0).max(10_000),
  maxNetworkFee: nonNegative,
  /** Identifier of the evaluator that decides whether the work passed. */
  evaluator: z.string().min(1).max(256),
  /** Latest second at which the work may still be performed. */
  deadline: isoTimestamp,
  nonce: hex32,
  createdAt: isoTimestamp,
  /** Latest second at which this authorization may be executed. */
  expiresAt: isoTimestamp,
  /** Chain the authorization is bound to. Prevents cross-chain replay. */
  chainId: z.number().int().positive(),
  /** Contract the authorization is bound to. Prevents cross-contract replay. */
  verifyingContract: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
    .transform((value) => value.toLowerCase()),
  /** Exact payout destination. Substituting it invalidates the authorization. */
  destination: z.string().min(1).max(128),
  /** Network the payout must occur on. */
  network: z.enum(NETWORK_IDS),
});

export type EconomicIntent = z.infer<typeof economicIntentSchema>;
export type EconomicIntentInput = z.input<typeof economicIntentSchema>;

export type SignedEconomicIntent = {
  readonly intent: EconomicIntent;
  /** `0x`-prefixed 65-byte ECDSA signature over the EIP-712 digest. */
  readonly signature: string;
  /** Address expected to have produced `signature`. */
  readonly signer: string;
};
