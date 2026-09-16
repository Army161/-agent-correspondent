/**
 * Asset-native amounts.
 *
 * An `AssetAmount` is a quantity of one specific asset on one specific network,
 * held as an integer of that asset's smallest unit. It is self-describing —
 * symbol, network, decimals and issuer/contract travel with the number — so it
 * survives a database round trip, a JSON payload and a queue without a registry
 * lookup on the far side.
 *
 * Arithmetic between different assets is refused rather than coerced. Adding
 * XRP to USDC is not a rounding question, it is a category error.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";
import {
  formatAtomic,
  parseDecimalToAtomic,
  type FormatAtomicOptions,
  type ParseDecimalOptions,
} from "../units/decimal";
import type { NetworkId } from "../mandate/schema";
import { assetDefinition, type AssetId } from "./registry";

export interface AssetAmount {
  readonly assetId: AssetId;
  readonly symbol: string;
  readonly network: NetworkId;
  /** Integer count of the asset's smallest unit. */
  readonly atomic: bigint;
  readonly decimals: number;
  readonly issuer?: string;
  readonly contract?: string;
}

function describe(assetId: AssetId): Outcome<Omit<AssetAmount, "atomic">> {
  const definition = assetDefinition(assetId);
  if (!definition) {
    return fail(
      violation("UNKNOWN_ASSET", `asset ${assetId} is not registered`, { assetId }),
    );
  }
  return ok({
    assetId: definition.id,
    symbol: definition.symbol,
    network: definition.network,
    decimals: definition.decimals,
    ...(definition.issuer ? { issuer: definition.issuer } : {}),
    ...(definition.contract ? { contract: definition.contract } : {}),
  });
}

/** Parse a decimal string at the asset's own scale. Never at a dollar scale. */
export function parseAmount(
  value: string | bigint,
  assetId: AssetId,
  options: ParseDecimalOptions = {},
): Outcome<AssetAmount> {
  const described = describe(assetId);
  if (!described.ok) return described as Outcome<AssetAmount>;
  const atomic = parseDecimalToAtomic(value, described.value.decimals, options);
  if (!atomic.ok) return atomic as Outcome<AssetAmount>;
  return ok({ ...described.value, atomic: atomic.value });
}

/** Build an amount from an already-atomic quantity, e.g. a chain read. */
export function amountFromAtomic(atomic: bigint, assetId: AssetId): AssetAmount {
  const described = describe(assetId);
  if (!described.ok) {
    throw new Error(`amountFromAtomic: ${described.violations[0]?.message ?? assetId}`);
  }
  return { ...described.value, atomic };
}

/**
 * Build an amount for an asset that is not in the registry.
 *
 * Used when a chain read returns a token we have not registered: the quantity
 * is still exact and still self-describing, but it has no peg, so it cannot be
 * valued in USD without an oracle.
 */
export function unregisteredAmount(options: {
  readonly symbol: string;
  readonly network: NetworkId;
  readonly atomic: bigint;
  readonly decimals: number;
  readonly issuer?: string;
  readonly contract?: string;
}): AssetAmount {
  const assetId = `${options.network.toUpperCase()}:${options.symbol.toUpperCase()}${
    options.issuer ?? options.contract ? `:${options.issuer ?? options.contract}` : ""
  }`;
  return {
    assetId,
    symbol: options.symbol.toUpperCase(),
    network: options.network,
    atomic: options.atomic,
    decimals: options.decimals,
    ...(options.issuer ? { issuer: options.issuer } : {}),
    ...(options.contract ? { contract: options.contract } : {}),
  };
}

export function zeroAmount(assetId: AssetId): AssetAmount {
  return amountFromAtomic(0n, assetId);
}

/** Exact decimal rendering, with the symbol. Never rounds. */
export function formatAmount(
  amount: AssetAmount,
  options: FormatAtomicOptions & { readonly withSymbol?: boolean } = {},
): string {
  const body = formatAtomic(amount.atomic, amount.decimals, options);
  return options.withSymbol === false ? body : `${body} ${amount.symbol}`;
}

