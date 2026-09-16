/**
 * USD valuation.
 *
 * A `UsdValue` is an *opinion about* an `AssetAmount` at a point in time, from
 * a named source. It is never the amount itself, and the two are kept in
 * separate types precisely so they cannot be confused: the bug this module
 * exists to prevent is one XRP being recorded as one dollar.
 *
 * Valuation fails closed. Without a registered peg or a fresh quote there is no
 * USD figure, and the caller must decide what to do — which, for a spend check,
 * means denying it.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";
import { scaleAtomic } from "../units/decimal";
import { NANOS_PER_USD, type Nanos } from "../units/money";
import type { AssetAmount } from "./amount";
import { assetDefinition, type AssetId } from "./registry";

export type ValuationSource =
  | { readonly kind: "PEG"; readonly authority: string }
  | { readonly kind: "ORACLE"; readonly name: string }
  | { readonly kind: "MANUAL"; readonly note: string };

export interface UsdValue {
  /** Integer nanodollars. */
  readonly nanos: Nanos;
  /** When this valuation was true. */
  readonly asOf: Date;
  readonly source: ValuationSource;
  /** Age at which this valuation must be re-taken, when the source declares one. */
  readonly staleAfterSeconds?: number;
}

export interface PriceQuote {
  readonly assetId: AssetId;
  /** USD nanodollars per one whole unit of the asset. */
  readonly usdNanosPerUnit: bigint;
  readonly asOf: Date;
  readonly source: string;
  readonly confidence?: number;
}

/** A price source. Implementations live outside the kernel. */
export interface PriceOracle {
  readonly name: string;
  quote(assetId: AssetId): Promise<Outcome<PriceQuote>>;
}

export interface ValuationOptions {
  readonly now: Date;
  /** A price for this asset, when the caller has obtained one. */
  readonly quote?: PriceQuote;
  /** Maximum quote age. Defaults to 60 seconds. */
  readonly maxQuoteAgeSeconds?: number;
}

/**
 * Value an asset amount in USD, or explain why it cannot be valued.
 *
 * Order matters: a registered peg is preferred over a quote, because a peg is a
 * deliberate policy decision and a quote is a market observation that can be
 * manipulated. An oracle price for USDC would be a way to talk the system into
 * a different number for a dollar.
 */
export function valueInUsd(
  amount: AssetAmount,
  options: ValuationOptions,
): Outcome<UsdValue> {
  const definition = assetDefinition(amount.assetId);

  if (definition?.peg.kind === "USD_PAR") {
    // One unit is one dollar, so the conversion is purely a change of scale.
    // It is exact: a sub-nanodollar quantity of an 18-decimal stablecoin
    // truncates toward zero rather than inventing value.
    const nanos = scaleAtomic(amount.atomic, amount.decimals, 9, "down");
    if (!nanos.ok) return nanos as Outcome<UsdValue>;
    return ok({
      nanos: nanos.value,
      asOf: options.now,
      source: { kind: "PEG", authority: definition.peg.authority },
    });
  }

  const quote = options.quote;
  if (!quote) {
    return fail(
      violation(
        "VALUATION_UNAVAILABLE",
        `${amount.symbol} on ${amount.network} has no registered USD peg and no price was supplied, so it cannot be valued in dollars`,
        { assetId: amount.assetId },
      ),
    );
  }

  if (quote.assetId !== amount.assetId) {
    return fail(
      violation(
        "ASSET_MISMATCH",
        `price quote is for ${quote.assetId}, not ${amount.assetId}`,
        { quoted: quote.assetId, required: amount.assetId },
      ),
    );
  }

  if (quote.usdNanosPerUnit <= 0n) {
    return fail(
      violation("VALUATION_UNAVAILABLE", "price quote must be greater than zero", {
        assetId: amount.assetId,
        price: quote.usdNanosPerUnit,
      }),
    );
  }

  const maxAge = options.maxQuoteAgeSeconds ?? 60;
  const ageSeconds = Math.floor((options.now.getTime() - quote.asOf.getTime()) / 1000);
  if (ageSeconds > maxAge) {
    return fail(
      violation(
        "VALUATION_STALE",
        `price quote for ${amount.assetId} is ${ageSeconds}s old, older than the ${maxAge}s limit`,
        { assetId: amount.assetId, ageSeconds, maxAge },
      ),
    );
  }

  // value = atomic / 10^decimals * usdNanosPerUnit, computed as integers and
  // truncated toward zero so a valuation never rounds up in the payer's
  // disfavour.
  const scale = 10n ** BigInt(amount.decimals);
  const nanos = (amount.atomic * quote.usdNanosPerUnit) / scale;

  return ok({
    nanos,
    asOf: quote.asOf,
    source: { kind: "ORACLE", name: quote.source },
    staleAfterSeconds: maxAge,
  });
}

/** Convenience: a USD figure from a pegged asset, or a violation. */
export function pegValue(amount: AssetAmount, now: Date): Outcome<UsdValue> {
  return valueInUsd(amount, { now });
}

export function formatUsdValue(value: UsdValue): string {
  const negative = value.nanos < 0n;
  const magnitude = negative ? -value.nanos : value.nanos;
  const whole = magnitude / NANOS_PER_USD;
  let fraction = (magnitude % NANOS_PER_USD).toString(10).padStart(9, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

/** Wire form for API payloads and canonical documents. */
export interface UsdValueWire {
  readonly nanos: string;
  readonly asOf: string;
  readonly source: string;
  readonly staleAfterSeconds?: number;
}

export function usdValueToWire(value: UsdValue): UsdValueWire {
  const source =
    value.source.kind === "PEG"
      ? `PEG:${value.source.authority}`
      : value.source.kind === "ORACLE"
        ? `ORACLE:${value.source.name}`
        : `MANUAL:${value.source.note}`;
  return {
    nanos: value.nanos.toString(10),
    asOf: value.asOf.toISOString(),
    source,
    ...(value.staleAfterSeconds !== undefined
      ? { staleAfterSeconds: value.staleAfterSeconds }
      : {}),
  };
}
