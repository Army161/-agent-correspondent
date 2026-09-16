/**
 * Asset identity and peg policy.
 *
 * Three ideas hold this together:
 *
 * 1. **An asset is identified by network, symbol and issuer/contract — never by
 *    symbol alone.** "USDC on Arc" and "USDC on XRPL" are different assets with
 *    different issuers and different failure modes, and a contract that merely
 *    calls itself USDC is a third thing entirely.
 *
 * 2. **A quantity of an asset is not a number of dollars.** One XRP is one XRP.
 *    The only things that turn it into a dollar figure are a registered peg
 *    policy or a live oracle quote.
 *
 * 3. **A peg is a registered policy, never an inference from a symbol.** USDC
 *    is treated as USD-par here because an entry in this file says so, with an
 *    authority and a note attached. An unknown token named `USDC` gets nothing.
 */

import type { NetworkId } from "../mandate/schema";

export type AssetId = string;

export type AssetKind = "NATIVE" | "ERC20" | "XRPL_ISSUED" | "INTERNAL";

/**
 * How — if at all — this asset's unit maps to a US dollar without an oracle.
 *
 * `USD_PAR` is a deliberate, attributable decision to treat one unit as one
 * dollar. `NONE` means valuation requires a price, and the system fails closed
 * without one.
 */
export type PegPolicy =
  | {
      readonly kind: "USD_PAR";
      /** Who stands behind the peg, e.g. "Circle". Recorded for the audit trail. */
      readonly authority: string;
      readonly note: string;
    }
  | {
      readonly kind: "NONE";
      readonly note: string;
    };

export interface AssetDefinition {
  readonly id: AssetId;
  readonly symbol: string;
  readonly network: NetworkId;
  /** Decimal places in this asset's smallest unit on this network. */
  readonly decimals: number;
  readonly kind: AssetKind;
  /** XRPL issuing account, for issued currencies. */
  readonly issuer?: string;
  /** EVM contract address, for tokens. */
  readonly contract?: string;
  readonly peg: PegPolicy;
}

export interface AssetRegistration extends Omit<AssetDefinition, "id"> {
  readonly id?: AssetId;
}

/**
 * Canonical asset id: `NETWORK:SYMBOL` or `NETWORK:SYMBOL:ISSUER`.
 *
 * The issuer segment is what stops a look-alike issuer on XRPL from being
 * mistaken for the real one.
 */
export function canonicalAssetId(
  network: string,
  symbol: string,
  issuerOrContract?: string,
): AssetId {
  const base = `${network.toUpperCase()}:${symbol.toUpperCase()}`;
  return issuerOrContract ? `${base}:${issuerOrContract}` : base;
}

const REGISTRY = new Map<AssetId, AssetDefinition>();

export function registerAsset(registration: AssetRegistration): AssetDefinition {
  const id =
    registration.id ??
    canonicalAssetId(
      registration.network,
      registration.symbol,
      registration.issuer ?? registration.contract,
    );
  const definition: AssetDefinition = { ...registration, id };
  REGISTRY.set(id, definition);
  return definition;
}

export function assetDefinition(id: AssetId): AssetDefinition | undefined {
  return REGISTRY.get(id);
}

