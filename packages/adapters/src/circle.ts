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
  canonicalAssetId,
  enforceBounds,
  fail,
  ok,
  parseAmount,
  parseDecimalToAtomic,
  registerErc20,
  unregisteredAmount,
  valueInUsd,
  violation,
  type AssetAmount,
  type CapabilityId,
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
 * Circle capabilities are separate because they are separate products. Holding
 * valid credentials says nothing about whether Gateway covers a given chain or
 * whether nanopayments are enabled for the account.
 */
const CIRCLE_CAPABILITIES = [
  "CIRCLE.CREDENTIALS",
  "CIRCLE.WALLETS",
  "CIRCLE.GATEWAY",
  "CIRCLE.NANOPAYMENTS",
  "ARC.CIRCLE_NANOPAYMENT",
] as const satisfies readonly CapabilityId[];

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

  /**
   * Probe Circle.
   *
   * A credential check proves credentials and nothing else. It does not prove
   * that programmable wallets are provisioned, that Gateway is reachable, or
   * that nanopayments are available to this account — so each is probed
   * separately and none is promoted because another succeeded.
   */
  async health(capabilities: ProtocolCapabilityEngine): Promise<AdapterHealth> {
    const probed: { id: CapabilityId; state: string; note?: string }[] = [];
    const missing = this.missing();

    const mark = (id: CapabilityId, state: Parameters<ProtocolCapabilityEngine["set"]>[1], note: string): void => {
      capabilities.set(id, state, missing.length > 0 ? "config" : "live", note);
      probed.push({ id, state, note });
    };

    if (missing.length > 0) {
      for (const id of CIRCLE_CAPABILITIES) {
        mark(id, "UNKNOWN", `missing ${missing.join(", ")}`);
      }
      return notConfigured(this.name, missing);
    }

    // 1. Credentials. The entity public key is the cheapest authenticated call.
    const credentials = await this.call<{ data?: unknown }>(
      "/v1/w3s/config/entity/publicKey",
    );
    if (!credentials.ok) {
      for (const id of CIRCLE_CAPABILITIES) {
        mark(id, "UNKNOWN", "credential check failed");
      }
      return {
        adapter: this.name,
        status: "ERROR",
        detail: credentials.violations[0]?.message ?? "Circle credential check failed",
        capabilities: probed,
        checkedAt: new Date(),
      };
    }
    mark("CIRCLE.CREDENTIALS", "AVAILABLE", "entity credentials accepted");

    // 2. Wallets. Credentials alone do not mean a wallet set exists.
    if (!this.config.circle.walletSetId) {
      mark("CIRCLE.WALLETS", "UNKNOWN", "CIRCLE_WALLET_SET_ID is not configured");
    } else {
      const wallets = await this.call<{ data?: unknown }>(
        `/v1/w3s/walletSets/${encodeURIComponent(this.config.circle.walletSetId)}`,
      );
      mark(
        "CIRCLE.WALLETS",
        wallets.ok ? "AVAILABLE" : "UNKNOWN",
        wallets.ok ? "wallet set reachable" : "wallet set could not be read",
      );
    }

    // 3. Gateway and nanopayments are separate products on separate endpoints.
    //    Neither is implied by the two checks above, and this deployment has
    //    not verified either, so both stay UNKNOWN rather than being inferred.
    mark(
      "CIRCLE.GATEWAY",
      "UNKNOWN",
      "Gateway support has not been probed for this account; chain coverage must be read from Circle at runtime",
    );
    mark(
      "CIRCLE.NANOPAYMENTS",
      "UNKNOWN",
      "Nanopayments availability has not been probed for this account",
    );
    mark(
      "ARC.CIRCLE_NANOPAYMENT",
      "UNKNOWN",
      "requires CIRCLE.NANOPAYMENTS on Arc; not promoted from a credential check",
    );

    return {
      adapter: this.name,
      status: "DEGRADED",
      detail:
        "credentials accepted; wallet, Gateway and Nanopayment availability are not yet verified for this account",
      capabilities: probed,
      checkedAt: new Date(),
    };
  }

  async balances(
    address: string,
    assets: readonly string[],
  ): Promise<Outcome<readonly BalanceReading[]>> {
    const missing = this.missing();
    if (missing.length > 0) return fail(configurationViolation(this.name, missing));

    const response = await this.call<CircleBalancesPayload>(
      `/v1/w3s/wallets/${encodeURIComponent(address)}/balances`,
    );
    if (!response.ok) return response as Outcome<readonly BalanceReading[]>;

    return ok(
      normalizeCircleBalances(response.value, {
        address,
        network: this.config.arc.isTestnet ? "ARC_TESTNET" : "ARC",
        wanted: assets,
        now: new Date(),
      }),
    );
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

// ---------------------------------------------------------------------------
// Balance normalization
// ---------------------------------------------------------------------------

export interface CircleBalancesPayload {
  readonly data?: {
    readonly tokenBalances?: readonly {
      readonly amount?: string;
      readonly token?: {
        readonly symbol?: string;
        readonly decimals?: number;
        readonly tokenAddress?: string;
        readonly blockchain?: string;
      };
    }[];
  };
}

export interface NormalizeOptions {
  readonly address: string;
  readonly network: "ARC" | "ARC_TESTNET";
  readonly wanted: readonly string[];
  readonly now: Date;
}

/**
 * Turn a Circle balances payload into asset-native readings.
 *
 * Pure, so the parsing rules are testable without a network: Circle returns
 * decimal strings, and they are parsed with bigint arithmetic at the asset's
 * own scale. The pattern this replaces —
 * `BigInt(Math.round(Number(amount) * 10 ** decimals))` — silently loses the
 * low-order digits of any balance above about 9 million at 9 decimals, and
 * introduces binary rounding error below that.
 *
 * A token this deployment has not registered is still reported at its exact
 * quantity, but with `usdValue: null`: an unregistered contract has no peg, and
 * a symbol is not a peg.
 */
export function normalizeCircleBalances(
  payload: CircleBalancesPayload,
  options: NormalizeOptions,
): BalanceReading[] {
  const wanted = new Set(options.wanted.map((asset) => asset.toUpperCase()));
  const wantsEverything = wanted.size === 0;
  const readings: BalanceReading[] = [];

  for (const balance of payload.data?.tokenBalances ?? []) {
    const symbol = balance.token?.symbol?.toUpperCase();
    const decimalAmount = balance.amount;
    if (!symbol || decimalAmount === undefined) continue;

    const contract = balance.token?.tokenAddress;
    const assetId = canonicalAssetId(options.network, symbol);
    if (!wantsEverything && !wanted.has(assetId.toUpperCase()) && !wanted.has(symbol)) continue;

    const known = parseAmount(decimalAmount, assetId, { allowNegative: false });
    let amount: AssetAmount;
    if (known.ok) {
      amount = known.value;
    } else if (known.violations.some((v) => v.code === "PRECISION_LOSS")) {
      // More precision than the asset can hold means we do not understand this
      // balance. Dropping it is safer than rounding it.
      continue;
    } else {
      const decimals = balance.token?.decimals;
      if (decimals === undefined) continue;
      const atomic = parseDecimalToAtomic(decimalAmount, decimals, { allowNegative: false });
      if (!atomic.ok) continue;
      amount = unregisteredAmount({
        symbol,
        network: options.network,
        atomic: atomic.value,
        decimals,
        ...(contract ? { contract } : {}),
      });
    }

    const valued = valueInUsd(amount, { now: options.now });
    readings.push({
      amount,
      address: options.address,
      asOf: options.now,
      usdValue: valued.ok ? valued.value : null,
    });
  }

  return readings;
}

/** Register a token Circle reports that this deployment has not seen before. */
export function registerCircleToken(options: {
  readonly symbol: string;
  readonly network: "ARC" | "ARC_TESTNET";
  readonly contract: string;
  readonly decimals: number;
}): void {
  registerErc20({
    symbol: options.symbol,
    network: options.network,
    contract: options.contract,
    decimals: options.decimals,
  });
}
