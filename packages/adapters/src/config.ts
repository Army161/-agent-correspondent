/**
 * Adapter configuration, read from the environment exactly once per process.
 *
 * Every field is optional. An unset field means "this rail is not available",
 * which every adapter surfaces honestly rather than working around.
 *
 * Mainnet and testnet are separate fields, never the same field with a flag.
 * Reusing a testnet address in production is the kind of mistake that is easy
 * to make once and impossible to take back (PRODUCT_SPEC §13).
 */

export interface ArcConfig {
  readonly rpcUrl: string | null;
  readonly chainId: number;
  readonly isTestnet: boolean;
  readonly usdcAddress: string | null;
  readonly identityRegistry: string | null;
  readonly jobRegistry: string | null;
  readonly intentVerifier: string | null;
}

export interface CircleConfig {
  readonly apiKey: string | null;
  readonly entitySecret: string | null;
  readonly walletSetId: string | null;
  readonly baseUrl: string;
}

export interface XrplConfig {
  readonly wsUrl: string | null;
  readonly isTestnet: boolean;
  readonly rlusdIssuer: string | null;
  readonly sourceTag: number | null;
}

export interface KaleidoConfig {
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
}

export interface BlockDagConfig {
  readonly rpcUrl: string | null;
}

export interface AdapterConfig {
  readonly production: boolean;
  readonly arc: ArcConfig;
  readonly circle: CircleConfig;
  readonly xrpl: XrplConfig;
  readonly kaleido: KaleidoConfig;
  readonly blockdag: BlockDagConfig;
}

/** Arc mainnet. The testnet chain id is configured separately and never assumed. */
export const ARC_MAINNET_CHAIN_ID = 5042;

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

export function loadAdapterConfig(): AdapterConfig {
  const production = (env("ACOR_ENV") ?? "development") === "production";
  const arcTestnet = env("ARC_NETWORK") === "testnet";

  return {
    production,
    arc: {
      rpcUrl: env(arcTestnet ? "ARC_TESTNET_RPC_URL" : "ARC_RPC_URL"),
      chainId: Number(env("ARC_CHAIN_ID") ?? ARC_MAINNET_CHAIN_ID),
      isTestnet: arcTestnet,
      usdcAddress: env(arcTestnet ? "ARC_TESTNET_USDC_ADDRESS" : "ARC_USDC_ADDRESS"),
      identityRegistry: env(
        arcTestnet ? "ARC_TESTNET_ERC8004_ADDRESS" : "ARC_ERC8004_ADDRESS",
      ),
      jobRegistry: env(arcTestnet ? "ARC_TESTNET_ERC8183_ADDRESS" : "ARC_ERC8183_ADDRESS"),
      intentVerifier: env(
        arcTestnet ? "ARC_TESTNET_INTENT_VERIFIER_ADDRESS" : "ARC_INTENT_VERIFIER_ADDRESS",
      ),
    },
    circle: {
      apiKey: env("CIRCLE_API_KEY"),
      entitySecret: env("CIRCLE_ENTITY_SECRET"),
      walletSetId: env("CIRCLE_WALLET_SET_ID"),
      baseUrl: env("CIRCLE_BASE_URL") ?? "https://api.circle.com",
    },
    xrpl: {
      wsUrl: env("XRPL_WS_URL"),
      isTestnet: env("XRPL_NETWORK") === "testnet",
      rlusdIssuer: env("XRPL_RLUSD_ISSUER"),
      sourceTag: env("XRPL_SOURCE_TAG") ? Number(env("XRPL_SOURCE_TAG")) : null,
    },
    kaleido: {
      baseUrl: env("KALEIDO_BASE_URL"),
      apiKey: env("KALEIDO_API_KEY"),
    },
    blockdag: {
      rpcUrl: env("BLOCKDAG_RPC_URL"),
    },
  };
}

/**
 * Guard against the single most expensive configuration mistake: pointing a
 * production deployment at testnet contracts, or vice versa.
 */
export function assertNetworkSeparation(config: AdapterConfig): string[] {
  const problems: string[] = [];
  if (config.production && config.arc.isTestnet) {
    problems.push("ACOR_ENV=production with ARC_NETWORK=testnet: refusing to mix networks");
  }
  if (config.production && config.xrpl.isTestnet) {
    problems.push("ACOR_ENV=production with XRPL_NETWORK=testnet: refusing to mix networks");
  }
  if (config.production && config.arc.chainId !== ARC_MAINNET_CHAIN_ID && config.arc.rpcUrl) {
    problems.push(
      `ACOR_ENV=production with ARC_CHAIN_ID=${config.arc.chainId}; Arc mainnet is ${ARC_MAINNET_CHAIN_ID}`,
    );
  }
  return problems;
}
