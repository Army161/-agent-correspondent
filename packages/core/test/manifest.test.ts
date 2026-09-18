/**
 * The capability manifest.
 *
 * The landing page must never be able to claim more than the product actually
 * does. Marketing copy drifts; a manifest derived from the runtime cannot. So
 * every public status is computed from two things only — what a live probe
 * found, and what is configured — and the rules are deliberately pessimistic:
 *
 *   LIVE         a live probe confirmed it, on a production network
 *   TESTNET      a live probe confirmed it, on a test network
 *   INTEGRATING  credentials are configured but nothing has been confirmed
 *   EXPLORING    the adapter boundary exists; nothing is configured
 *   UNAVAILABLE  probed and found absent, or explicitly disabled
 *
 * Configuration alone never reaches LIVE. Putting an address in an environment
 * variable is not evidence that a contract exists.
 */

import { describe, expect, it } from "vitest";

import { ProtocolCapabilityEngine } from "../src/capability/index";
import {
  buildCapabilityManifest,
  publicStatusFor,
  type ManifestInputs,
} from "../src/manifest/index";

function inputs(overrides: Partial<ManifestInputs> = {}): ManifestInputs {
  return {
    capabilities: new ProtocolCapabilityEngine({ production: true }),
    production: true,
    configured: {},
    adapters: [],
    generatedAt: new Date("2026-03-01T12:00:00.000Z"),
    ...overrides,
  };
}

describe("status derivation", () => {
  it("marks a capability LIVE only when a live probe confirmed it in production", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: true });
    capabilities.set("XRPL.PAYMENTS", "AVAILABLE", "live", "probed via server_info");
    expect(publicStatusFor(capabilities.get("XRPL.PAYMENTS"), true, true)).toBe("LIVE");
  });

  it("ATTACK: configuration alone never reaches LIVE", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: true });
    // An address in an environment variable is not evidence a contract exists.
    capabilities.set("ARC.ERC8183", "AVAILABLE", "config", "address configured");
    expect(publicStatusFor(capabilities.get("ARC.ERC8183"), true, true)).toBe("INTEGRATING");
  });

  it("marks a confirmed testnet capability TESTNET, never LIVE", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: false });
    capabilities.set("ARC.ERC8004", "TESTNET_ONLY", "live", "deployed on testnet");
    expect(publicStatusFor(capabilities.get("ARC.ERC8004"), false, true)).toBe("TESTNET");
  });

  it("marks a live-probed capability on a non-production deployment TESTNET", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: false });
    capabilities.set("XRPL.PAYMENTS", "AVAILABLE", "live", "probed");
    expect(publicStatusFor(capabilities.get("XRPL.PAYMENTS"), false, true)).toBe("TESTNET");
  });

  it("marks an unverified capability with credentials INTEGRATING", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: true });
    capabilities.set("CIRCLE.NANOPAYMENTS", "UNKNOWN", "live", "not probed for this account");
    expect(publicStatusFor(capabilities.get("CIRCLE.NANOPAYMENTS"), true, true)).toBe("INTEGRATING");
  });

  it("marks an unverified capability with nothing configured EXPLORING", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: true });
    expect(publicStatusFor(capabilities.get("KALEIDO.PRIVATE_CLEARING"), true, false)).toBe(
      "EXPLORING",
    );
  });

  it("marks a probed-and-absent capability UNAVAILABLE", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: true });
    capabilities.set("ARC.USDC_GAS", "DISABLED", "live", "no contract code at address");
    expect(publicStatusFor(capabilities.get("ARC.USDC_GAS"), true, true)).toBe("UNAVAILABLE");
  });

  it("never reports EXPERIMENTAL as LIVE", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: true });
    capabilities.set("MULEDGER.MULTILATERAL_NETTING", "EXPERIMENTAL", "live", "implemented");
    expect(publicStatusFor(capabilities.get("MULEDGER.MULTILATERAL_NETTING"), true, true)).toBe(
      "INTEGRATING",
    );
  });

  it("does not treat internal code as a live financial rail", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: true });
    expect(publicStatusFor(capabilities.get("MULEDGER.BILATERAL_NETTING"), true, true)).toBe(
      "INTEGRATING",
    );
  });
});

describe("the manifest as a whole", () => {
  it("reports nothing as LIVE on an unconfigured deployment", () => {
    const manifest = buildCapabilityManifest(inputs());
    const live = manifest.features.filter((feature) => feature.status === "LIVE");
    // Tests verify the implementation, not a public financial operation. Every
    // rail needs an independent production probe before the product says LIVE.
    expect(live).toEqual([]);
  });

  it("never claims a partnership, only an integration status", () => {
    const manifest = buildCapabilityManifest(inputs());
    // The disclaimer is the one place these words may appear, and there they
    // appear only as denials.
    const text = JSON.stringify(manifest.features).toLowerCase();
    for (const claim of ["partner", "endorse", "sponsor", "affiliate"]) {
      expect(text, `no feature may contain "${claim}"`).not.toContain(claim);
    }
    expect(manifest.disclaimer).toMatch(/not claims of partnership/i);
  });

  it("groups features by the technology they belong to", () => {
    const manifest = buildCapabilityManifest(inputs());
    const groups = new Set(manifest.features.map((feature) => feature.group));
    expect(groups).toContain("Arc");
    expect(groups).toContain("XRPL");
    expect(groups).toContain("Circle");
    expect(groups).toContain("μLedger");
  });

  it("carries the evidence behind every status", () => {
    const manifest = buildCapabilityManifest(inputs());
    for (const feature of manifest.features) {
      expect(feature.evidence.length, feature.id).toBeGreaterThan(0);
    }
  });

  it("summarizes how many features are at each status", () => {
    const manifest = buildCapabilityManifest(inputs());
    const total = Object.values(manifest.summary).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(manifest.features.length);
  });

  it("promotes a capability once it is probed live", () => {
    const capabilities = new ProtocolCapabilityEngine({ production: true });
    capabilities.set("XRPL.PAYMENTS", "AVAILABLE", "live", "probed via server_info");
    const manifest = buildCapabilityManifest(
      inputs({ capabilities, configured: { xrpl: true } }),
    );
    const payments = manifest.features.find((feature) => feature.id === "xrpl.payments");
    expect(payments?.status).toBe("LIVE");
  });

  it("is deterministic for the same inputs", () => {
    const a = buildCapabilityManifest(inputs());
    const b = buildCapabilityManifest(inputs());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
