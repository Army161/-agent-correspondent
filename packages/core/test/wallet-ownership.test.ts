/**
 * Proof of wallet control.
 *
 * Real secp256k1 signatures from viem, verified against the same
 * `personal_sign` digest a browser wallet produces. The properties that matter
 * are the ones an attacker would try: signing with a different key, replaying
 * someone else's proof, reusing a proof for a different agent, and smuggling a
 * newline into the message to forge the lines below it.
 */

import { describe, expect, it } from "vitest";
import { keccak256 as viemKeccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ownershipMessage,
  personalSignDigest,
  verifyOwnershipProof,
  type OwnershipChallenge,
} from "../src/wallet/ownership";
import { unwrap } from "../src/errors/index";

const keccak256 = (bytes: Uint8Array): Uint8Array => toBytes(viemKeccak256(bytes));

const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const ATTACKER = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const NOW = new Date("2026-03-01T12:00:00.000Z");

function challenge(overrides: Partial<OwnershipChallenge> = {}): OwnershipChallenge {
  return {
    domain: "agentcorrespondent.com",
    address: OWNER.address.toLowerCase(),
    statement: "Prove you control this wallet so it can be bound to your agent.",
    uri: "https://agentcorrespondent.com/wallets",
    chainId: 5042,
    nonce: "abc123def456",
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    resource: "acor:agent:agent_01",
    ...overrides,
  };
}

async function sign(
  account: typeof OWNER,
  request: OwnershipChallenge,
): Promise<string> {
  return account.signMessage({ message: unwrap(ownershipMessage(request)) });
}

describe("ownership message", () => {
  it("is deterministic and renders as a readable sign-in request", () => {
    const message = unwrap(ownershipMessage(challenge()));
    expect(message).toContain("agentcorrespondent.com wants you to sign in");
    expect(message).toContain(OWNER.address.toLowerCase());
    expect(message).toContain("Nonce: abc123def456");
    expect(message).toContain("- acor:agent:agent_01");
    expect(unwrap(ownershipMessage(challenge()))).toBe(message);
  });

  it("refuses a newline in any field", () => {
    // Without this, a domain of "evil.com\nNonce: attacker" forges the lines
    // below it and the user signs something other than what they read.
    for (const field of ["domain", "statement", "uri", "resource"] as const) {
      const result = ownershipMessage(challenge({ [field]: `x\nNonce: forged` }));
      expect(result.ok, field).toBe(false);
    }
  });

  it("refuses a nonce that is not a plain random token", () => {
    expect(ownershipMessage(challenge({ nonce: "short" })).ok).toBe(false);
    expect(ownershipMessage(challenge({ nonce: "has-a-dash-in-it" })).ok).toBe(false);
  });

  it("refuses an address that is not 20 bytes of hex", () => {
    expect(ownershipMessage(challenge({ address: "not-an-address" })).ok).toBe(false);
  });
});

describe("personal_sign digest", () => {
  it("matches what a wallet signs", async () => {
    const message = unwrap(ownershipMessage(challenge()));
    const digest = personalSignDigest(message, keccak256);
    const signature = await OWNER.signMessage({ message });
    // Round-trips through verification, which is the only meaningful check
    // that the prefix and length are right.
    const result = verifyOwnershipProof(challenge(), signature, keccak256, NOW);
    expect(result.ok).toBe(true);
    expect(digest).toHaveLength(32);
  });
});

describe("verification", () => {
  it("accepts a proof from the address being claimed", async () => {
    const signature = await sign(OWNER, challenge());
    const result = verifyOwnershipProof(challenge(), signature, keccak256, NOW);
    expect(unwrap(result)).toBe(OWNER.address.toLowerCase());
  });

  it("ATTACK: refuses a signature from a different key", async () => {
    const signature = await sign(ATTACKER, challenge());
    const result = verifyOwnershipProof(challenge(), signature, keccak256, NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.violations[0]?.code).toBe("SIGNER_MISMATCH");
  });

  it("ATTACK: refuses a proof collected for a different agent", async () => {
    const signature = await sign(OWNER, challenge({ resource: "acor:agent:agent_01" }));
    const elsewhere = challenge({ resource: "acor:agent:agent_99" });
    const result = verifyOwnershipProof(elsewhere, signature, keccak256, NOW);
    expect(result.ok).toBe(false);
  });

  it("ATTACK: refuses a proof collected for a different chain", async () => {
    const signature = await sign(OWNER, challenge({ chainId: 5042 }));
    const result = verifyOwnershipProof(challenge({ chainId: 1 }), signature, keccak256, NOW);
    expect(result.ok).toBe(false);
  });

  it("ATTACK: refuses a proof collected by a different site", async () => {
    const signature = await sign(OWNER, challenge({ domain: "evil.example" }));
    const result = verifyOwnershipProof(challenge(), signature, keccak256, NOW);
    expect(result.ok).toBe(false);
  });

  it("refuses an expired challenge", async () => {
    const request = challenge();
    const signature = await sign(OWNER, request);
    const late = new Date(request.expiresAt.getTime() + 1000);
    const result = verifyOwnershipProof(request, signature, keccak256, late);
    expect(result.ok === false && result.violations[0]?.code).toBe("CHALLENGE_EXPIRED");
  });

  it("refuses a challenge that is not valid yet", async () => {
    const request = challenge();
    const signature = await sign(OWNER, request);
    const early = new Date(request.issuedAt.getTime() - 5 * 60_000);
    const result = verifyOwnershipProof(request, signature, keccak256, early);
    expect(result.ok).toBe(false);
  });

  it("refuses a malformed signature without pretending it verified", () => {
    for (const bad of ["", "0x", "0xdeadbeef", `0x${"11".repeat(64)}`]) {
      const result = verifyOwnershipProof(challenge(), bad, keccak256, NOW);
      expect(result.ok, bad).toBe(false);
    }
  });

  it("refuses a high-s signature", async () => {
    const signature = await sign(OWNER, challenge());
    const raw = signature.slice(2);
    const r = raw.slice(0, 64);
    const s = BigInt(`0x${raw.slice(64, 128)}`);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const flipped = (n - s).toString(16).padStart(64, "0");
    const v = raw.slice(128, 130) === "1b" ? "1c" : "1b";
    const malleable = `0x${r}${flipped}${v}`;
    const result = verifyOwnershipProof(challenge(), malleable, keccak256, NOW);
    expect(result.ok).toBe(false);
  });
});
