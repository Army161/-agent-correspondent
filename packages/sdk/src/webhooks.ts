/**
 * Verify an Agent Correspondent webhook delivery.
 *
 * See docs/WEBHOOKS.md in the main repository. `rawBody` must be the exact
 * bytes received — read the request body as text before any JSON.parse, so
 * re-serialization cannot silently change what gets hashed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(secret: string, rawBody: string, signatureHeader: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, "hex");
    b = Buffer.from(signatureHeader, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WebhookDeliveryEnvelope<T = unknown> {
  readonly event: string;
  readonly deliveredAt: string;
  readonly data: T;
}

/** Parse a webhook body after verifying its signature. Throws if the signature does not match. */
export function parseWebhookDelivery<T = unknown>(
  secret: string,
  rawBody: string,
  signatureHeader: string,
): WebhookDeliveryEnvelope<T> {
  if (!verifyWebhookSignature(secret, rawBody, signatureHeader)) {
    throw new Error("Webhook signature does not match this body and secret.");
  }
  return JSON.parse(rawBody) as WebhookDeliveryEnvelope<T>;
}
