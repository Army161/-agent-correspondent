/**
 * PQ crypto-agility.
 *
 * Real ML-DSA-65 (FIPS 204) keys and signatures from @noble/post-quantum.
 * The properties worth testing: real sign/verify round-trips, a tampered
 * message failing, a malformed input failing rather than throwing, and that
 * a secondary attestation is purely additive -- its absence is not a
 * failure.
 */

import { describe, expect, it } from "vitest";

import {
  ALGORITHMS,
  generateMlDsaKeypair,
  signMlDsa,
  verifyMlDsa,
  verifySecondaryAttestation,
} from "../src/pq/index";
import { unwrap } from "../src/errors/index";

const SEED = "07".repeat(32);
const OTHER_SEED = "09".repeat(32);

describe("the algorithm registry", () => {
  it("names an exact standard for every algorithm, never a marketing claim", () => {
    for (const info of Object.values(ALGORITHMS)) {
      expect(info.standard.length).toBeGreaterThan(0);
      // Never a "quantum-proof"-shaped word anywhere in what this reports.
      expect(info.standard.toLowerCase()).not.toMatch(/proof|guarantee/);
    }
  });

  it("only ML-DSA is marked post-quantum", () => {
    expect(ALGORITHMS["secp256k1-ecdsa"].postQuantum).toBe(false);
    expect(ALGORITHMS.ed25519.postQuantum).toBe(false);
    expect(ALGORITHMS["ml-dsa-65"].postQuantum).toBe(true);
  });
});

describe("ML-DSA keypairs and signatures", () => {
  it("round-trips a real signature", () => {
    const keys = unwrap(generateMlDsaKeypair(SEED));
    expect(keys.publicKey).toHaveLength(ALGORITHMS["ml-dsa-65"].publicKeyBytes * 2);
    expect(keys.secretKey).toHaveLength(ALGORITHMS["ml-dsa-65"].secretKeyBytes * 2);

    const message = new TextEncoder().encode("acor-cred/1\n{\"id\":\"cred_1\"}");
    const signature = unwrap(signMlDsa(message, keys.secretKey));
    expect(signature).toHaveLength(ALGORITHMS["ml-dsa-65"].signatureBytes * 2);
    expect(verifyMlDsa(message, signature, keys.publicKey)).toBe(true);
  });

  it("is deterministic given the same seed", () => {
    const a = unwrap(generateMlDsaKeypair(SEED));
    const b = unwrap(generateMlDsaKeypair(SEED));
    expect(a).toEqual(b);
  });

  it("ATTACK: refuses a signature over a tampered message", () => {
    const keys = unwrap(generateMlDsaKeypair(SEED));
    const message = new TextEncoder().encode("pay 5 USDC to agent_1");
    const signature = unwrap(signMlDsa(message, keys.secretKey));
    const tampered = new TextEncoder().encode("pay 5 USDC to agent_2");
    expect(verifyMlDsa(tampered, signature, keys.publicKey)).toBe(false);
  });

  it("ATTACK: refuses a signature verified against a different key", () => {
    const keys = unwrap(generateMlDsaKeypair(SEED));
    const otherKeys = unwrap(generateMlDsaKeypair(OTHER_SEED));
    const message = new TextEncoder().encode("hello");
    const signature = unwrap(signMlDsa(message, keys.secretKey));
    expect(verifyMlDsa(message, signature, otherKeys.publicKey)).toBe(false);
  });

  it("treats malformed input as unverified, never as a throw", () => {
    expect(verifyMlDsa(new TextEncoder().encode("x"), "zz", "aa")).toBe(false);
    expect(verifyMlDsa(new TextEncoder().encode("x"), "00".repeat(10), "00".repeat(10))).toBe(
      false,
    );
  });

  it("refuses a seed or key of the wrong length rather than guessing", () => {
    expect(generateMlDsaKeypair("aa").ok).toBe(false);
    expect(signMlDsa(new TextEncoder().encode("x"), "aa").ok).toBe(false);
  });
});

describe("secondary attestation", () => {
  const message = new TextEncoder().encode("acor-cred/1\n{...}");

  it("is purely additive: absence is not a failure", () => {
    expect(verifySecondaryAttestation(message, null)).toBe(true);
  });

  it("verifies a present, valid attestation", () => {
    const keys = unwrap(generateMlDsaKeypair(SEED));
    const signature = unwrap(signMlDsa(message, keys.secretKey));
    expect(
      verifySecondaryAttestation(message, {
        algorithm: "ml-dsa-65",
        publicKey: keys.publicKey,
        signature,
      }),
    ).toBe(true);
  });

  it("ATTACK: refuses a present but invalid attestation rather than ignoring it", () => {
    const keys = unwrap(generateMlDsaKeypair(SEED));
    const wrongMessage = new TextEncoder().encode("something else entirely");
    const signature = unwrap(signMlDsa(wrongMessage, keys.secretKey));
    expect(
      verifySecondaryAttestation(message, {
        algorithm: "ml-dsa-65",
        publicKey: keys.publicKey,
        signature,
      }),
    ).toBe(false);
  });
});
