/** Prefixed, sortable identifiers. */

import { sha256Hex } from "../canonical/sha256";

export type IdPrefix =
  | "agent"
  | "job"
  | "intent"
  | "quote"
  | "receipt"
  | "entry"
  | "cycle"
  | "tx"
  | "settlement"
  | "evt"
  | "key"
  | "hook"
  | "org"
  | "user"
  | "onb"
  | "cred"
  | "sub"
  | "bill"
  | "mandate";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, no i/l/o/u

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(out);
    return out;
  }
  throw new Error("no CSPRNG available: refusing to generate identifiers with Math.random()");
}

function encode(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % 32];
  return out;
}

/** `agent_01j9...` — time-ordered prefix plus 16 random characters. */
export function newId(prefix: IdPrefix): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return `${prefix}_${time}${encode(randomBytes(16))}`;
}

/** A nonce large enough that reuse is never accidental. */
export function newNonce(): string {
  return `0x${Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Stable identifier derived from content — same content, same id, on every machine. */
export function deriveId(prefix: IdPrefix, canonicalForm: string): string {
  return `${prefix}_${sha256Hex(canonicalForm).slice(2, 34)}`;
}
