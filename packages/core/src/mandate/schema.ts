import { z } from "zod";

import { formatUsd, parseUsd, type Nanos } from "../units/money";

/**
 * An economic mandate is the deterministic financial policy for one agent.
 * It is authored by a human, stored server-side, and evaluated by code — the
 * language model that operates the agent can read it but has no path to change
 * it.
 */

const usdAmount = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value, ctx): Nanos => {
    const parsed = parseUsd(value);
    if (!parsed.ok) {
      ctx.addIssue({
        code: "custom",
        message: parsed.violations[0]?.message ?? "invalid USD amount",
      });
      return 0n;
    }
    return parsed.value;
  })
  .refine((nanos) => nanos >= 0n, { message: "amount must not be negative" });

export const ASSET_SYMBOLS = ["USDC", "RLUSD", "EURC", "XRP"] as const;
export const NETWORK_IDS = ["ARC", "ARC_TESTNET", "XRPL", "XRPL_TESTNET", "MULEDGER"] as const;

export type NetworkId = (typeof NETWORK_IDS)[number];

export const economicMandateSchema = z.object({
  dailySpendLimitUsd: usdAmount,
  maxTransactionUsd: usdAmount,
  minimumReserveUsd: usdAmount,
  unverifiedCounterpartyLimitUsd: usdAmount,
  humanApprovalAboveUsd: usdAmount,
  creditAllowed: z.boolean(),
  tokenTradingAllowed: z.boolean(),
  allowedAssets: z.array(z.enum(ASSET_SYMBOLS)).min(1),
  allowedNetworks: z.array(z.enum(NETWORK_IDS)).min(1),
});

/** Parsed mandate: every amount is nanos, every list is explicit. */
export type EconomicMandate = z.infer<typeof economicMandateSchema>;

/** The wire/JSON form a human or API client submits. */
export type EconomicMandateInput = z.input<typeof economicMandateSchema>;

/**
 * Conservative starting policy for a newly created agent: a dollar a day, two
 * and a half cents per transaction, nothing to a counterparty we cannot
 * identify, and a human in the loop above a dollar.
 */
export const DEFAULT_MANDATE: EconomicMandateInput = {
  dailySpendLimitUsd: "1.00",
  maxTransactionUsd: "0.025",
  minimumReserveUsd: "0.00",
  unverifiedCounterpartyLimitUsd: "0.00",
  humanApprovalAboveUsd: "1.00",
  creditAllowed: false,
  tokenTradingAllowed: false,
  allowedAssets: ["USDC"],
  allowedNetworks: ["ARC", "MULEDGER"],
};

export function parseMandate(input: unknown): z.ZodSafeParseResult<EconomicMandate> {
  return economicMandateSchema.safeParse(input);
}

/** Serialize a parsed mandate back to its decimal-string wire form. */
export function mandateToJson(mandate: EconomicMandate): Record<string, unknown> {
  return {
    dailySpendLimitUsd: formatUsd(mandate.dailySpendLimitUsd),
    maxTransactionUsd: formatUsd(mandate.maxTransactionUsd),
    minimumReserveUsd: formatUsd(mandate.minimumReserveUsd),
    unverifiedCounterpartyLimitUsd: formatUsd(mandate.unverifiedCounterpartyLimitUsd),
    humanApprovalAboveUsd: formatUsd(mandate.humanApprovalAboveUsd),
    creditAllowed: mandate.creditAllowed,
    tokenTradingAllowed: mandate.tokenTradingAllowed,
    allowedAssets: [...mandate.allowedAssets],
    allowedNetworks: [...mandate.allowedNetworks],
  };
}
