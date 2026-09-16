/**
 * EIP-712 typed-data encoding for EconomicIntent.
 *
 * This is the deterministic-parity boundary (PRODUCT_SPEC §23): the struct the
 * UI shows, the struct this module hashes, and the struct a verifying contract
 * decodes must be the same struct. So the encoding here is written out
 * explicitly rather than derived from whatever fields happen to be on the
 * object, and the field order is frozen — reordering `INTENT_TYPE` changes
 * every signature ever produced.
 *
 * `keccak256` is injected rather than imported: the kernel stays dependency-free
 * and the web app supplies viem's implementation. The parity test asserts this
 * encoder and viem's `hashTypedData` agree byte for byte.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";
import { nanosToBaseUnits } from "../units/money";
import type { EconomicIntent } from "./schema";

export type Keccak256 = (bytes: Uint8Array) => Uint8Array;

export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: string;
}

export const EIP712_DOMAIN_NAME = "AgentCorrespondent";
export const EIP712_DOMAIN_VERSION = "1";

/**
 * Frozen field order. Changing this is a breaking protocol change and requires
 * a new `version` in the intent itself.
 */
export const INTENT_TYPE = [
  { name: "intentId", type: "bytes32" },
  { name: "version", type: "uint16" },
  { name: "buyerAgentId", type: "bytes32" },
  { name: "providerAgentId", type: "bytes32" },
  { name: "serviceHash", type: "bytes32" },
  { name: "maxSpend", type: "uint256" },
  { name: "minReceive", type: "uint256" },
  { name: "settlementAsset", type: "bytes32" },
  { name: "allowedRails", type: "bytes32" },
  { name: "maxFxSlippageBps", type: "uint16" },
  { name: "maxNetworkFee", type: "uint256" },
  { name: "evaluator", type: "bytes32" },
  { name: "destination", type: "bytes32" },
  { name: "network", type: "bytes32" },
  { name: "deadline", type: "uint64" },
  { name: "nonce", type: "bytes32" },
  { name: "createdAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const EIP712_TYPES = {
  EconomicIntent: INTENT_TYPE.map((f) => ({ name: f.name, type: f.type })),
} as const;

export interface TypedDataMessage {
  readonly domain: Eip712Domain;
  readonly types: { readonly EconomicIntent: readonly { name: string; type: string }[] };
  readonly primaryType: "EconomicIntent";
  readonly message: Readonly<Record<string, string | number | bigint>>;
}

const encoder = new TextEncoder();

function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function word(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("EIP-712 words are unsigned");
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v > 0n) throw new Error("value does not fit in 32 bytes");
  return out;
}

function bytes32(value: string): Uint8Array {
  const raw = hexToBytes(value);
  if (raw.length !== 32) throw new Error(`expected 32 bytes, got ${raw.length}`);
  return raw;
}

/**
 * Short identifiers (agent ids, asset symbols, rail lists) are carried on-chain
 * as `bytes32`. Rather than truncating them — which would let `agent_184a` and
 * `agent_184b` collide — each is hashed.
 */
function hashedString(value: string, keccak256: Keccak256): Uint8Array {
  return keccak256(utf8(value));
}

export function encodeType(): string {
  const fields = INTENT_TYPE.map((f) => `${f.type} ${f.name}`).join(",");
  return `EconomicIntent(${fields})`;
}

export function typeHash(keccak256: Keccak256): Uint8Array {
  return keccak256(utf8(encodeType()));
}

