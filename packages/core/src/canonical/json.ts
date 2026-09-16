/**
 * Canonical serialization.
 *
 * Two systems must agree byte-for-byte on what a document *is* before they can
 * agree on its hash: the intent compiler in this repo, and whatever verifies
 * the same intent on-chain. The rules here are deliberately narrow — anything
 * whose encoding is ambiguous is rejected rather than guessed at.
 *
 * Rules:
 *  - object keys sorted by UTF-16 code unit, no insignificant whitespace
 *  - `bigint` serializes as a base-10 string (JSON numbers cannot hold nanos)
 *  - `undefined` properties are dropped; explicit `null` is preserved
 *  - non-finite numbers, functions, symbols and cycles are errors
 *  - non-integer numbers are errors: every amount in this system is an integer
 *    count of nanos, and a float in a canonical document is a bug
 */

import { sha256Hex } from "./sha256";

export type CanonicalValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export function canonicalize(value: CanonicalValue): string {
  return write(value, new Set());
}

function write(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString(10));
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalize: non-finite number (${value})`);
      }
      if (!Number.isInteger(value)) {
        throw new Error(
          `canonicalize: non-integer number (${value}). Amounts must be integer nanos.`,
        );
      }
      return JSON.stringify(value);
    case "undefined":
      throw new Error("canonicalize: undefined is not a canonical value");
    case "function":
    case "symbol":
      throw new Error(`canonicalize: ${typeof value} is not serializable`);
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) throw new Error("canonicalize: circular reference");
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => write(item, seen)).join(",")}]`;
    }
    const entries = Object.entries(object as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v, seen)}`).join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/** `0x`-prefixed SHA-256 of the canonical form. Stable across runtimes and releases. */
export function canonicalHash(value: CanonicalValue): string {
  return sha256Hex(canonicalize(value));
}

/**
 * Domain-separated canonical hash.
 *
 * A receipt hash and an intent hash must never collide even if the documents
 * happen to be structurally identical, so the document type is mixed in.
 */
export function domainHash(domain: string, value: CanonicalValue): string {
  return sha256Hex(`acor:${domain}:${canonicalize(value)}`);
}
