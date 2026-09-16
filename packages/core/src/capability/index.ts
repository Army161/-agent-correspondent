/**
 * Protocol capability engine (PRODUCT_SPEC §18).
 *
 * Ledger amendments get voted in, chains fork, testnets have features mainnet
 * does not. Executing against a primitive that is not actually live is how you
 * lose a payment into a transaction that can never be claimed. So every network
 * primitive has an explicit state here, and `UNKNOWN` is treated exactly like
 * `DISABLED`.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";

export type CapabilityState =
  | "AVAILABLE"
  | "DISABLED"
  | "TESTNET_ONLY"
  | "EXPERIMENTAL"
  | "UNKNOWN";

export type CapabilityId =
  // Arc / EVM
  | "ARC.ERC8004"
  | "ARC.ERC8183"
  | "ARC.USDC_GAS"
  | "ARC.X402"
  | "ARC.CIRCLE_NANOPAYMENT"
  // Circle products. Deliberately separate: valid credentials say nothing about
  // whether Gateway covers a chain or whether nanopayments are enabled.
  | "CIRCLE.CREDENTIALS"
  | "CIRCLE.WALLETS"
  | "CIRCLE.GATEWAY"
  | "CIRCLE.NANOPAYMENTS"
  // XRPL
  | "XRPL.PAYMENTS"
  | "XRPL.PATHFINDING"
  | "XRPL.ESCROW"
  | "XRPL.RLUSD"
  | "XRPL.PAYMENT_CHANNELS"
  | "XRPL.MPT"
  | "XRPL.CREDENTIALS"
  | "XRPL.DID"
  | "XRPL.PRICE_ORACLE"
  | "XRPL.LENDING"
  | "XRPL.PERMISSION_DELEGATION"
  | "XRPL.SPONSOR"
  | "XRPL.BATCH"
  | "XRPL.PERMISSIONED_DEX"
  // Internal
  | "MULEDGER.BILATERAL_NETTING"
  | "MULEDGER.MULTILATERAL_NETTING"
  // Optional enterprise / future rails
  | "KALEIDO.PRIVATE_CLEARING"
  | "BLOCKDAG.SETTLEMENT";

export interface CapabilityRecord {
  readonly id: CapabilityId;
  readonly state: CapabilityState;
  /** Where the state came from: `"live"`, `"config"`, `"default"`. */
  readonly source: string;
  readonly checkedAt: Date | null;
  readonly note?: string;
}

/**
 * Default registry.
 *
 * Nothing that depends on a live network check ships as AVAILABLE. Anything
 * requiring an amendment, a credential or a deployment we have not verified
 * starts at UNKNOWN, and only a successful live probe moves it.
 */
export const DEFAULT_CAPABILITIES: readonly CapabilityRecord[] = Object.freeze([
  cap("ARC.ERC8004", "UNKNOWN", "requires a deployed identity registry address"),
  cap("ARC.ERC8183", "UNKNOWN", "requires a deployed job registry address"),
  cap("ARC.USDC_GAS", "UNKNOWN", "verified by probing the configured Arc RPC"),
  cap("ARC.X402", "UNKNOWN", "requires a configured x402 facilitator"),
  cap("ARC.CIRCLE_NANOPAYMENT", "UNKNOWN", "requires Circle nanopayments on Arc; never inferred from a credential check"),
  cap("CIRCLE.CREDENTIALS", "UNKNOWN", "requires Circle API credentials"),
  cap("CIRCLE.WALLETS", "UNKNOWN", "requires a reachable Circle wallet set"),
  cap("CIRCLE.GATEWAY", "UNKNOWN", "Gateway chain coverage must be read from Circle at runtime"),
  cap("CIRCLE.NANOPAYMENTS", "UNKNOWN", "requires nanopayments enabled for the configured account"),
  cap("XRPL.PAYMENTS", "UNKNOWN", "verified by probing the configured XRPL node"),
  cap("XRPL.PATHFINDING", "UNKNOWN", "verified by probing the configured XRPL node"),
  cap("XRPL.ESCROW", "UNKNOWN", "verified by probing the configured XRPL node"),
  cap("XRPL.RLUSD", "UNKNOWN", "requires a configured RLUSD issuer and trust line"),
  cap("XRPL.PAYMENT_CHANNELS", "UNKNOWN", "amendment-gated"),
  cap("XRPL.MPT", "UNKNOWN", "amendment-gated"),
  cap("XRPL.CREDENTIALS", "UNKNOWN", "amendment-gated"),
  cap("XRPL.DID", "UNKNOWN", "amendment-gated"),
  cap("XRPL.PRICE_ORACLE", "UNKNOWN", "amendment-gated"),
  cap("XRPL.LENDING", "UNKNOWN", "amendment-gated"),
  cap("XRPL.PERMISSION_DELEGATION", "UNKNOWN", "amendment-gated"),
  cap("XRPL.SPONSOR", "UNKNOWN", "amendment-gated"),
  cap("XRPL.BATCH", "UNKNOWN", "amendment-gated"),
  cap("XRPL.PERMISSIONED_DEX", "UNKNOWN", "amendment-gated"),
  // The mu-ledger is this application's own code, so its state is known
  // without probing anything. Source "internal" records exactly that: verified
  // by the implementation rather than by a network call, which is why it may
  // be reported as live while a merely-configured capability may not.
  cap("MULEDGER.BILATERAL_NETTING", "AVAILABLE", "implemented in @acor/core", "internal"),
  cap("MULEDGER.MULTILATERAL_NETTING", "EXPERIMENTAL", "implemented; not yet used for live settlement", "internal"),
  cap("KALEIDO.PRIVATE_CLEARING", "UNKNOWN", "optional enterprise integration; not configured"),
  cap("BLOCKDAG.SETTLEMENT", "UNKNOWN", "optional future rail; not configured"),
]);

