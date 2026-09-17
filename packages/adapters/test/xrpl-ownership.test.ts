/**
 * Proof of XRPL account control.
 *
 * Real ed25519 and secp256k1 keypairs from `ripple-keypairs`, signing the real
 * payload. The properties worth testing are the ones an attacker would probe:
 * a stranger's key, a stranger's address with your own key, a proof moved to
 * another agent or another network, and a signature from the wrong curve —
 * which throws rather than returning false, and must not escape as a 500.
 */

import { describe, expect, it } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";

import {
  unwrap,
  xrplOwnershipMessage,
  xrplProofPayloadHex,
  XRPL_PROOF_PREFIX,
  type XrplOwnershipChallenge,
} from "@acor/core";

import { verifyXrplOwnershipProof } from "../src/xrpl-ownership";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function keys(algorithm: "ed25519" | "ecdsa-secp256k1") {
  const pair = deriveKeypair(generateSeed({ algorithm }));
  return { ...pair, address: deriveAddress(pair.publicKey) };
}

const OWNER = keys("ed25519");
const STRANGER = keys("ed25519");
const SECP = keys("ecdsa-secp256k1");

function challenge(overrides: Partial<XrplOwnershipChallenge> = {}): XrplOwnershipChallenge {
  return {
    domain: "agentcorrespondent.com",
    address: OWNER.address,
    statement: "Prove you control this account so it can be bound to your agent.",
    uri: "https://agentcorrespondent.com/wallets",
    network: "XRPL",
    nonce: "abc123def456",
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    resource: "acor:agent:agent_01",
    ...overrides,
  };
}

function proofFor(
  privateKey: string,
  request: XrplOwnershipChallenge = challenge(),
): string {
  return sign(xrplProofPayloadHex(unwrap(xrplOwnershipMessage(request))), privateKey);
}

describe("the signed payload", () => {
  it("is domain-separated from every XRPL signing prefix", () => {
    const hex = xrplProofPayloadHex("anything");
    // STX, SMT and CLM are the prefixes XRPL itself uses. Ours is none of them,
    // so this signature can never be a transaction or a claim signature.
    expect(hex.startsWith("41434F52")).toBe(true);
    expect(XRPL_PROOF_PREFIX).toBe("ACOR");
    for (const reserved of ["53545800", "534D5400", "434C4D00"]) {
      expect(hex.startsWith(reserved)).toBe(false);
    }
  });

  it("refuses a newline in any field", () => {
    for (const field of ["domain", "statement", "uri", "network", "resource"] as const) {
      expect(xrplOwnershipMessage(challenge({ [field]: "x\nNonce: forged" })).ok, field).toBe(false);
    }
  });

  it("refuses anything that is not a classic XRPL address", () => {
    for (const bad of ["0x0000000000000000000000000000000000000000", "not-an-address", "rr"]) {
      expect(xrplOwnershipMessage(challenge({ address: bad })).ok, bad).toBe(false);
    }
  });
});

describe("verification", () => {
  it("accepts an ed25519 proof from the account being claimed", () => {
    const result = verifyXrplOwnershipProof(
      challenge(),
      OWNER.publicKey,
      proofFor(OWNER.privateKey),
      NOW,
    );
    expect(unwrap(result)).toBe(OWNER.address);
  });

  it("accepts a secp256k1 proof too", () => {
    const request = challenge({ address: SECP.address });
    const result = verifyXrplOwnershipProof(
      request,
      SECP.publicKey,
      proofFor(SECP.privateKey, request),
      NOW,
    );
    expect(unwrap(result)).toBe(SECP.address);
  });

  it("ATTACK: refuses a stranger's signature over the owner's challenge", () => {
    const result = verifyXrplOwnershipProof(
      challenge(),
      STRANGER.publicKey,
      proofFor(STRANGER.privateKey),
      NOW,
    );
    // The signature is valid; it just derives to the wrong account.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.violations[0]?.code).toBe("SIGNER_MISMATCH");
  });

  it("ATTACK: refuses the owner's key presented with a stranger's address", () => {
    const result = verifyXrplOwnershipProof(
      challenge({ address: STRANGER.address }),
      OWNER.publicKey,
      proofFor(OWNER.privateKey, challenge({ address: STRANGER.address })),
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("ATTACK: refuses a proof collected for another agent", () => {
    const signature = proofFor(OWNER.privateKey, challenge({ resource: "acor:agent:agent_01" }));
    const result = verifyXrplOwnershipProof(
      challenge({ resource: "acor:agent:agent_99" }),
      OWNER.publicKey,
      signature,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("ATTACK: refuses a testnet proof presented as mainnet", () => {
    const signature = proofFor(OWNER.privateKey, challenge({ network: "XRPL_TESTNET" }));
    const result = verifyXrplOwnershipProof(
      challenge({ network: "XRPL" }),
      OWNER.publicKey,
      signature,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("ATTACK: refuses a proof collected by another site", () => {
    const signature = proofFor(OWNER.privateKey, challenge({ domain: "evil.example" }));
    const result = verifyXrplOwnershipProof(challenge(), OWNER.publicKey, signature, NOW);
    expect(result.ok).toBe(false);
  });

  it("treats a wrong-curve signature as unverified rather than throwing", () => {
    // ripple-keypairs throws while parsing an ed25519 signature as DER. That
    // must come back as a violation, not a 500.
    const result = verifyXrplOwnershipProof(
      challenge({ address: SECP.address }),
      SECP.publicKey,
      proofFor(OWNER.privateKey),
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.violations[0]?.code).toBe("SIGNATURE_INVALID");
  });

  it("refuses malformed keys and signatures", () => {
    expect(verifyXrplOwnershipProof(challenge(), "nope", "AABB", NOW).ok).toBe(false);
    expect(verifyXrplOwnershipProof(challenge(), OWNER.publicKey, "zz", NOW).ok).toBe(false);
  });

  it("refuses an expired challenge, and one from the future", () => {
    const request = challenge();
    const signature = proofFor(OWNER.privateKey, request);
    const late = new Date(request.expiresAt.getTime() + 1000);
    expect(verifyXrplOwnershipProof(request, OWNER.publicKey, signature, late).ok).toBe(false);
    const early = new Date(request.issuedAt.getTime() - 5 * 60_000);
    expect(verifyXrplOwnershipProof(request, OWNER.publicKey, signature, early).ok).toBe(false);
  });
});
