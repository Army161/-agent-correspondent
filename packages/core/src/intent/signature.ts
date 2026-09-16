/**
 * EIP-712 signature verification.
 *
 * The relay's central security property is that owning it completely still
 * cannot cause a payment, because a payment needs a signature the relay cannot
 * produce. That property is only real if signatures are actually checked, so
 * this module does the checking — over the same digest
 * `buildIntentTypedData` produces, which is the digest a wallet displays and
 * signs.
 *
 * ECDSA recovery is delegated to `@noble/curves` rather than hand-rolled.
 * `keccak256` stays injected so the kernel does not take an EVM dependency and
 * so the parity tests can feed it viem's implementation.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { fail, ok, violation, type Outcome } from "../errors/index";
import { hashIntent, type Keccak256 } from "./eip712";
import type { EconomicIntent } from "./schema";

/** secp256k1's group order. Signatures at or above n/2 are malleable. */
const HALF_CURVE_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Derive an Ethereum address from an uncompressed public key: the low 20 bytes
 * of the keccak hash of the key without its `0x04` prefix.
 */
function addressFromPublicKey(publicKey: Uint8Array, keccak256: Keccak256): string {
  const body = publicKey[0] === 0x04 ? publicKey.slice(1) : publicKey;
  const hash = keccak256(body);
  let out = "0x";
  for (const byte of hash.slice(12)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Recover the address that produced `signature` over this intent's digest.
 *
 * Accepts the 65-byte `r ‖ s ‖ v` form wallets produce, with `v` as 27/28 or
 * 0/1. High-`s` signatures are rejected: every `(r, s)` has a valid
 * complementary `(r, n - s)`, so accepting both would give one authorization
 * two distinct signature encodings — and anything keyed on the signature bytes
 * would see them as two different things.
 */
export async function recoverIntentSigner(
  intent: EconomicIntent,
  signature: string,
  keccak256: Keccak256,
): Promise<Outcome<string>> {
  const digest = hashIntent(intent, keccak256);
  if (!digest.ok) return digest as Outcome<string>;

  const bytes = hexToBytes(signature);
  if (!bytes || bytes.length !== 65) {
    return fail(
      violation(
        "SIGNATURE_INVALID",
        `signature must be 65 bytes of hex (r, s, v); got ${bytes ? `${bytes.length} bytes` : "malformed hex"}`,
      ),
    );
  }

  const r = toBigInt(bytes.slice(0, 32));
  const s = toBigInt(bytes.slice(32, 64));
  const vRaw = bytes[64] as number;
  const recovery = vRaw >= 27 ? vRaw - 27 : vRaw;

  if (recovery !== 0 && recovery !== 1) {
    return fail(
      violation("SIGNATURE_INVALID", `unsupported recovery parameter v=${vRaw}`, { v: vRaw }),
    );
  }
  if (r === 0n || s === 0n) {
    return fail(violation("SIGNATURE_INVALID", "signature r and s must both be non-zero"));
  }
  if (s > HALF_CURVE_ORDER) {
    return fail(
      violation(
        "SIGNATURE_INVALID",
        "signature has a high s value; only the canonical low-s form is accepted",
      ),
    );
  }

  const digestBytes = hexToBytes(digest.value);
  if (!digestBytes) {
    return fail(violation("SIGNATURE_INVALID", "intent digest is not valid hex"));
  }

  try {
    const parsed = new secp256k1.Signature(r, s).addRecoveryBit(recovery);
    const publicKey = parsed.recoverPublicKey(digestBytes).toBytes(false);
    return ok(addressFromPublicKey(publicKey, keccak256));
  } catch (error) {
    return fail(
      violation(
        "SIGNATURE_INVALID",
        error instanceof Error ? error.message : "signature could not be recovered",
      ),
    );
  }
}

/**
 * Verify that `signature` over this intent recovers to `expectedSigner`.
 *
 * Address comparison is case-insensitive because EVM addresses are checksummed
 * inconsistently across tools. Nothing else about the comparison is lenient.
 */
export async function verifyIntentSignature(
  intent: EconomicIntent,
  signature: string,
  expectedSigner: string,
  keccak256: Keccak256,
): Promise<Outcome<string>> {
  const recovered = await recoverIntentSigner(intent, signature, keccak256);
  if (!recovered.ok) return recovered;

  if (recovered.value.toLowerCase() !== expectedSigner.trim().toLowerCase()) {
    return fail(
      violation(
        "SIGNER_MISMATCH",
        "signature does not recover to the declared signer",
        { declared: expectedSigner, recovered: recovered.value },
      ),
    );
  }
  return ok(recovered.value);
}
