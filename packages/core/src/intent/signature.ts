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
 * The recovery itself, and the rules around it (65-byte form, low-`s` only),
 * live in `../crypto/ecdsa` so that an authorization over an intent and a proof
 * of wallet control are checked by exactly the same code.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";
import { hexToBytes, recoverAddress } from "../crypto/ecdsa";
import { hashIntent, type Keccak256 } from "./eip712";
import type { EconomicIntent } from "./schema";

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

  const digestBytes = hexToBytes(digest.value);
  if (!digestBytes) {
    return fail(violation("SIGNATURE_INVALID", "intent digest is not valid hex"));
  }

  return recoverAddress(digestBytes, signature, keccak256);
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
