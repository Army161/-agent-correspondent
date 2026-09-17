/**
 * Webhook secret encryption, and delivery signing.
 *
 * A webhook secret has to be used later, to sign each delivery — unlike an
 * API key, it cannot be stored as a one-way hash, because a hash cannot be
 * turned back into the value HMAC needs. Encrypting it at rest under a
 * server-held key is the honest alternative to storing it in the clear.
 *
 * Pure and dependency-light (no "server-only", no database) so it can be
 * tested exhaustively -- same convention as `lib/billing/paddle-signature.ts`.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function encryptionKey(): Buffer | null {
  const hex = process.env.WEBHOOK_ENCRYPTION_KEY?.trim();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

export function webhookEncryptionConfigured(): boolean {
  return encryptionKey() !== null;
}

/** A fresh, random signing secret for one webhook subscription. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/** `iv:authTag:ciphertext`, each hex-encoded. Throws if no key is configured. */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  if (!key) {
    throw new Error("WEBHOOK_ENCRYPTION_KEY is not configured; cannot store a webhook secret.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const key = encryptionKey();
  if (!key) {
    throw new Error("WEBHOOK_ENCRYPTION_KEY is not configured; cannot read a webhook secret.");
  }
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted webhook secret.");
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * HMAC-SHA256 over the exact bytes sent, hex-encoded. A receiver recomputes
 * this over the raw request body it received (not a re-serialization of it)
 * and compares in constant time -- see `verifyWebhookSignature` in the SDK.
 */
export function signPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = signPayload(secret, rawBody);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
