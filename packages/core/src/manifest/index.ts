/**
 * The capability manifest.
 *
 * A machine-readable statement of what this deployment can actually do,
 * generated from the runtime rather than written by hand. The public site
 * renders it, so the site cannot claim more than the product supports: marketing
 * copy drifts, a derived manifest does not.
 *
 * The derivation is deliberately pessimistic. Configuration alone never reaches
 * LIVE — putting an address in an environment variable is not evidence that a
 * contract exists — and nothing reaches LIVE without a probe that actually
 * confirmed it.
 */

import type { CapabilityRecord, CapabilityId, ProtocolCapabilityEngine } from "../capability/index";

/**
 * What the public site is allowed to say about a feature.
 *
 * These are integration statuses. None of them is a claim of partnership,
 * endorsement or affiliation, and the manifest deliberately contains no
 * vocabulary for making one.
 */
export type PublicStatus = "LIVE" | "TESTNET" | "INTEGRATING" | "EXPLORING" | "UNAVAILABLE";

export interface ManifestFeature {
  /** Stable slug, safe for URLs and anchors. */
  readonly id: string;
  readonly label: string;
  /** The technology this belongs to, e.g. "Arc", "XRPL". */
  readonly group: string;
  readonly status: PublicStatus;
  readonly capability: CapabilityId;
  /** Why the status is what it is. Always non-empty. */
  readonly evidence: string;
  readonly description: string;
}

export interface CapabilityManifest {
  readonly generatedAt: string;
  readonly production: boolean;
  readonly features: readonly ManifestFeature[];
  readonly summary: Readonly<Record<PublicStatus, number>>;
  /**
   * Stated on every rendering of this manifest. The statuses describe our
   * integration work, not any relationship with the projects named.
   */
  readonly disclaimer: string;
}

export interface ManifestInputs {
  readonly capabilities: ProtocolCapabilityEngine;
  /** True when this deployment targets production networks. */
  readonly production: boolean;
  /** Which integrations have credentials present, keyed by group slug. */
  readonly configured: Readonly<Record<string, boolean>>;
  /** Adapter health, when it has been probed. */
  readonly adapters: readonly { readonly adapter: string; readonly status: string }[];
  readonly generatedAt: Date;
}

/**
 * Map one capability record to a public status.
 *
 * `probed` means the record's state came from a live check rather than from
 * configuration or a default. `configured` means credentials for the relevant
 * integration are present.
 */
export function publicStatusFor(
  record: CapabilityRecord,
  production: boolean,
  configured: boolean,
): PublicStatus {
  // "live" means a network probe confirmed it. Internal implementation and a
  // passing test suite are valuable evidence, but they do not prove that a
  // public deployment is operating a financial rail. Treat them as integrating
  // until an independently verified production rail is represented by a probe.
  const probed = record.source === "live";

  switch (record.state) {
    case "AVAILABLE":
      // A capability can only be LIVE if something actually confirmed it. A
      // state of AVAILABLE that came from config is a configuration claim, not
      // a verification, and is reported as work in progress.
      if (!probed) return configured || record.source === "config" ? "INTEGRATING" : "EXPLORING";
      return production ? "LIVE" : "TESTNET";

    case "TESTNET_ONLY":
      // Confirmed, but on a network whose balances are not money.
      return probed ? "TESTNET" : "INTEGRATING";

    case "EXPERIMENTAL":
      // Implemented but not exercised against a real rail. Never LIVE.
      return "INTEGRATING";

    case "DISABLED":
      // Probed and found absent. Saying so is more useful than silence.
      return probed ? "UNAVAILABLE" : "EXPLORING";

    case "UNKNOWN":
      // Nothing has confirmed it. With credentials present that is work in
      // progress; without them it is something we have only looked at.
      return configured ? "INTEGRATING" : "EXPLORING";
  }
}

interface FeatureDefinition {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly capability: CapabilityId;
  /** Which entry of `configured` gates this feature. */
  readonly configKey: string;
  readonly description: string;
}

/**
 * The public feature set.
 *
 * Every entry names a real capability the kernel gates on, so a feature cannot
 * appear on the site without something in the product to verify.
 */