/** Exact decimal rendering without the symbol, for tables and wire payloads. */
export function amountToDecimalString(amount: AssetAmount): string {
  return formatAtomic(amount.atomic, amount.decimals);
}

function sameAsset(a: AssetAmount, b: AssetAmount): boolean {
  return a.assetId === b.assetId && a.decimals === b.decimals;
}

function mismatch(a: AssetAmount, b: AssetAmount): Outcome<never> {
  return fail(
    violation(
      "ASSET_MISMATCH",
      `cannot combine ${a.symbol} on ${a.network} with ${b.symbol} on ${b.network}`,
      { left: a.assetId, right: b.assetId },
    ),
  );
}

export function addAmounts(a: AssetAmount, b: AssetAmount): Outcome<AssetAmount> {
  if (!sameAsset(a, b)) return mismatch(a, b) as Outcome<AssetAmount>;
  return ok({ ...a, atomic: a.atomic + b.atomic });
}

export function subtractAmounts(a: AssetAmount, b: AssetAmount): Outcome<AssetAmount> {
  if (!sameAsset(a, b)) return mismatch(a, b) as Outcome<AssetAmount>;
  return ok({ ...a, atomic: a.atomic - b.atomic });
}

/** -1, 0 or 1. Refuses to compare different assets. */
export function compareAmounts(a: AssetAmount, b: AssetAmount): Outcome<number> {
  if (!sameAsset(a, b)) return mismatch(a, b) as Outcome<number>;
  return ok(a.atomic === b.atomic ? 0 : a.atomic > b.atomic ? 1 : -1);
}

export function sumAmounts(
  amounts: readonly AssetAmount[],
  assetId: AssetId,
): Outcome<AssetAmount> {
  let total = zeroAmount(assetId);
  for (const amount of amounts) {
    const next = addAmounts(total, amount);
    if (!next.ok) return next;
    total = next.value;
  }
  return ok(total);
}

export function isPositive(amount: AssetAmount): boolean {
  return amount.atomic > 0n;
}

export function isZero(amount: AssetAmount): boolean {
  return amount.atomic === 0n;
}

/** Canonical wire form. Used in API payloads and canonical hashing. */
export interface AssetAmountWire {
  readonly assetId: string;
  readonly symbol: string;
  readonly network: string;
  readonly amount: string;
  readonly atomic: string;
  readonly decimals: number;
  readonly issuer?: string;
  readonly contract?: string;
}

export function amountToWire(amount: AssetAmount): AssetAmountWire {
  return {
    assetId: amount.assetId,
    symbol: amount.symbol,
    network: amount.network,
    amount: amountToDecimalString(amount),
    atomic: amount.atomic.toString(10),
    decimals: amount.decimals,
    ...(amount.issuer ? { issuer: amount.issuer } : {}),
    ...(amount.contract ? { contract: amount.contract } : {}),
  };
}

/**
 * Read a wire amount back.
 *
 * The atomic string is authoritative and the decimal string is checked against
 * it: a payload whose two representations disagree is rejected rather than
 * having one of them silently win.
 */
export function amountFromWire(wire: AssetAmountWire): Outcome<AssetAmount> {
  if (!/^-?\d+$/.test(wire.atomic)) {
    return fail(violation("INVALID_AMOUNT", `atomic must be an integer: ${wire.atomic}`));
  }
  const atomic = BigInt(wire.atomic);
  const amount: AssetAmount = {
    assetId: wire.assetId,
    symbol: wire.symbol,
    network: wire.network as NetworkId,
    atomic,
    decimals: wire.decimals,
    ...(wire.issuer ? { issuer: wire.issuer } : {}),
    ...(wire.contract ? { contract: wire.contract } : {}),
  };
  if (formatAtomic(atomic, wire.decimals) !== wire.amount) {
    return fail(
      violation(
        "INVALID_AMOUNT",
        `wire amount ${wire.amount} does not match atomic ${wire.atomic} at ${wire.decimals} decimals`,
        { amount: wire.amount, atomic: wire.atomic },
      ),
    );
  }
  return ok(amount);
}
