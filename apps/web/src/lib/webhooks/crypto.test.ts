import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  generateWebhookSecret,
  signPayload,
  verifySignature,
  webhookEncryptionConfigured,
} from "./crypto";

const KEY = "7e1a9c3f5b8d2e6047a1c9f3e5b7d9024a6c8e0f2b4d6a8c0e2f4b6d8a0c2e4f";

describe("webhook secret encryption", () => {
  afterEach(() => {
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
  });

  it("reports unconfigured when no key is set", () => {
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
    expect(webhookEncryptionConfigured()).toBe(false);
    expect(() => encryptSecret("s")).toThrow(/WEBHOOK_ENCRYPTION_KEY/);
  });

  describe("with a key configured", () => {
    beforeEach(() => {
      process.env.WEBHOOK_ENCRYPTION_KEY = KEY;
    });

    it("round-trips a secret exactly", () => {
      const secret = generateWebhookSecret();
      const ciphertext = encryptSecret(secret);
      expect(ciphertext).not.toContain(secret);
      expect(decryptSecret(ciphertext)).toBe(secret);
    });

    it("produces a different ciphertext each time (random IV), same plaintext back", () => {
      const secret = "same-secret-value";
      const a = encryptSecret(secret);
      const b = encryptSecret(secret);
      expect(a).not.toBe(b);
      expect(decryptSecret(a)).toBe(secret);
      expect(decryptSecret(b)).toBe(secret);
    });

    it("ATTACK: a tampered ciphertext fails to decrypt rather than returning garbage", () => {
      const ciphertext = encryptSecret("a-real-secret");
      const parts = ciphertext.split(":");
      const tampered = `${parts[0]}:${parts[1]}:${(parts[2] ?? "").replace(/^../, "ff")}`;
      expect(() => decryptSecret(tampered)).toThrow();
    });

    it("generates a fresh, high-entropy secret each call", () => {
      const a = generateWebhookSecret();
      const b = generateWebhookSecret();
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

describe("webhook delivery signatures", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ event: "job.settled", data: { jobId: "job_1" } });

  it("verifies a signature produced by the same secret", () => {
    const signature = signPayload(secret, body);
    expect(verifySignature(secret, body, signature)).toBe(true);
  });

  it("ATTACK: a signature from a different secret does not verify", () => {
    const signature = signPayload("wrong-secret", body);
    expect(verifySignature(secret, body, signature)).toBe(false);
  });

  it("ATTACK: a modified body does not verify against the original signature", () => {
    const signature = signPayload(secret, body);
    const tamperedBody = JSON.stringify({ event: "job.settled", data: { jobId: "job_evil" } });
    expect(verifySignature(secret, tamperedBody, signature)).toBe(false);
  });

  it("does not throw on a malformed signature of the wrong length", () => {
    expect(verifySignature(secret, body, "not-hex-and-wrong-length")).toBe(false);
  });
});
