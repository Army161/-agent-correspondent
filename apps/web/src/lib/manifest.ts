/**
 * The deployment's capability manifest.
 *
 * Generated from the runtime — live capability probes plus what is actually
 * configured — so the public site renders what the product does rather than
 * what a marketing sentence claims. It is the reason the landing page cannot
 * overclaim: there is no hand-written status to drift.
 */

import "server-only";

import { buildCapabilityManifest, type CapabilityManifest } from "@acor/core";
import { getSettlementPlane, probeAll } from "@acor/adapters";

import { isProduction, serviceStates } from "./env";

/**
 * Build the manifest, probing the rails first.
 *
 * Probing on request rather than at boot means a rail that came up five minutes
 * ago is reflected, and one that went down is too.
 */
export async function getCapabilityManifest(): Promise<CapabilityManifest> {
  const adapters = await probeAll();
  const { capabilities, config } = getSettlementPlane();
  const services = serviceStates();

  const configuredFor = (id: string): boolean =>
    services.find((service) => service.id === id)?.configured === true;

  return buildCapabilityManifest({
    capabilities,
    production: isProduction() && !config.arc.isTestnet && !config.xrpl.isTestnet,
    configured: {
      // The μLedger is this repository's own code; it needs nothing configured.
      muledger: true,
      arc: configuredFor("arc"),
      circle: configuredFor("circle"),
      xrpl: configuredFor("xrpl"),
      kaleido: Boolean(process.env.KALEIDO_API_KEY?.trim()),
      blockdag: Boolean(process.env.BLOCKDAG_RPC_URL?.trim()),
    },
    adapters: adapters.map((adapter) => ({ adapter: adapter.adapter, status: adapter.status })),
    generatedAt: new Date(),
  });
}
