import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseWebhookDelivery, verifyWebhookSignature } from "../src/webhooks";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ event: "job.settled", deliveredAt: "2026-01-01T00:00:00.000Z", data: { jobId: "job_1" } });

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyWebhookSignature(SECRET, BODY, sign(SECRET, BODY))).toBe(true);
  });

  it("ATTACK: rejects a signature from the wrong secret", () => {
    expect(verifyWebhookSignature(SECRET, BODY, sign("wrong-secret", BODY))).toBe(false);
  });

  it("ATTACK: rejects when the body was tampered with after signing", () => {
    const signature = sign(SECRET, BODY);
    const tampered = BODY.replace("job_1", "job_evil");
    expect(verifyWebhookSignature(SECRET, tampered, signature)).toBe(false);
  });

  it("does not throw on a garbage signature header", () => {
    expect(verifyWebhookSignature(SECRET, BODY, "not-a-hex-string!!")).toBe(false);
  });
});

describe("parseWebhookDelivery", () => {
  it("parses and returns the typed payload when the signature is valid", () => {
    const parsed = parseWebhookDelivery<{ jobId: string }>(SECRET, BODY, sign(SECRET, BODY));
    expect(parsed.event).toBe("job.settled");
    expect(parsed.data.jobId).toBe("job_1");
  });

  it("throws rather than returning an unverified payload", () => {
    expect(() => parseWebhookDelivery(SECRET, BODY, sign("wrong-secret", BODY))).toThrow(/signature/i);
  });
});