const FEATURES: readonly FeatureDefinition[] = [
  {
    id: "muledger.bilateral-netting",
    label: "μLedger bilateral netting",
    group: "μLedger",
    capability: "MULEDGER.BILATERAL_NETTING",
    configKey: "muledger",
    description:
      "Obligations below the cost of a transaction accrue at nanodollar precision and net before settlement.",
  },
  {
    id: "muledger.multilateral-netting",
    label: "μLedger multilateral netting",
    group: "μLedger",
    capability: "MULEDGER.MULTILATERAL_NETTING",
    configKey: "muledger",
    description:
      "Netting across a whole clearing cycle, so obligations that form a loop settle to nothing.",
  },
  {
    id: "arc.identity",
    label: "ERC-8004 agent identity",
    group: "Arc",
    capability: "ARC.ERC8004",
    configKey: "arc",
    description: "Portable agent identity and reputation evidence on Arc.",
  },
  {
    id: "arc.jobs",
    label: "ERC-8183 job escrow",
    group: "Arc",
    capability: "ARC.ERC8183",
    configKey: "arc",
    description: "Escrowed, evaluated work with a enforced lifecycle.",
  },
  {
    id: "arc.usdc-gas",
    label: "USDC as gas",
    group: "Arc",
    capability: "ARC.USDC_GAS",
    configKey: "arc",
    description: "Paying transaction costs in USDC rather than a separate gas asset.",
  },
  {
    id: "arc.x402",
    label: "x402 inline payment",
    group: "Arc",
    capability: "ARC.X402",
    configKey: "arc",
    description: "Sub-cent synchronous payments settled inline over HTTP 402.",
  },
  {
    id: "circle.credentials",
    label: "Circle API credentials",
    group: "Circle",
    capability: "CIRCLE.CREDENTIALS",
    configKey: "circle",
    description: "Authenticated access to Circle's developer platform.",
  },
  {
    id: "circle.wallets",
    label: "Circle programmable wallets",
    group: "Circle",
    capability: "CIRCLE.WALLETS",
    configKey: "circle",
    description: "Agent wallets with server-side policy controls.",
  },
  {
    id: "circle.gateway",
    label: "Circle Gateway",
    group: "Circle",
    capability: "CIRCLE.GATEWAY",
    configKey: "circle",
    description: "Cross-chain USDC movement, on the chains Gateway actually covers.",
  },
  {
    id: "circle.nanopayments",
    label: "Circle Nanopayments",
    group: "Circle",
    capability: "CIRCLE.NANOPAYMENTS",
    configKey: "circle",
    description: "Batched settlement of very small payments.",
  },
  {
    id: "xrpl.payments",
    label: "XRPL payments",
    group: "XRPL",
    capability: "XRPL.PAYMENTS",
    configKey: "xrpl",
    description: "Direct payments on the XRP Ledger.",
  },
  {
    id: "xrpl.pathfinding",
    label: "XRPL pathfinding",
    group: "XRPL",
    capability: "XRPL.PATHFINDING",
    configKey: "xrpl",
    description: "Converting between assets already on XRPL inside one transaction.",
  },
  {
    id: "xrpl.escrow",
    label: "XRPL escrow",
    group: "XRPL",
    capability: "XRPL.ESCROW",
    configKey: "xrpl",
    description: "Conditional XRPL settlement held until delivery.",
  },
  {
    id: "xrpl.rlusd",
    label: "RLUSD settlement",
    group: "XRPL",
    capability: "XRPL.RLUSD",
    configKey: "xrpl",
    description: "Settlement in RLUSD, against a verified issuer.",
  },
  {
    id: "xrpl.credentials",
    label: "XRPL Credentials",
    group: "XRPL",
    capability: "XRPL.CREDENTIALS",
    configKey: "xrpl",
    description:
      "Ledger-native attestations used for authorization and compliance, with no personal data on-ledger.",
  },
  {
    id: "xrpl.permissioned-dex",
    label: "XRPL permissioned DEX",
    group: "XRPL",
    capability: "XRPL.PERMISSIONED_DEX",
    configKey: "xrpl",
    description: "Credential-gated trading venues for institutional flows.",
  },
  {
    id: "kaleido.private-clearing",
    label: "Kaleido private clearing",
    group: "Kaleido",
    capability: "KALEIDO.PRIVATE_CLEARING",
    configKey: "kaleido",
    description: "An optional enterprise control plane for institutional clearing.",
  },
  {
    id: "blockdag.settlement",
    label: "BlockDAG utility rail",
    group: "BlockDAG",
    capability: "BLOCKDAG.SETTLEMENT",
    configKey: "blockdag",
    description:
      "An optional execution and utility rail. Not used for stable-value settlement.",
  },
];

export const MANIFEST_DISCLAIMER =
  "These are integration statuses for work in this repository. They are not claims of partnership, endorsement, affiliation or sponsorship by any project named, and no such relationship is implied.";

export function buildCapabilityManifest(inputs: ManifestInputs): CapabilityManifest {
  const features: ManifestFeature[] = FEATURES.map((definition) => {
    const record = inputs.capabilities.get(definition.capability);
    const configured = inputs.configured[definition.configKey] === true;
    const status = publicStatusFor(record, inputs.production, configured);

    // Evidence is never empty: a status nobody can account for is a claim.
    const evidence =
      record.note && record.note.length > 0
        ? `${record.state.toLowerCase()} (${record.source}) — ${record.note}`
        : `${record.state.toLowerCase()} (${record.source})`;

    return {
      id: definition.id,
      label: definition.label,
      group: definition.group,
      status,
      capability: definition.capability,
      evidence,
      description: definition.description,
    };
  });

  const summary: Record<PublicStatus, number> = {
    LIVE: 0,
    TESTNET: 0,
    INTEGRATING: 0,
    EXPLORING: 0,
    UNAVAILABLE: 0,
  };
  for (const feature of features) summary[feature.status] += 1;

  return {
    generatedAt: inputs.generatedAt.toISOString(),
    production: inputs.production,
    features,
    summary,
    disclaimer: MANIFEST_DISCLAIMER,
  };
}

/** Features belonging to one technology, in manifest order. */
export function featuresByGroup(
  manifest: CapabilityManifest,
): readonly { group: string; features: readonly ManifestFeature[] }[] {
  const groups: string[] = [];
  for (const feature of manifest.features) {
    if (!groups.includes(feature.group)) groups.push(feature.group);
  }
  return groups.map((group) => ({
    group,
    features: manifest.features.filter((feature) => feature.group === group),
  }));
}

/** The strongest status any feature in a group reached. */
export function groupStatus(features: readonly ManifestFeature[]): PublicStatus {
  const order: PublicStatus[] = ["LIVE", "TESTNET", "INTEGRATING", "EXPLORING", "UNAVAILABLE"];
  for (const status of order) {
    if (features.some((feature) => feature.status === status)) return status;
  }
  return "EXPLORING";
}
