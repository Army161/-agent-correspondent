/**
 * Arc adapter.
 *
 * Arc is the initial application/agent-contract rail: chain id 5042, USDC as
 * the gas asset, ERC-8004 for identity and ERC-8183 for jobs. This adapter
 * probes what is actually deployed and reachable, and reports the rest as
 * unverified — it never claims a contract exists because an address is in an
 * environment variable.
 */

import {
  createPublicClient,
  http,
  keccak256 as viemKeccak256,
  toBytes,
  type PublicClient,
} from "viem";
import {
  baseUnitsToNanos,
  enforceBounds,
  fail,
  hashIntent,
  nanosToBaseUnits,
  ok,
  violation,
  type Keccak256,
  type Nanos,
  type Outcome,
  type ProtocolCapabilityEngine,
} from "@acor/core";

import { type AdapterConfig } from "./config";
import {
  configurationViolation,
  notConfigured,
  type AdapterHealth,
  type BalanceReading,
  type SettlementAdapter,
  type SettlementRequest,
  type SettlementResult,
} from "./types";

/** viem's keccak256, adapted to the kernel's injected-hash interface. */
export const keccak256: Keccak256 = (bytes) => toBytes(viemKeccak256(bytes));

const ERC20_BALANCE_OF = {
  name: "balanceOf",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
} as const;

export class ArcAdapter implements SettlementAdapter {
  readonly name = "arc";
  readonly networks: readonly string[];

  private readonly config: AdapterConfig;
  private client: PublicClient | null = null;

  constructor(config: AdapterConfig) {
    this.config = config;
    this.networks = [config.arc.isTestnet ? "ARC_TESTNET" : "ARC"];
  }

  private missing(): string[] {
    const missing: string[] = [];
    if (!this.config.arc.rpcUrl) missing.push("ARC_RPC_URL");
    if (!this.config.arc.usdcAddress) missing.push("ARC_USDC_ADDRESS");
    return missing;
  }

  private publicClient(): PublicClient | null {
    if (this.client) return this.client;
    const url = this.config.arc.rpcUrl;
    if (!url) return null;
    this.client = createPublicClient({ transport: http(url) }) as PublicClient;
    return this.client;
  }

  async health(capabilities: ProtocolCapabilityEngine): Promise<AdapterHealth> {
    const missing = this.missing();
    if (missing.length > 0) return notConfigured(this.name, missing);

    const client = this.publicClient();
    if (!client) return notConfigured(this.name, ["ARC_RPC_URL"]);

    const probed: { id: Parameters<ProtocolCapabilityEngine["set"]>[0]; state: string; note?: string }[] = [];

    try {
      const chainId = await client.getChainId();
      if (chainId !== this.config.arc.chainId) {
        return {
          adapter: this.name,
          status: "ERROR",
          detail: `RPC reports chain id ${chainId}, but ARC_CHAIN_ID is ${this.config.arc.chainId}. Refusing to use this endpoint.`,
          capabilities: [],
          checkedAt: new Date(),
        };
      }

      // USDC-as-gas is asserted only if the configured USDC contract has code.
      const usdcCode = await client.getCode({
        address: this.config.arc.usdcAddress as `0x${string}`,
      });
      const usdcDeployed = usdcCode !== undefined && usdcCode !== "0x";
      capabilities.set(
        "ARC.USDC_GAS",
        usdcDeployed ? "AVAILABLE" : "DISABLED",
        "live",
        usdcDeployed ? undefined : "no contract code at the configured USDC address",
      );
      probed.push({ id: "ARC.USDC_GAS", state: usdcDeployed ? "AVAILABLE" : "DISABLED" });

      for (const [id, address] of [
        ["ARC.ERC8004", this.config.arc.identityRegistry],
        ["ARC.ERC8183", this.config.arc.jobRegistry],
      ] as const) {
        if (!address) {
          capabilities.set(id, "UNKNOWN", "live", "registry address is not configured");
          probed.push({ id, state: "UNKNOWN", note: "address not configured" });
          continue;
        }
        const code = await client.getCode({ address: address as `0x${string}` });
        const deployed = code !== undefined && code !== "0x";
        const state = deployed
          ? this.config.arc.isTestnet
            ? "TESTNET_ONLY"
            : "AVAILABLE"
          : "DISABLED";
        capabilities.set(id, state, "live", deployed ? undefined : "no contract code at address");
        probed.push({ id, state });
      }

      return {
        adapter: this.name,
        status: "READY",
        detail: `connected to Arc chain ${chainId}${this.config.arc.isTestnet ? " (testnet)" : ""}`,
        capabilities: probed,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        adapter: this.name,
        status: "ERROR",
        detail: error instanceof Error ? error.message : "Arc RPC probe failed",
        capabilities: probed,
        checkedAt: new Date(),
      };
    }
  }

