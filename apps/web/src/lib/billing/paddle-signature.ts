/**
 * Paddle webhook signature verification.
 *
 * Pure and dependency-light so it can be tested exhaustively, and deliberately
 * separate from the handler: the decision "is this really from Paddle" is the
 * whole security boundary of the billing system, and it should be possible to
 * read it without reading anything else.
 *
 * Paddle signs `${timestamp}:${rawBody}` with HMAC-SHA256 under the endpoint's
 * secret and sends `Paddle-Signature: ts=<unix>;h1=<hex>`. So:
 *
 *  - the *raw* body is what is signed. Re-serialising parsed JSON changes
 *    bytes and breaks the signature, which is why the handler reads text.
 *  - the comparison is constant-time. A byte-by-byte early return leaks the
 *    expected digest one character at a time.
 *  - old deliveries are rejected on age, so a captured request cannot be
 *    replayed indefinitely.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureFailure =
  | "MISSING_HEADER"
  | "MALFORMED_HEADER"
  | "MISSING_SECRET"
  | "BAD_TIMESTAMP"
  | "STALE"
  | "MISMATCH";

export type SignatureResult =
  | { readonly ok: true; readonly timestamp: Date }
  | { readonly ok: false; readonly reason: SignatureFailure };

/** How old a delivery may be. Paddle retries within minutes, not hours. */
export const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

interface ParsedHeader {
  readonly ts: string;
  readonly h1: readonly string[];
}

function parseHeader(header: string): ParsedHeader | null {
  let ts: string | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "ts") ts = value;
    // More than one h1 appears while an endpoint secret is being rotated.
    else if (key === "h1" && value.length > 0) h1.push(value);
  }
  if (!ts || h1.length === 0) return null;
  return { ts, h1 };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyPaddleSignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  now: Date = new Date(),
): SignatureResult {
  if (!secret || secret.trim().length === 0) return { ok: false, reason: "MISSING_SECRET" };
  if (!header || header.trim().length === 0) return { ok: false, reason: "MISSING_HEADER" };

  const parsed = parseHeader(header);
  if (!parsed) return { ok: false, reason: "MALFORMED_HEADER" };

  if (!/^\d{1,15}$/.test(parsed.ts)) return { ok: false, reason: "BAD_TIMESTAMP" };
  const seconds = Number(parsed.ts);
  const ageSeconds = Math.abs(now.getTime() / 1000 - seconds);
  // Symmetric: a timestamp far in the future is as suspicious as a stale one,
  // and tolerating it would let a captured delivery be replayed later.
  if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) return { ok: false, reason: "STALE" };

  const expected = createHmac("sha256", secret.trim())
    .update(`${parsed.ts}:${rawBody}`)
    .digest("hex");

  for (const candidate of parsed.h1) {
    if (constantTimeEqualHex(candidate, expected)) {
      return { ok: true, timestamp: new Date(seconds * 1000) };
    }
  }
  return { ok: false, reason: "MISMATCH" };
}

/** Build a header the way Paddle does. Used by the tests, and only by them. */
export function signPaddlePayload(rawBody: string, secret: string, at: Date): string {
  const ts = Math.floor(at.getTime() / 1000).toString();
  const h1 = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}
