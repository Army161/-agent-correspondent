/**
 * Agent discovery and capability normalization (PRODUCT_SPEC §11).
 *
 * Providers arrive from very different places — an internal agent, an ERC-8004
 * identity record, an MCP server, an A2A endpoint, an x402-priced HTTP service.
 * The procurement engine should not care. Everything is normalized into one
 * shape, and anything that cannot be normalized honestly (no price, no
 * destination) is dropped rather than guessed at.
 */

import { parseUsd, type Nanos } from "../units/money";
import type { SettlementRail } from "../intent/schema";
import type { NetworkId } from "../mandate/schema";

export type DiscoverySource = "INTERNAL" | "ERC8004" | "MCP" | "A2A" | "X402" | "EXTERNAL";

export type CapabilityCategory =
  | "research"
  | "summarization"
  | "extraction"
  | "classification"
  | "generation"
  | "analysis"
  | "validation"
  | "execution"
  | "other";

export interface ProviderCapability {
  readonly capabilityId: string;
  readonly category: CapabilityCategory;
  /** Price per unit of work, in nanos. */
  readonly price: Nanos;
  readonly unit: string;
  /** Typical end-to-end latency, in milliseconds. */
  readonly latencyMs: number;
  /** Whether the provider supports result validation by an evaluator. */
  readonly validationSupported: boolean;
}

export interface DiscoveredProvider {
  readonly agentId: string;
  readonly displayName: string;
  readonly source: DiscoverySource;
  /** Identity is verified when it is backed by a registry record or prior settled work. */
  readonly verified: boolean;
  /** 0-100 portable reputation, or null when the provider has no history. */
  readonly reputation: number | null;
  readonly capabilities: readonly ProviderCapability[];
  readonly settlementAssets: readonly string[];
  readonly networks: readonly NetworkId[];
  readonly rails: readonly SettlementRail[];
  /** Payout destination: an address, an XRPL account, or an internal agent id. */
  readonly destination: string;
  readonly endpoint?: string;
  /** Observed success rate in [0,1], or null when unknown. */
  readonly successRate: number | null;
  /** Completed, settled jobs known to this platform. */
  readonly completedJobs: number;
}

export interface RawProviderRecord {
  readonly agentId: string;
  readonly displayName?: string;
  readonly source: DiscoverySource;
  readonly verified?: boolean;
  readonly reputation?: number | null;
  readonly destination?: string;
  readonly endpoint?: string;
  readonly settlementAssets?: readonly string[];
  readonly networks?: readonly string[];
  readonly rails?: readonly string[];
  readonly successRate?: number | null;
  readonly completedJobs?: number;
  readonly capabilities?: readonly {
    capabilityId?: string;
    category?: string;
    /** Decimal USD string, e.g. `"0.004"`. */
    price?: string | number;
    unit?: string;
    latencyMs?: number;
    validationSupported?: boolean;
  }[];
}

const CATEGORIES: readonly CapabilityCategory[] = [
  "research",
  "summarization",
  "extraction",
  "classification",
  "generation",
  "analysis",
  "validation",
  "execution",
  "other",
];

function normalizeCategory(value: string | undefined): CapabilityCategory {
  const lower = (value ?? "").toLowerCase();
  return (CATEGORIES as readonly string[]).includes(lower)
    ? (lower as CapabilityCategory)
    : "other";
}

/**
 * Normalize one external record.
 *
 * Returns `null` rather than a partially-filled provider: a provider with no
 * payout destination or no priced capability cannot be transacted with, and
 * showing it in results would be an invitation to a failed job.
 */
export function normalizeProvider(raw: RawProviderRecord): DiscoveredProvider | null {
  if (!raw.agentId || !raw.destination) return null;

  const capabilities: ProviderCapability[] = [];
  for (const capability of raw.capabilities ?? []) {
    if (capability.price === undefined || !capability.capabilityId) continue;
    const price = parseUsd(capability.price);
    if (!price.ok || price.value < 0n) continue;
    capabilities.push({
      capabilityId: capability.capabilityId,
      category: normalizeCategory(capability.category),
      price: price.value,
      unit: capability.unit ?? "call",
      latencyMs: Math.max(0, Math.round(capability.latencyMs ?? 0)),
      validationSupported: capability.validationSupported === true,
    });
  }
  if (capabilities.length === 0) return null;

  return {
    agentId: raw.agentId,
    displayName: raw.displayName ?? raw.agentId,
    source: raw.source,
    verified: raw.verified === true,
    reputation: clampReputation(raw.reputation),
    capabilities,
    settlementAssets: (raw.settlementAssets ?? []).map((asset) => asset.toUpperCase()),
    networks: (raw.networks ?? []).map((network) => network.toUpperCase() as NetworkId),
    rails: (raw.rails ?? []) as readonly SettlementRail[],
    destination: raw.destination,
    ...(raw.endpoint ? { endpoint: raw.endpoint } : {}),
    successRate: clampRate(raw.successRate),
    completedJobs: Math.max(0, Math.round(raw.completedJobs ?? 0)),
  };
}

function clampReputation(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampRate(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

export interface DiscoveryQuery {
  readonly category?: CapabilityCategory;
  readonly capabilityId?: string;
  /** Hard ceiling on unit price, in nanos. */
  readonly maxPrice?: Nanos;
  readonly maxLatencyMs?: number;
  readonly requireValidation?: boolean;
  readonly requireVerified?: boolean;
  readonly settlementAsset?: string;
  readonly network?: NetworkId;
}

export interface ProviderMatch {
  readonly provider: DiscoveredProvider;
  readonly capability: ProviderCapability;
}

/** Filter normalized providers against a query. Pure; no ranking here. */
export function matchProviders(
  providers: readonly DiscoveredProvider[],
  query: DiscoveryQuery,
): readonly ProviderMatch[] {
  const matches: ProviderMatch[] = [];
  for (const provider of providers) {
    if (query.requireVerified && !provider.verified) continue;
    if (query.settlementAsset && !provider.settlementAssets.includes(query.settlementAsset.toUpperCase())) {
      continue;
    }
    if (query.network && !provider.networks.includes(query.network)) continue;

    for (const capability of provider.capabilities) {
      if (query.category && capability.category !== query.category) continue;
      if (query.capabilityId && capability.capabilityId !== query.capabilityId) continue;
      if (query.maxPrice !== undefined && capability.price > query.maxPrice) continue;
      if (query.maxLatencyMs !== undefined && capability.latencyMs > query.maxLatencyMs) continue;
      if (query.requireValidation && !capability.validationSupported) continue;
      matches.push({ provider, capability });
    }
  }
  return matches;
}