function cap(
  id: CapabilityId,
  state: CapabilityState,
  note: string,
  source = "default",
): CapabilityRecord {
  return { id, state, source, checkedAt: null, note };
}

export interface CapabilityEnvironment {
  /** True for production. TESTNET_ONLY capabilities are refused in production. */
  readonly production: boolean;
  /** Allow EXPERIMENTAL capabilities to execute. Off by default. */
  readonly allowExperimental?: boolean;
}

export class ProtocolCapabilityEngine {
  private readonly records = new Map<CapabilityId, CapabilityRecord>();
  private readonly environment: CapabilityEnvironment;

  constructor(
    environment: CapabilityEnvironment,
    initial: readonly CapabilityRecord[] = DEFAULT_CAPABILITIES,
  ) {
    this.environment = environment;
    for (const record of initial) this.records.set(record.id, record);
  }

  /** Record the result of a live probe. */
  set(id: CapabilityId, state: CapabilityState, source: string, note?: string): void {
    this.records.set(id, {
      id,
      state,
      source,
      checkedAt: new Date(),
      ...(note ? { note } : {}),
    });
  }

  get(id: CapabilityId): CapabilityRecord {
    return (
      this.records.get(id) ?? {
        id,
        state: "UNKNOWN",
        source: "unregistered",
        checkedAt: null,
        note: "capability is not registered",
      }
    );
  }

  list(): readonly CapabilityRecord[] {
    return [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  isAvailable(id: CapabilityId): boolean {
    return this.assertAvailable(id).ok;
  }

  /**
   * The gate every adapter calls before touching a primitive.
   * Only AVAILABLE passes unconditionally; everything else needs an explicit,
   * environment-level reason to proceed.
   */
  assertAvailable(id: CapabilityId): Outcome<CapabilityRecord> {
    const record = this.get(id);
    switch (record.state) {
      case "AVAILABLE":
        return ok(record);
      case "TESTNET_ONLY":
        return this.environment.production
          ? fail(
              violation("CAPABILITY_TESTNET_ONLY", `${id} is testnet-only and this is production`, {
                capability: id,
              }),
            )
          : ok(record);
      case "EXPERIMENTAL":
        return this.environment.allowExperimental
          ? ok(record)
          : fail(
              violation("CAPABILITY_UNAVAILABLE", `${id} is experimental and not enabled here`, {
                capability: id,
                state: record.state,
              }),
            );
      case "DISABLED":
        return fail(
          violation("CAPABILITY_UNAVAILABLE", `${id} is disabled`, { capability: id }),
        );
      case "UNKNOWN":
        return fail(
          violation(
            "CAPABILITY_UNKNOWN",
            `${id} has not been verified live; refusing to execute against an unverified primitive`,
            { capability: id, note: record.note ?? "" },
          ),
        );
    }
  }
}
