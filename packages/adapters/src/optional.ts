/**
 * Optional integrations: Kaleido and BlockDAG.
 *
 * Both are adapter boundaries rather than dependencies. The consumer product
 * works with neither configured, and nothing settlement-critical routes through
 * either: USDC and RLUSD remain the primary settlement assets
 * (PRODUCT_SPEC §30, §31).
 */

import {
  fail,
  ok,
  violation,
  type Outcome,
  type ProtocolCapabilityEngine,
} from "@acor/core";

import type { AdapterConfig } from "./config";
import {
  configurationViolation,
  notConfigured,
  type AdapterHealth,
  type BalanceReading,
  type SettlementAdapter,
  type SettlementRequest,
  type SettlementResult,
} from "./types";

/**
 * Kaleido: an optional enterprise control-plane integration for private
 * clearing, institutional participants, audit and document anchoring.
 * It is never required for the consumer MVP.
 */
export class KaleidoAdapter implements SettlementAdapter {
  readonly name = "kaleido";
  readonly networks: readonly string[] = [];

  private readonly config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  private missing(): string[] {
    const missing: string[] = [];
    if (!this.config.kaleido.baseUrl) missing.push("KALEIDO_BASE_URL");
    if (!this.config.kaleido.apiKey) missing.push("KALEIDO_API_KEY");
    return missing;
  }

  async health(capabilities: ProtocolCapabilityEngine): Promise<AdapterHealth> {
    const missing = this.missing();
    if (missing.length > 0) {
      capabilities.set(
        "KALEIDO.PRIVATE_CLEARING",
        "UNKNOWN",
        "config",
        "optional enterprise integration; not configured",
      );
      return notConfigured(this.name, missing);
    }
    capabilities.set(
      "KALEIDO.PRIVATE_CLEARING",
      "EXPERIMENTAL",
      "config",
      "credentials present; private clearing has not been exercised end to end",
    );
    return {
      adapter: this.name,
      status: "DEGRADED",
      detail: "credentials configured; private clearing is not yet exercised end to end",
      capabilities: [{ id: "KALEIDO.PRIVATE_CLEARING", state: "EXPERIMENTAL" }],
      checkedAt: new Date(),
    };
  }

  async balances(): Promise<Outcome<readonly BalanceReading[]>> {
    // Kaleido is a control plane, not a wallet. It holds no user balances.
    return ok([]);
  }

  async settle(request: SettlementRequest): Promise<Outcome<SettlementResult>> {
    const missing = this.missing();
    if (missing.length > 0) return fail(configurationViolation(this.name, missing));
    return fail(
      violation(
        "CAPABILITY_UNAVAILABLE",
        "Kaleido private clearing is an optional integration and is not enabled for settlement",
        { adapter: this.name, idempotencyKey: request.idempotencyKey },
      ),
    );
  }
}

/**
 * BlockDAG: an optional future execution/utility rail. TURBO is explicitly not
 * settlement-critical, and this adapter refuses to settle stable value.
 */
export class BlockDagAdapter implements SettlementAdapter {
  readonly name = "blockdag";
  readonly networks: readonly string[] = [];

  private readonly config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  async health(capabilities: ProtocolCapabilityEngine): Promise<AdapterHealth> {
    if (!this.config.blockdag.rpcUrl) {
      capabilities.set(
        "BLOCKDAG.SETTLEMENT",
        "UNKNOWN",
        "config",
        "optional future rail; not configured",
      );
      return notConfigured(this.name, ["BLOCKDAG_RPC_URL"]);
    }
    capabilities.set(
      "BLOCKDAG.SETTLEMENT",
      "EXPERIMENTAL",
      "config",
      "configured, but not used for stable-value settlement",
    );
    return {
      adapter: this.name,
      status: "DEGRADED",
      detail: "configured as an experimental utility rail; not used for stable-value settlement",
      capabilities: [{ id: "BLOCKDAG.SETTLEMENT", state: "EXPERIMENTAL" }],
      checkedAt: new Date(),
    };
  }

  async balances(): Promise<Outcome<readonly BalanceReading[]>> {
    return ok([]);
  }

  async settle(): Promise<Outcome<SettlementResult>> {
    return fail(
      violation(
        "CAPABILITY_UNAVAILABLE",
        "BlockDAG is an optional utility rail and is not eligible for stable-value settlement",
        { adapter: this.name },
      ),
    );
  }
}
