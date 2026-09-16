/**
 * Environment inspection.
 *
 * Nothing here throws on a missing value. The product is designed to run with
 * nothing configured and say so, because "AWAITING DATA" is honest and a
 * fabricated balance is not.
 */

import "server-only";

export interface ServiceState {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  /** The variables that would make this service live. */
  readonly requires: readonly string[];
}

function has(...names: string[]): boolean {
  return names.every((name) => (process.env[name]?.trim().length ?? 0) > 0);
}

export function serviceStates(): readonly ServiceState[] {
  return [
    {
      id: "database",
      label: "Postgres",
      configured: has("DATABASE_URL"),
      requires: ["DATABASE_URL"],
    },
    {
      id: "auth",
      label: "Session signing",
      configured: has("AUTH_SECRET"),
      requires: ["AUTH_SECRET"],
    },
    {
      id: "openai",
      label: "OpenAI",
      configured: has("OPENAI_API_KEY"),
      requires: ["OPENAI_API_KEY"],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      configured: has("ANTHROPIC_API_KEY"),
      requires: ["ANTHROPIC_API_KEY"],
    },
    {
      id: "arc",
      label: "Arc RPC",
      configured: has("ARC_RPC_URL"),
      requires: ["ARC_RPC_URL", "ARC_USDC_ADDRESS"],
    },
    {
      id: "circle",
      label: "Circle",
      configured: has("CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"),
      requires: ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"],
    },
    {
      id: "xrpl",
      label: "XRPL node",
      configured: has("XRPL_WS_URL"),
      requires: ["XRPL_WS_URL"],
    },
  ];
}

export function isProduction(): boolean {
  return (process.env.ACOR_ENV ?? process.env.NODE_ENV) === "production";
}

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://agentcorrespondent.com";

/**
 * The ACOR token contract address.
 *
 * Fabricating this would be the single most harmful thing this codebase could
 * do: an address on a token page is read as canonical, and anyone who sends
 * funds to a wrong one loses them. So it is read from configuration and is
 * `null` until a real, verified deployment exists.
 */
export function acorContractAddress(): string | null {
  const address = process.env.NEXT_PUBLIC_ACOR_CONTRACT_ADDRESS?.trim();
  if (!address) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return address;
}
