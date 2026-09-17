/**
 * Post-quantum crypto-agility.
 *
 * What this module is **not**: a claim that anything in this product is
 * "quantum-proof" or "quantum-safe". No such claim is made anywhere in this
 * codebase, and this file exists partly to make one structurally hard to
 * make by accident — every function here names the exact algorithm and
 * standard involved, and the word "proof" appears nowhere in this file.
 *
 * What it is: a small, explicit registry of signature algorithms, so that
 * (a) nothing in this system hard-codes "the signature algorithm is
 * secp256k1" in a way that would require a rewrite to change, and (b) a
 * **secondary attestation** — a second, independent signature over the same
 * document, using ML-DSA (FIPS 204, formerly Dilithium) — can be attached
 * to a credential alongside its required classical signature.
 *
 * The secondary attestation is additive, never a replacement. A credential
 * with a valid Ed25519 signature and no ML-DSA attestation is exactly as
 * valid as it was before this module existed. What a secondary attestation
 * buys is that if classical elliptic-curve cryptography is later broken by
 * a cryptographically relevant quantum computer — which has not happened,
 * and this codebase makes no prediction about when or whether it will — a
 * credential carrying one would still be independently verifiable through
 * an algorithm not vulnerable to the same attack. That is what
 * "crypto-agility" means here: an explicit, swappable choice of algorithm,
 * not a guarantee about the future.
 *
 * Implementation: `@noble/post-quantum`, the same audited family as
 * `@noble/curves` already used for the rest of this codebase's signatures.
 * No cryptographic primitive is implemented in this file.
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

import { fail, ok, violation, type Outcome } from "../errors/index";

/**
 * Every signature algorithm this codebase knows how to name.
 *
 * `secp256k1-ecdsa` and `ed25519` are what every wallet-signed
 * EconomicIntent and every classical credential signature use today, and
 * this module does not change that — see the module docstring on why
 * wallet-facing signatures are out of scope for a PQ swap.
 */
export type SignatureAlgorithmId = "secp256k1-ecdsa" | "ed25519" | "ml-dsa-65";

export interface AlgorithmInfo {
  readonly id: SignatureAlgorithmId;
  /** The standard this algorithm is defined by, stated exactly. */
  readonly standard: string;
  /** Whether this algorithm is believed resistant to a large-scale quantum computer. */
  readonly postQuantum: boolean;
  readonly publicKeyBytes: number;
  readonly secretKeyBytes: number;
  readonly signatureBytes: number;
}

export const ALGORITHMS: Readonly<Record<SignatureAlgorithmId, AlgorithmInfo>> = {
  "secp256k1-ecdsa": {
    id: "secp256k1-ecdsa",
    standard: "SEC 1 / Ethereum's signing convention",
    postQuantum: false,
    publicKeyBytes: 65,
    secretKeyBytes: 32,
    signatureBytes: 65,
  },
  ed25519: {
    id: "ed25519",
    standard: "RFC 8032",
    postQuantum: false,
    publicKeyBytes: 32,
    secretKeyBytes: 32,
    signatureBytes: 64,
  },
  "ml-dsa-65": {
    id: "ml-dsa-65",
    standard: "FIPS 204 (ML-DSA, security category 3)",
    postQuantum: true,
    publicKeyBytes: 1952,
    secretKeyBytes: 4032,
    signatureBytes: 3309,
  },
};

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export interface MlDsaKeypair {
  readonly publicKey: string;
  readonly secretKey: string;
}

/**
 * Generate an ML-DSA-65 keypair from a caller-supplied 32-byte seed.
 *
 * The seed is the caller's responsibility to generate with a real CSPRNG and
 * to hold with the same care as any other private key — this function does
 * not store anything.
 */
export function generateMlDsaKeypair(seedHex: string): Outcome<MlDsaKeypair> {
  const seed = hexToBytes(seedHex);
  if (!seed || seed.length !== 32) {
    return fail(violation("SIGNATURE_INVALID", "seed must be 32 bytes of hex"));
  }
  try {
    const keys = ml_dsa65.keygen(seed);
    return ok({ publicKey: bytesToHex(keys.publicKey), secretKey: bytesToHex(keys.secretKey) });
  } catch (error) {
    return fail(
      violation(
        "SIGNATURE_INVALID",
        error instanceof Error ? error.message : "could not generate an ML-DSA keypair",
      ),
    );
  }
}

/** Sign arbitrary bytes with an ML-DSA-65 secret key. */
export function signMlDsa(message: Uint8Array, secretKeyHex: string): Outcome<string> {
  const secretKey = hexToBytes(secretKeyHex);
  if (!secretKey || secretKey.length !== ALGORITHMS["ml-dsa-65"].secretKeyBytes) {
    return fail(
      violation(
        "SIGNATURE_INVALID",
        `ML-DSA secret key must be ${ALGORITHMS["ml-dsa-65"].secretKeyBytes} bytes of hex`,
      ),
    );
  }
  try {
    return ok(bytesToHex(ml_dsa65.sign(message, secretKey)));
  } catch (error) {
    return fail(
      violation(
        "SIGNATURE_INVALID",
        error instanceof Error ? error.message : "could not produce an ML-DSA signature",
      ),
    );
  }
}

/** Verify an ML-DSA-65 signature. A malformed input is "not verified", never a throw. */
export function verifyMlDsa(
  message: Uint8Array,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  const signature = hexToBytes(signatureHex);
  const publicKey = hexToBytes(publicKeyHex);
  if (!signature || !publicKey) return false;
  if (signature.length !== ALGORITHMS["ml-dsa-65"].signatureBytes) return false;
  if (publicKey.length !== ALGORITHMS["ml-dsa-65"].publicKeyBytes) return false;
  try {
    return ml_dsa65.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export interface SecondaryAttestation {
  readonly algorithm: "ml-dsa-65";
  readonly publicKey: string;
  readonly signature: string;
}

/**
 * Verify a secondary attestation over the same bytes a primary signature
 * covers.
 *
 * This never substitutes for the primary (classical) signature check — call
 * it in addition to, never instead of, verifying the required signature.
 * Its absence is not a failure: a document with no secondary attestation is
 * exactly as valid as one predating this module.
 */
export function verifySecondaryAttestation(
  message: Uint8Array,
  attestation: SecondaryAttestation | null,
): boolean {
  if (!attestation) return true;
  if (attestation.algorithm !== "ml-dsa-65") return false;
  return verifyMlDsa(message, attestation.signature, attestation.publicKey);
}
