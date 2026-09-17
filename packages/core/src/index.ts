/**
 * @acor/core — the Agent Correspondent economic kernel.
 *
 * Everything in this package is deterministic and dependency-light: no network
 * calls, no database, no model. The language model reasons; this package
 * decides. That boundary is the whole security model.
 */

export * from "./errors/index";
export * from "./ids/index";
export * from "./units/money";
export * from "./units/decimal";
export * from "./assets/index";
export * from "./canonical/sha256";
export * from "./canonical/json";
export * from "./mandate/schema";
export * from "./mandate/engine";
export * from "./intent/schema";
export * from "./intent/eip712";
export * from "./intent/compile";
export * from "./intent/signature";
export * from "./bounds/index";
export * from "./relay/index";
export * from "./discovery/index";
export * from "./procurement/index";
export * from "./procurement/auction";
export * from "./capability/index";
export * from "./manifest/index";
export * from "./router/index";
export * from "./muledger/ledger";
export * from "./muledger/netting";
export * from "./receipts/index";
export * from "./reputation/index";
export * from "./jobs/lifecycle";
export * from "./onboarding/index";
export * from "./identity/verification";
export * from "./credentials/index";
export {
  HALF_CURVE_ORDER,
  addressFromPublicKey,
  hexToBytes,
  recoverAddress,
} from "./crypto/ecdsa";
export * from "./wallet/ownership";
