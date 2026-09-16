/**
 * @acor/adapters — the settlement plane.
 */

import { ProtocolCapabilityEngine, DEFAULT_CAPABILITIES } from "@acor/core";

import { ArcAdapter } from "./arc";
import { CircleAdapter } from "./circle";
import { BlockDagAdapter, KaleidoAdapter } from "./optional";
import { XrplAdapter } from "./xrpl";
import { loadAdapterConfig, assertNetworkSeparation, type AdapterConfig } from "./config";
import type { AdapterHealth, SettlementAdapter } from "./types";

export * from "./types";
export * from "./config";
export { ArcAdapter, keccak256 } from "./arc";
export { XrplAdapter, decodeCurrency } from "./xrpl";
export { CircleAdapter } from "./circle";
export { KaleidoAdapter, BlockDagAdapter } from "./optional";

export interface SettlementPlane {
  readonly config: AdapterConfig;
  readonly capabilities: ProtocolCapabilityEngine;
  readonly adapters: readonly SettlementAdapter[];
  /** Configuration problems that must be fixed before this process settles anything. */
  readonly configurationErrors: readonly string[];
}

let plane: SettlementPlane | null = null;

/** Build (once) the settlement plane for this process. */
export function getSettlementPlane(): SettlementPlane {
  if (plane) return plane;
  const config = loadAdapterConfig();
  const capabilities = new ProtocolCapabilityEngine(
    { production: config.production, allowExperimental: process.env.ACOR_ALLOW_EXPERIMENTAL === "1" },
    DEFAULT_CAPABILITIES,
  );
  plane = {
    config,
    capabilities,
    adapters: [
      new ArcAdapter(config),
      new CircleAdapter(config),
      new XrplAdapter(config),
      new KaleidoAdapter(config),
      new BlockDagAdapter(config),
    ],
    configurationErrors: assertNetworkSeparation(config),
  };
  return plane;
}

/**
 * Probe every adapter.
 *
 * Each probe is isolated: one unreachable node must not prevent the others from
 * reporting, and a thrown error becomes an ERROR health record rather than a
 * failed page load.
 */
export async function probeAll(): Promise<readonly AdapterHealth[]> {
  const { adapters, capabilities } = getSettlementPlane();
  return Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.health(capabilities);
      } catch (error) {
        return {
          adapter: adapter.name,
          status: "ERROR" as const,
          detail: error instanceof Error ? error.message : "probe threw",
          capabilities: [],
          checkedAt: new Date(),
        };
      }
    }),
  );
}
