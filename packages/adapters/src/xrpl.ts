/**
 * XRPL adapter.
 *
 * XRPL is the cross-currency and cross-border rail: native XRP, RLUSD and
 * USDC where supported, with pathfinding for atomic conversion and escrow for
 * conditional delivery.
 *
 * Most of what XRPL can do is amendment-gated, and amendments are not uniform
 * across networks. So this adapter probes `server_info`/`feature` on the
 * configured node and writes what it finds into the capability engine; nothing
 * amendment-dependent is ever assumed live.
 */

import { Client } from "xrpl";
import {
  amountFromAtomic,
  assetDefinition,
  canonicalAssetId,
  enforceBounds,
  fail,
  ok,
  parseAmount,
  registerXrplIssuedCurrency,
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
 * Amendment names on XRPL, mapped to the capabilities that depend on them.
 * A capability whose amendment is not enabled on the connected network is
 * DISABLED, not "probably fine".
 */
const AMENDMENT_CAPABILITIES: readonly { amendment: string; capability: CapabilityId }[] = [
  { amendment: "PayChan", capability: "XRPL.PAYMENT_CHANNELS" },
  { amendment: "MPTokensV1", capability: "XRPL.MPT" },
  { amendment: "Credentials", capability: "XRPL.CREDENTIALS" },
  { amendment: "DID", capability: "XRPL.DID" },
  { amendment: "PriceOracle", capability: "XRPL.PRICE_ORACLE" },
  { amendment: "LendingProtocol", capability: "XRPL.LENDING" },
  { amendment: "PermissionDelegation", capability: "XRPL.PERMISSION_DELEGATION" },
  { amendment: "FeeSponsor", capability: "XRPL.SPONSOR" },
  { amendment: "Batch", capability: "XRPL.BATCH" },
  { amendment: "PermissionedDEX", capability: "XRPL.PERMISSIONED_DEX" },
];

export class XrplAdapter implements SettlementAdapter {
  readonly name = "xrpl";
  readonly networks: readonly string[];

  private readonly config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
    this.networks = [config.xrpl.isTestnet ? "XRPL_TESTNET" : "XRPL"];
  }

  private async connect(): Promise<Client | null> {
    const url = this.config.xrpl.wsUrl;
    if (!url) return null;
    const client = new Client(url, { connectionTimeout: 10_000 });
    await client.connect();
    return client;
  }

  async health(capabilities: ProtocolCapabilityEngine): Promise<AdapterHealth> {
    if (!this.config.xrpl.wsUrl) return notConfigured(this.name, ["XRPL_WS_URL"]);

    const probed: { id: CapabilityId; state: string; note?: string }[] = [];
    let client: Client | null = null;

    try {
      client = await this.connect();
      if (!client) return notConfigured(this.name, ["XRPL_WS_URL"]);

      const info = await client.request({ command: "server_info" });
      const networkId = info.result.info.network_id;
      const baseState = this.config.xrpl.isTestnet ? "TESTNET_ONLY" : "AVAILABLE";

      // Payments and pathfinding are core protocol, live wherever a node answers.
      for (const id of ["XRPL.PAYMENTS", "XRPL.PATHFINDING", "XRPL.ESCROW"] as const) {
        capabilities.set(id, baseState, "live", `server_info from ${this.config.xrpl.wsUrl}`);
        probed.push({ id, state: baseState });
      }

      // RLUSD needs a configured issuer; without one we cannot form a valid
      // issued-currency amount, so the capability stays unknown.
      if (this.config.xrpl.rlusdIssuer) {
        capabilities.set("XRPL.RLUSD", baseState, "live", "issuer configured");
        probed.push({ id: "XRPL.RLUSD", state: baseState });
      } else {
        capabilities.set("XRPL.RLUSD", "UNKNOWN", "live", "XRPL_RLUSD_ISSUER is not configured");
        probed.push({ id: "XRPL.RLUSD", state: "UNKNOWN", note: "issuer not configured" });
      }

      const enabled = await this.enabledAmendments(client);
      for (const { amendment, capability } of AMENDMENT_CAPABILITIES) {
        if (enabled === null) {
          capabilities.set(capability, "UNKNOWN", "live", "amendment list unavailable from node");
          probed.push({ id: capability, state: "UNKNOWN", note: "amendment list unavailable" });
          continue;
        }
        const on = enabled.has(amendment);
        const state = on ? baseState : "DISABLED";
        capabilities.set(
          capability,
          state,
          "live",
          on ? `${amendment} amendment enabled` : `${amendment} amendment not enabled`,
        );
        probed.push({ id: capability, state });
      }

      return {
        adapter: this.name,
        status: "READY",
        detail: `connected to XRPL${networkId !== undefined ? ` network ${networkId}` : ""}${this.config.xrpl.isTestnet ? " (testnet)" : ""}`,
        capabilities: probed,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        adapter: this.name,
        status: "ERROR",
        detail: error instanceof Error ? error.message : "XRPL probe failed",
        capabilities: probed,
        checkedAt: new Date(),
      };
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }

  private async enabledAmendments(client: Client): Promise<Set<string> | null> {
    try {
      // `feature` is an admin command on many nodes; when it is unavailable the
      // honest answer is "unknown", not "enabled".
      const response = (await client.request({
        command: "feature",
      } as never)) as { result?: { features?: Record<string, { name?: string; enabled?: boolean }> } };
      const features = response.result?.features;
      if (!features) return null;
      const enabled = new Set<string>();
      for (const entry of Object.values(features)) {
        if (entry.enabled && entry.name) enabled.add(entry.name);
      }
      return enabled;
    } catch {
      return null;
    }
  }

  async balances(
    address: string,
    assets: readonly string[],
  ): Promise<Outcome<readonly BalanceReading[]>> {
    if (!this.config.xrpl.wsUrl) {
      return fail(configurationViolation(this.name, ["XRPL_WS_URL"]));
    }
    let client: Client | null = null;
    try {
      client = await this.connect();
      if (!client) return fail(configurationViolation(this.name, ["XRPL_WS_URL"]));

      const network = this.networks[0] as "XRPL" | "XRPL_TESTNET";
      const readings: BalanceReading[] = [];
      const wanted = new Set(assets.map((asset) => asset.toUpperCase()));
      const wantsEverything = wanted.size === 0;
      const now = new Date();

      const wants = (assetId: string, symbol: string): boolean =>
        wantsEverything || wanted.has(assetId.toUpperCase()) || wanted.has(symbol.toUpperCase());

      const xrpAssetId = canonicalAssetId(network, "XRP");
      if (wants(xrpAssetId, "XRP")) {
        const account = await client.request({
          command: "account_info",
          account: address,
          ledger_index: "validated",
        });
        // The ledger reports drops, which *are* XRP's atomic unit. There is no
        // conversion to perform and, crucially, no dollar to invent: XRP has no
        // peg, so `usdValue` stays null until a price oracle supplies one.
        const drops = BigInt(account.result.account_data.Balance);
        readings.push({
          amount: amountFromAtomic(drops, xrpAssetId),
          address,
          asOf: now,
          usdValue: null,
        });
      }

      const issued = await client.request({
        command: "account_lines",
        account: address,
        ledger_index: "validated",
      });

      for (const line of issued.result.lines) {
        const symbol = decodeCurrency(line.currency);
        // An issued currency is only meaningful together with its issuer. Two
        // accounts can both issue something called "RLUSD" and only one of them
        // is Ripple, so the issuer is part of the identity we resolve.
        const assetId = canonicalAssetId(network, symbol, line.account);
        if (!wants(assetId, symbol)) continue;

        const known = assetDefinition(assetId);
        const parsed = known
          ? parseAmount(line.balance, assetId)
          : parseAmount(line.balance, this.registerUnknownIssuer(symbol, line.account, network).id);
        if (!parsed.ok) continue;

        const valued = valueInUsd(parsed.value, { now });
        readings.push({
          amount: parsed.value,
          address,
          asOf: now,
          usdValue: valued.ok ? valued.value : null,
        });
      }

      return ok(readings);
    } catch (error) {
      return fail(
        violation(
          "CAPABILITY_UNAVAILABLE",
          error instanceof Error ? error.message : "XRPL balance read failed",
          { adapter: this.name },
        ),
      );
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }

  /**
   * Register an issued currency we have not seen before.
   *
   * It is registered with **no peg**, whatever it calls itself. A token named
   * "USD" from an unknown issuer is not a dollar, and this is the exact place
   * that distinction has to be made rather than assumed.
   */
  private registerUnknownIssuer(
    symbol: string,
    issuer: string,
    network: "XRPL" | "XRPL_TESTNET",
  ): { id: string } {
    return registerXrplIssuedCurrency({
      symbol,
      issuer,
      network,
      peg: {
        kind: "NONE",
        note: `Issuer ${issuer} is not a registered peg authority for ${symbol}; no USD value is assumed.`,
      },
    });
  }

  async settle(request: SettlementRequest): Promise<Outcome<SettlementResult>> {
    const bounds = enforceBounds(request.intent, request.plan, new Date());
    if (!bounds.authorized) return fail(bounds.violations);

    if (!this.config.xrpl.wsUrl) {
      return fail(configurationViolation(this.name, ["XRPL_WS_URL"]));
    }

    // Submitting requires a funded, key-bearing XRPL account. This process
    // holds no seeds (docs/SECURITY.md), so settlement is prepared here and
    // signed by the configured wallet provider.
    return fail(
      violation(
        "CAPABILITY_UNAVAILABLE",
        "no XRPL signing authority is attached to this deployment; the prepared payment must be signed by a configured wallet provider",
        { adapter: this.name, idempotencyKey: request.idempotencyKey },
      ),
    );
  }
}

/** XRPL carries non-standard currency codes as 40-character hex. */
export function decodeCurrency(currency: string): string {
  if (currency.length !== 40) return currency.toUpperCase();
  const bytes = currency.replace(/(00)+$/, "");
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    const code = Number.parseInt(bytes.slice(i, i + 2), 16);
    if (code === 0) continue;
    out += String.fromCharCode(code);
  }
  return out.toUpperCase();
}