export function listAssets(): readonly AssetDefinition[] {
  return [...REGISTRY.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * True only when a registered policy says one unit is one dollar.
 * An unregistered asset is never pegged, whatever it calls itself.
 */
export function isUsdPegged(id: AssetId): boolean {
  return assetDefinition(id)?.peg.kind === "USD_PAR";
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * XRPL issued currencies carry 15 significant decimal digits. We fix the scale
 * at 15 so an issued-currency balance has one exact integer representation;
 * amounts finer than that are rejected rather than rounded.
 */
const XRPL_ISSUED_DECIMALS = 15;

export const ARC_USDC = canonicalAssetId("ARC", "USDC");
export const ARC_TESTNET_USDC = canonicalAssetId("ARC_TESTNET", "USDC");
export const ARC_EURC = canonicalAssetId("ARC", "EURC");
export const ARC_RLUSD = canonicalAssetId("ARC", "RLUSD");
export const XRPL_XRP = canonicalAssetId("XRPL", "XRP");
export const XRPL_TESTNET_XRP = canonicalAssetId("XRPL_TESTNET", "XRP");
export const XRPL_RLUSD = canonicalAssetId("XRPL", "RLUSD");
export const MULEDGER_USD = canonicalAssetId("MULEDGER", "USD");

registerAsset({
  id: ARC_USDC,
  symbol: "USDC",
  network: "ARC",
  decimals: 6,
  kind: "ERC20",
  peg: {
    kind: "USD_PAR",
    authority: "Circle",
    note: "USDC is a full-reserve US dollar stablecoin; treated as USD-par by registered policy, not by symbol.",
  },
});

registerAsset({
  id: ARC_TESTNET_USDC,
  symbol: "USDC",
  network: "ARC_TESTNET",
  decimals: 6,
  kind: "ERC20",
  peg: {
    kind: "USD_PAR",
    authority: "Circle (testnet)",
    note: "Testnet USDC has no monetary value; USD-par only so testnet flows exercise the same code path.",
  },
});

registerAsset({
  id: ARC_EURC,
  symbol: "EURC",
  network: "ARC",
  decimals: 6,
  kind: "ERC20",
  peg: {
    kind: "NONE",
    note: "EURC tracks the euro, not the dollar. A USD figure requires a EUR/USD rate from an oracle.",
  },
});

registerAsset({
  id: ARC_RLUSD,
  symbol: "RLUSD",
  network: "ARC",
  decimals: 18,
  kind: "ERC20",
  peg: {
    kind: "USD_PAR",
    authority: "Ripple",
    note: "RLUSD is a US dollar stablecoin; 18 decimals in its EVM form.",
  },
});

registerAsset({
  id: XRPL_XRP,
  symbol: "XRP",
  network: "XRPL",
  decimals: 6,
  kind: "NATIVE",
  peg: {
    kind: "NONE",
    note: "XRP is a floating-price asset. Any USD figure requires a live price; there is no peg.",
  },
});

registerAsset({
  id: XRPL_TESTNET_XRP,
  symbol: "XRP",
  network: "XRPL_TESTNET",
  decimals: 6,
  kind: "NATIVE",
  peg: { kind: "NONE", note: "Testnet XRP has no monetary value and no price." },
});

registerAsset({
  id: XRPL_RLUSD,
  symbol: "RLUSD",
  network: "XRPL",
  decimals: XRPL_ISSUED_DECIMALS,
  kind: "XRPL_ISSUED",
  peg: {
    kind: "USD_PAR",
    authority: "Ripple",
    note: "RLUSD as an XRPL issued currency. The issuer must still be verified at execution — see XRPL adapter.",
  },
});

/**
 * μLedger accounting assets.
 *
 * An obligation is denominated in the asset that will eventually settle it, but
 * it is tracked at **nanodollar precision** rather than the rail's. That is the
 * entire point of the μLedger: a 40-nanodollar obligation is 0.04 of a single
 * USDC atomic unit, so it is not representable on the rail at all until many of
 * them have been netted together.
 *
 * These are internal units of account. They are not tokens and not
 * transferable.
 */
export const MULEDGER_DECIMALS = 9;

registerAsset({
  id: MULEDGER_USD,
  symbol: "USD",
  network: "MULEDGER",
  decimals: MULEDGER_DECIMALS,
  kind: "INTERNAL",
  peg: {
    kind: "USD_PAR",
    authority: "Agent Correspondent",
    note: "Internal unit of account: one nanodollar. Not a token, not transferable.",
  },
});

export const MULEDGER_USDC = canonicalAssetId("MULEDGER", "USDC");
export const MULEDGER_RLUSD = canonicalAssetId("MULEDGER", "RLUSD");

registerAsset({
  id: MULEDGER_USDC,
  symbol: "USDC",
  network: "MULEDGER",
  decimals: MULEDGER_DECIMALS,
  kind: "INTERNAL",
  peg: {
    kind: "USD_PAR",
    authority: "Circle",
    note: "A USDC-denominated obligation recorded at nanodollar precision, not yet settled on a rail.",
  },
});

registerAsset({
  id: MULEDGER_RLUSD,
  symbol: "RLUSD",
  network: "MULEDGER",
  decimals: MULEDGER_DECIMALS,
  kind: "INTERNAL",
  peg: {
    kind: "USD_PAR",
    authority: "Ripple",
    note: "An RLUSD-denominated obligation recorded at nanodollar precision, not yet settled on a rail.",
  },
});

/**
 * Register an XRPL issued currency against a specific issuing account.
 *
 * Issued currencies are only meaningful with their issuer, so this is the only
 * way to get one into the registry: there is no symbol-only fallback.
 */
export function registerXrplIssuedCurrency(options: {
  readonly symbol: string;
  readonly issuer: string;
  readonly network?: "XRPL" | "XRPL_TESTNET";
  readonly peg?: PegPolicy;
}): AssetDefinition {
  const network = options.network ?? "XRPL";
  return registerAsset({
    symbol: options.symbol,
    network,
    decimals: XRPL_ISSUED_DECIMALS,
    kind: "XRPL_ISSUED",
    issuer: options.issuer,
    peg:
      options.peg ??
      {
        kind: "NONE",
        note: `Issued currency ${options.symbol} from ${options.issuer}; no peg is registered for this issuer.`,
      },
  });
}

/** Register an ERC-20 against a specific contract address. */
export function registerErc20(options: {
  readonly symbol: string;
  readonly network: NetworkId;
  readonly contract: string;
  readonly decimals: number;
  readonly peg?: PegPolicy;
}): AssetDefinition {
  return registerAsset({
    symbol: options.symbol,
    network: options.network,
    decimals: options.decimals,
    kind: "ERC20",
    contract: options.contract,
    peg:
      options.peg ??
      {
        kind: "NONE",
        note: `Token ${options.symbol} at ${options.contract}; no peg is registered for this contract.`,
      },
  });
}
