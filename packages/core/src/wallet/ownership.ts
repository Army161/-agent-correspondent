/**
 * Proof of wallet control.
 *
 * An address typed into a form is a claim, not a fact. Binding an unproven
 * address to an agent would let anyone name someone else's wallet as that
 * agent's — which is, at best, a way to display a stranger's balance as your
 * own, and at worst a way to make a payout instruction point somewhere its
 * owner never agreed to.
 *
 * So binding requires a signature over a challenge this service issued. The
 * message follows EIP-4361 (Sign-In with Ethereum) in shape, because wallets
 * render that format legibly and users have learned to read it; and it is
 * hashed per EIP-191 `personal_sign`, so it can never be mistaken for a
 * transaction.
 *
 * The prefix is the point. `\x19Ethereum Signed Message:\n<len>` cannot be the
 * start of an RLP-encoded transaction, so a signature collected here can never
 * be replayed as one.
 */

import { fail, ok, violation, type Outcome } from "../errors/index";
import { recoverAddress, type Keccak256 } from "../crypto/ecdsa";

export interface OwnershipChallenge {
  /** The domain asking for the proof, e.g. `agentcorrespondent.com`. */
  readonly domain: string;
  /** The address being claimed, in the checksum-insensitive lower form. */
  readonly address: string;
  /** Why the signature is being asked for, shown to the user by the wallet. */
  readonly statement: string;
  readonly uri: string;
  readonly chainId: number;
  /** A single-use random value issued by this service. */
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** What the proof will be bound to, so one proof cannot be reused elsewhere. */
  readonly resource: string;
}

const ASCII_TEXT = /^[\x20-\x7e]*$/;

/**
 * Render the message a wallet will display and sign.
 *
 * Deterministic and ASCII-only. A newline or a control character smuggled into
 * the domain or the statement could forge the lines below it — the classic way
 * to make a signed message say something the signer did not read.
 */
export function ownershipMessage(challenge: OwnershipChallenge): Outcome<string> {
  for (const [field, value] of [
    ["domain", challenge.domain],
    ["statement", challenge.statement],
    ["uri", challenge.uri],
    ["nonce", challenge.nonce],
    ["resource", challenge.resource],
  ] as const) {
    if (!ASCII_TEXT.test(value)) {
      return fail(
        violation(
          "CHALLENGE_MALFORMED",
          `${field} must be printable ASCII with no line breaks; a newline here would forge the rest of the message`,
          { field },
        ),
      );
    }
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(challenge.address)) {
    return fail(violation("CHALLENGE_MALFORMED", "address must be a 20-byte hex address"));
  }
  if (!/^[A-Za-z0-9]{8,64}$/.test(challenge.nonce)) {
    return fail(violation("CHALLENGE_MALFORMED", "nonce must be 8-64 alphanumeric characters"));
  }

  const lines = [
    `${challenge.domain} wants you to sign in with your Ethereum account:`,
    challenge.address,
    "",
    challenge.statement,
    "",
    `URI: ${challenge.uri}`,
    "Version: 1",
    `Chain ID: ${challenge.chainId}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt.toISOString()}`,
    `Expiration Time: ${challenge.expiresAt.toISOString()}`,
    "Resources:",
    `- ${challenge.resource}`,
  ];
  return ok(lines.join("\n"));
}

/** The EIP-191 `personal_sign` digest of a message. */
export function personalSignDigest(message: string, keccak256: Keccak256): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  return keccak256(joined);
}

/**
 * Verify a proof of control.
 *
 * `now` is passed in rather than read, so expiry is testable and so a single
 * request evaluates every check against one instant.
 *
 * This function does **not** check that the nonce was issued by us or that it
 * has not been used before. That is a storage question, and storage is where it
 * is answered — see `apps/web/src/lib/wallets/ownership.ts`.
 */
export function verifyOwnershipProof(
  challenge: OwnershipChallenge,
  signature: string,
  keccak256: Keccak256,
  now: Date,
): Outcome<string> {
  if (now.getTime() >= challenge.expiresAt.getTime()) {
    return fail(
      violation("CHALLENGE_EXPIRED", "this challenge has expired; request a new one", {
        expiresAt: challenge.expiresAt.toISOString(),
      }),
    );
  }
  if (now.getTime() < challenge.issuedAt.getTime() - 60_000) {
    // More than a minute before it was issued means one of the two clocks is
    // wrong, and a proof evaluated against a wrong clock proves nothing.
    return fail(violation("CHALLENGE_MALFORMED", "challenge is not valid yet"));
  }

  const message = ownershipMessage(challenge);
  if (!message.ok) return message as Outcome<string>;

  const digest = personalSignDigest(message.value, keccak256);
  const recovered = recoverAddress(digest, signature, keccak256);
  if (!recovered.ok) return recovered;

  if (recovered.value.toLowerCase() !== challenge.address.toLowerCase()) {
    return fail(
      violation(
        "SIGNER_MISMATCH",
        "the signature was produced by a different address than the one being claimed",
        { claimed: challenge.address.toLowerCase(), recovered: recovered.value.toLowerCase() },
      ),
    );
  }

  return ok(recovered.value.toLowerCase());
}