export function domainSeparator(domain: Eip712Domain, keccak256: Keccak256): Uint8Array {
  const domainTypeHash = keccak256(
    utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  const address = hexToBytes(domain.verifyingContract);
  const addressWord = new Uint8Array(32);
  addressWord.set(address, 12);
  return keccak256(
    concat([
      domainTypeHash,
      keccak256(utf8(domain.name)),
      keccak256(utf8(domain.version)),
      word(BigInt(domain.chainId)),
      addressWord,
    ]),
  );
}

/**
 * Canonical, deterministic rail encoding: the allowlist is sorted and joined so
 * that `["X402","MULEDGER"]` and `["MULEDGER","X402"]` are the same
 * authorization and produce the same digest.
 */
export function canonicalRails(rails: readonly string[]): string {
  return [...new Set(rails)].sort().join("|");
}

/**
 * Build the typed-data message, ready to hand to a wallet or to viem.
 *
 * Two conversions happen here, and both are deliberate:
 *
 *  - Free-form identifiers (agent ids, asset symbol, evaluator, destination,
 *    network, rail list) are `keccak256`-hashed into `bytes32`. Truncating them
 *    into 32 bytes instead would let `agent_184a` and `agent_184b` collide.
 *  - `maxSpend`, `minReceive` and `maxNetworkFee` are converted from nanos into
 *    the settlement asset's own base units, because that is the number a
 *    contract will move. The conversion is `exact`: if the authorized amount
 *    cannot be expressed on the target rail, compilation fails rather than
 *    rounding the user's money in either direction.
 */
export function buildIntentTypedData(
  intent: EconomicIntent,
  keccak256: Keccak256,
): Outcome<TypedDataMessage> {
  const maxSpend = nanosToBaseUnits(intent.maxSpend, intent.network, intent.settlementAsset);
  if (!maxSpend.ok) return maxSpend as Outcome<TypedDataMessage>;
  const minReceive = nanosToBaseUnits(intent.minReceive, intent.network, intent.settlementAsset);
  if (!minReceive.ok) return minReceive as Outcome<TypedDataMessage>;
  const maxNetworkFee = nanosToBaseUnits(
    intent.maxNetworkFee,
    intent.network,
    intent.settlementAsset,
  );
  if (!maxNetworkFee.ok) return maxNetworkFee as Outcome<TypedDataMessage>;

  if (intent.chainId <= 0) {
    return fail(violation("CHAIN_MISMATCH", "intent must be bound to a chain id"));
  }

  const tag = (value: string): string => bytesToHex(hashedString(value, keccak256));

  return ok({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: intent.chainId,
      verifyingContract: intent.verifyingContract,
    },
    types: EIP712_TYPES,
    primaryType: "EconomicIntent",
    message: {
      intentId: tag(intent.intentId),
      version: intent.version,
      buyerAgentId: tag(intent.buyerAgentId),
      providerAgentId: tag(intent.providerAgentId),
      serviceHash: intent.serviceHash,
      maxSpend: maxSpend.value,
      minReceive: minReceive.value,
      settlementAsset: tag(intent.settlementAsset),
      allowedRails: tag(canonicalRails(intent.allowedRails)),
      maxFxSlippageBps: intent.maxFxSlippageBps,
      maxNetworkFee: maxNetworkFee.value,
      evaluator: tag(intent.evaluator),
      destination: tag(intent.destination),
      network: tag(intent.network),
      deadline: intent.deadline,
      nonce: intent.nonce,
      createdAt: intent.createdAt,
      expiresAt: intent.expiresAt,
    },
  });
}

/** `hashStruct(EconomicIntent)` — the inner half of the EIP-712 digest. */
export function hashIntentStruct(
  intent: EconomicIntent,
  keccak256: Keccak256,
): Outcome<Uint8Array> {
  const typed = buildIntentTypedData(intent, keccak256);
  if (!typed.ok) return typed as Outcome<Uint8Array>;
  const message = typed.value.message;

  const words: Uint8Array[] = [typeHash(keccak256)];
  for (const field of INTENT_TYPE) {
    const value = message[field.name];
    switch (field.type) {
      case "bytes32": {
        if (typeof value !== "string") throw new Error(`field ${field.name} must be a string`);
        words.push(bytes32(value));
        break;
      }
      case "uint16":
      case "uint64":
      case "uint256": {
        words.push(word(BigInt(value as number | bigint)));
        break;
      }
      default:
        throw new Error(`unsupported EIP-712 field type: ${String(field satisfies never)}`);
    }
  }

  return ok(keccak256(concat(words)));
}

/** Full EIP-712 digest: `keccak256(0x1901 ++ domainSeparator ++ hashStruct)`. */
export function hashIntent(intent: EconomicIntent, keccak256: Keccak256): Outcome<string> {
  const structHash = hashIntentStruct(intent, keccak256);
  if (!structHash.ok) return structHash as Outcome<string>;
  const typed = buildIntentTypedData(intent, keccak256);
  if (!typed.ok) return typed as Outcome<string>;
  const digest = keccak256(
    concat([
      new Uint8Array([0x19, 0x01]),
      domainSeparator(typed.value.domain, keccak256),
      structHash.value,
    ]),
  );
  return ok(bytesToHex(digest));
}
