/**
 * Proof of XRPL account control.
 *
 * The message and the time rules are in `@acor/core`, which stays free of
 * ledger dependencies. What lives here is the part that needs XRPL key
 * handling: verifying the signature, and checking that the account the signer's
 * public key derives to is the one being claimed.
 *
 * Two things make this safe.
 *
 *  1. **Domain separation.** Every XRPL signing routine prepends a four-byte
 *     prefix: `STX\0` for a single-signed transaction, `SMT\0` for a
 *     multi-signed one, `CLM\0` for a payment-channel claim. `ACOR` is none of
 *     those, so a signature collected here cannot be replayed as a transaction
 *     or a claim. The signer commits to a sentence, never to a transfer.
 *  2. **Derivation, not assertion.** The claimed address is not compared to
 *     something the caller sent; it is derived from the public key that
 *     produced the signature. A caller who sends a stranger's address and their
 *     own key fails at that step.
 *
 * The signing itself is XRPL's own ed25519 / secp256k1 scheme via
 * `ripple-keypairs`. Nothing cryptographic is invented here.
 */

import { deriveAddress, verify as verifySignature } from "ripple-keypairs";

import {
  fail,
  ok,
  violation,
  xrplChallengeWindow,
  xrplOwnershipMessage,
  xrplProofPayloadHex,
  type Outcome,
  type XrplOwnershipChallenge,
} from "@acor/core";

/** Public keys are 33 bytes: `ED` + 32 for ed25519, or a compressed secp256k1 point. */
const PUBLIC_KEY = /^[0-9A-Fa-f]{66}$/;
const SIGNATURE = /^[0-9A-Fa-f]{16,256}$/;

/**
 * Verify a proof of control over an XRPL account.
 *
 * `now` is passed in so expiry is testable and so one request evaluates every
 * check against a single instant.
 *
 * This does not check that the nonce was issued by us or is unused — that is a
 * storage question, answered where the storage is.
 */
export function verifyXrplOwnershipProof(
  challenge: XrplOwnershipChallenge,
  publicKey: string,
  signature: string,
  now: Date,
): Outcome<string> {
  const window = xrplChallengeWindow(challenge, now);
  if (!window.ok) return window as Outcome<string>;

  if (!PUBLIC_KEY.test(publicKey)) {
    return fail(violation("SIGNATURE_INVALID", "public key must be 33 bytes of hex"));
  }
  if (!SIGNATURE.test(signature)) {
    return fail(violation("SIGNATURE_INVALID", "signature must be hex"));
  }

  const message = xrplOwnershipMessage(challenge);
  if (!message.ok) return message as Outcome<string>;

  const payload = xrplProofPayloadHex(message.value);

  let valid = false;
  try {
    valid = verifySignature(payload, signature, publicKey);
  } catch {
    // A signature from the wrong curve throws while being parsed. A throw is
    // "not verified", and must never escape as a 500.
    valid = false;
  }
  if (!valid) {
    return fail(violation("SIGNATURE_INVALID", "the signature did not verify against that key"));
  }

  let derived: string;
  try {
    derived = deriveAddress(publicKey);
  } catch {
    return fail(violation("SIGNATURE_INVALID", "no XRPL address derives from that public key"));
  }

  // The address is derived from the key that signed, never taken on trust.
  if (derived !== challenge.address) {
    return fail(
      violation(
        "SIGNER_MISMATCH",
        "the signing key belongs to a different account than the one being claimed",
        { claimed: challenge.address, derived },
      ),
    );
  }

  return ok(derived);
}