// ---------------------------------------------------------------------------
// XRPL
// ---------------------------------------------------------------------------

/**
 * The challenge an XRPL account signs.
 *
 * XRPL addresses are not chain-scoped the way an EVM address is, so the network
 * is named rather than numbered — and named in the message, because binding a
 * testnet account as if it were mainnet is exactly the mistake worth making
 * impossible.
 */
export interface XrplOwnershipChallenge {
  readonly domain: string;
  /** The classic `r...` address being claimed. */
  readonly address: string;
  readonly statement: string;
  readonly uri: string;
  /** `XRPL` or `XRPL_TESTNET`. */
  readonly network: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly resource: string;
}

/**
 * Domain separation for XRPL proofs.
 *
 * Every XRPL signing routine prepends a four-byte prefix to what it hashes:
 * `STX\0` for a single-signed transaction, `SMT\0` for a multi-signed one, and
 * `CLM\0` for a payment-channel claim. This prefix is none of those, so a
 * signature collected here cannot be a valid signature over a transaction or a
 * claim — the signer is committing to a sentence, not to a transfer.
 *
 * It is a prefix, not a cipher. The signing itself is XRPL's own ed25519 or
 * secp256k1 scheme, unchanged.
 */
export const XRPL_PROOF_PREFIX = "ACOR";

/** Classic XRPL addresses: base58 with the ripple alphabet, starting `r`. */
const XRPL_ADDRESS = /^r[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{24,63}$/;

/** Render the message an XRPL wallet will display and sign. */
export function xrplOwnershipMessage(challenge: XrplOwnershipChallenge): Outcome<string> {
  for (const [field, value] of [
    ["domain", challenge.domain],
    ["statement", challenge.statement],
    ["uri", challenge.uri],
    ["network", challenge.network],
    ["nonce", challenge.nonce],
    ["resource", challenge.resource],
  ] as const) {
    if (!ASCII_TEXT.test(value)) {
      return fail(
        violation(
          "CHALLENGE_MALFORMED",
          `${field} must be printable ASCII with no line breaks; a newline here would forge the rest of the message`,
          { field },
        ),
      );
    }
  }
  if (!XRPL_ADDRESS.test(challenge.address)) {
    return fail(violation("CHALLENGE_MALFORMED", "address must be a classic XRPL address"));
  }
  if (!/^[A-Za-z0-9]{8,64}$/.test(challenge.nonce)) {
    return fail(violation("CHALLENGE_MALFORMED", "nonce must be 8-64 alphanumeric characters"));
  }

  const lines = [
    `${challenge.domain} asks you to prove control of this XRPL account:`,
    challenge.address,
    "",
    challenge.statement,
    "",
    `URI: ${challenge.uri}`,
    "Version: 1",
    `Network: ${challenge.network}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt.toISOString()}`,
    `Expiration Time: ${challenge.expiresAt.toISOString()}`,
    "Resources:",
    `- ${challenge.resource}`,
  ];
  return ok(lines.join("\n"));
}

/**
 * The exact bytes an XRPL key signs, as uppercase hex.
 *
 * `ripple-keypairs` takes its message as hex, so this is the canonical form of
 * the payload: the prefix, then the message in UTF-8.
 */
export function xrplProofPayloadHex(message: string): string {
  const prefix = new TextEncoder().encode(XRPL_PROOF_PREFIX);
  const body = new TextEncoder().encode(message);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  let out = "";
  for (const byte of joined) out += byte.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

/**
 * Whether the challenge is still answerable.
 *
 * Split out from verification because the signature check needs XRPL key
 * handling, which lives in `@acor/adapters`; the time rules do not, and belong
 * with the rest of the kernel's determinism.
 */
export function xrplChallengeWindow(
  challenge: XrplOwnershipChallenge,
  now: Date,
): Outcome<true> {
  if (now.getTime() >= challenge.expiresAt.getTime()) {
    return fail(
      violation("CHALLENGE_EXPIRED", "this challenge has expired; request a new one", {
        expiresAt: challenge.expiresAt.toISOString(),
      }),
    );
  }
  if (now.getTime() < challenge.issuedAt.getTime() - 60_000) {
    return fail(violation("CHALLENGE_MALFORMED", "challenge is not valid yet"));
  }
  return ok(true);
}
