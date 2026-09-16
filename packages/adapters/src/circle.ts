/**
 * Circle adapter.
 *
 * Covers the programmable-wallet and USDC surface: agent wallets, wallet
 * policies, x402 and nanopayments. Credentials stay server-side and are never
 * sent to the browser or into a model context.
 *
 * Nothing here implies a partnership with Circle. It is an integration against
 * a public API, and every response is treated as untrusted input.
 */

import {
  baseUnitsToNanos,
  fail,
  ok,
  violation,
  enforceBounds,
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

export class CircleAdapter implements SettlementAdapter {
  readonly name = "circle";
  readonly networks: readonly string[] = ["ARC", "ARC_TESTNET"];

  private readonly config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  private missing(): string[] {
    const missing: string[] = [];
    if (!this.config.circle.apiKey) missing.push("CIRCLE_API_KEY");
    if (!this.config.circle.entitySecret) missing.push("CIRCLE_ENTITY_SECRET");
    return missing;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<Outcome<T>> {
    const apiKey = this.config.circle.apiKey;
    if (!apiKey) return fail(configurationViolation(this.name, ["CIRCLE_API_KEY"]));

    try {
      const response = await fetch(`${this.config.circle.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return fail(
          violation("CAPABILITY_UNAVAILABLE", `Circle API returned ${response.status}`, {
            adapter: this.name,
            path,
            status: response.status,
          }),
        );
      }
      return ok((await response.json()) as T);
    } catch (error) {
      return fail(
        violation(
          "CAPABILITY_UNAVAILABLE",
          error instanceof Error ? error.message : "Circle API request failed",
          { adapter: this.name, path },
        ),
      );
    }
  }

  async health(capabilities: ProtocolCapabilityEngine): Promise<AdapterHealth> {
    const missing = this.missing();
    if (missing.length > 0) {
      capabilities.set(
        "ARC.CIRCLE_NANOPAYMENT",
        "UNKNOWN",
        "config",
        `missing ${missing.join(", ")}`,
      );
      return notConfigured(this.name, missing);
    }

    const ping = await this.call<{ data?: unknown }>("/v1/w3s/config/entity/publicKey");
    if (!ping.ok) {
      capabilities.set("ARC.CIRCLE_NANOPAYMENT", "UNKNOWN", "live", "credential check failed");
      return {
        adapter: this.name,
        status: "ERROR",
        detail: ping.violations[0]?.message ?? "Circle credential check failed",
        capabilities: [{ id: "ARC.CIRCLE_NANOPAYMENT", state: "UNKNOWN" }],
        checkedAt: new Date(),
      };
    }

    capabilities.set("ARC.CIRCLE_NANOPAYMENT", "AVAILABLE", "live", "credentials accepted");
    return {
      adapter: this.name,
      status: "READY",
      detail: "Circle credentials accepted",
      capabilities: [{ id: "ARC.CIRCLE_NANOPAYMENT", state: "AVAILABLE" }],
      checkedAt: new Date(),
    };
  }

  async balances(
    address: string,
    assets: readonly string[],
  ): Promise<Outcome<readonly BalanceReading[]>> {
    const missing = this.missing();
    if (missing.length > 0) return fail(configurationViolation(this.name, missing));

    const response = await this.call<{
      data?: { tokenBalances?: { amount?: string; token?: { symbol?: string; decimals?: number } }[] };
    }>(`/v1/w3s/wallets/${encodeURIComponent(address)}/balances`);
    if (!response.ok) return response as Outcome<readonly BalanceReading[]>;

    const wanted = new Set(assets.map((asset) => asset.toUpperCase()));
    const readings: BalanceReading[] = [];
    for (const balance of response.value.data?.tokenBalances ?? []) {
      const symbol = balance.token?.symbol?.toUpperCase();
      const amount = balance.amount;
      if (!symbol || !amount || !wanted.has(symbol)) continue;
      // Circle returns decimal strings; convert through the asset's own scale
      // rather than trusting the string to already be in our units.
      const decimals = balance.token?.decimals ?? 6;
      const base = BigInt(Math.round(Number(amount) * 10 ** decimals));
      const nanos = baseUnitsToNanos(base, "ARC", symbol);
      if (!nanos.ok) continue;
      readings.push({ asset: symbol, network: "ARC", address, amount: nanos.value, asOf: new Date() });
    }
    return ok(readings);
  }

  async settle(request: SettlementRequest): Promise<Outcome<SettlementResult>> {
    const bounds = enforceBounds(request.intent, request.plan, new Date());
    if (!bounds.authorized) return fail(bounds.violations);

    const missing = this.missing();
    if (missing.length > 0) return fail(configurationViolation(this.name, missing));

    // A live transfer requires an entity-secret ciphertext produced from the
    // registered entity key. That signing path is deliberately not wired into
    // this deployment; see docs/SETTLEMENT.md for what completing it requires.
    return fail(
      violation(
        "CAPABILITY_UNAVAILABLE",
        "Circle transfers require an entity-secret signing path that is not enabled in this deployment",
        { adapter: this.name, idempotencyKey: request.idempotencyKey },
      ),
    );
  }
}