  async balances(
    address: string,
    assets: readonly string[],
  ): Promise<Outcome<readonly BalanceReading[]>> {
    const missing = this.missing();
    if (missing.length > 0) {
      return fail(configurationViolation(this.name, missing));
    }
    const client = this.publicClient();
    if (!client) return fail(configurationViolation(this.name, ["ARC_RPC_URL"]));

    const network = this.networks[0] as string;
    const readings: BalanceReading[] = [];

    try {
      for (const asset of assets) {
        if (asset.toUpperCase() !== "USDC") continue; // only USDC is wired on Arc today
        const raw = (await client.readContract({
          address: this.config.arc.usdcAddress as `0x${string}`,
          abi: [ERC20_BALANCE_OF],
          functionName: "balanceOf",
          args: [address as `0x${string}`],
        })) as bigint;
        const nanos = baseUnitsToNanos(raw, network, "USDC");
        if (!nanos.ok) return nanos as Outcome<readonly BalanceReading[]>;
        readings.push({
          asset: "USDC",
          network,
          address,
          amount: nanos.value,
          asOf: new Date(),
        });
      }
      return ok(readings);
    } catch (error) {
      return fail(
        violation(
          "CAPABILITY_UNAVAILABLE",
          error instanceof Error ? error.message : "Arc balance read failed",
          { adapter: this.name },
        ),
      );
    }
  }

  /**
   * Settlement submission.
   *
   * The bounds are re-checked here, immediately before submission, even though
   * the relay already checked them. Between the two checks the world may have
   * moved, and this is the last moment at which refusing is free.
   */
  async settle(request: SettlementRequest): Promise<Outcome<SettlementResult>> {
    const bounds = enforceBounds(request.intent, request.plan, new Date());
    if (!bounds.authorized) return fail(bounds.violations);

    const digest = hashIntent(request.intent, keccak256);
    if (!digest.ok) return digest as Outcome<SettlementResult>;

    if (!this.config.arc.intentVerifier) {
      return fail(
        violation(
          "CAPABILITY_UNAVAILABLE",
          "Arc settlement requires a deployed intent verifier contract (ARC_INTENT_VERIFIER_ADDRESS). No contract is configured, so no transaction can be submitted.",
          { adapter: this.name, digest: digest.value },
        ),
      );
    }

    // Broadcasting requires a signer. Signing authority is deliberately not
    // held by this process: see docs/SECURITY.md. The wallet layer (Circle
    // programmable wallets, or a user-controlled signer in the browser) submits
    // the transaction; this adapter prepares and validates it.
    return fail(
      violation(
        "CAPABILITY_UNAVAILABLE",
        "no signing authority is attached to this deployment; the prepared transaction must be submitted by a configured wallet provider",
        { adapter: this.name, digest: digest.value, idempotencyKey: request.idempotencyKey },
      ),
    );
  }
}

/** Convert a nanodollar amount into the USDC base units an Arc transaction moves. */
export function toUsdcBaseUnits(amount: Nanos, network: string): Outcome<bigint> {
  return nanosToBaseUnits(amount, network, "USDC");
}
