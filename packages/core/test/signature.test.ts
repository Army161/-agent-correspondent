/**
 * EIP-712 signature verification.
 *
 * The relay previously took a `verifySignature` callback and every caller
 * supplied `async () => true`. That made the relay's central security property —
 * that owning the relay completely still cannot cause a payment — untested and,
 * in the running product, untrue.
 *
 * These tests use real secp256k1 signatures produced by viem.
 */

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 as viemKeccak256, toBytes } from "viem";

import { compileIntent, type CompileIntentRequest } from "../src/intent/compile";
import { buildIntentTypedData, hashIntent } from "../src/intent/eip712";
import { recoverIntentSigner, verifyIntentSignature } from "../src/intent/signature";
import { unwrap } from "../src/errors/index";

const keccak256 = (bytes: Uint8Array): Uint8Array => toBytes(viemKeccak256(bytes));

const BUYER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const ATTACKER = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const NOW = new Date("2026-03-01T12:00:00.000Z");

const request: CompileIntentRequest = {
  buyerAgentId: "agent_buyer",
  providerAgentId: "agent_provider",
  service: "research.summarize",
  servicePayload: { q: 1 },
  maxSpend: "0.025",
  minReceive: "0.02",
  settlementAsset: "USDC",
  allowedRails: ["X402"],
  network: "ARC",
  destination: "0x00000000000000000000000000000000000000c1",
  evaluator: "evaluator.default.v1",
  chainId: 5042,
  verifyingContract: "0x000000000000000000000000000000000000dEaD",
  maxNetworkFee: "0.001",
  ttlSeconds: 300,
  nonce: `0x${"11".repeat(32)}`,
};

const intent = unwrap(compileIntent(request, NOW));

async function sign(account: typeof BUYER, target = intent): Promise<string> {
  const typed = unwrap(buildIntentTypedData(target, keccak256));
  return account.signTypedData({
    domain: {
      name: typed.domain.name,
      version: typed.domain.version,
      chainId: typed.domain.chainId,
      verifyingContract: typed.domain.verifyingContract as `0x${string}`,
    },
    types: { EconomicIntent: [...typed.types.EconomicIntent] },
    primaryType: "EconomicIntent",
    message: typed.message as never,
  });
}

describe("recovering the signer", () => {
  it("recovers the address that actually signed", async () => {
    const signature = await sign(BUYER);
    const recovered = await recoverIntentSigner(intent, signature, keccak256);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.toLowerCase()).toBe(BUYER.address.toLowerCase());
    }
  });

  it("accepts a signature from the declared signer", async () => {
    const signature = await sign(BUYER);
    const result = await verifyIntentSignature(intent, signature, BUYER.address, keccak256);
    expect(result.ok).toBe(true);
  });
});

describe("ATTACK: forged and mismatched signatures", () => {
  it("rejects a signature from a different key", async () => {
    const signature = await sign(ATTACKER);
    const result = await verifyIntentSignature(intent, signature, BUYER.address, keccak256);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("SIGNER_MISMATCH");
  });

  it("rejects a structurally invalid signature", async () => {
    for (const bad of ["", "0x", "0xdeadbeef", "not-hex", `0x${"00".repeat(65)}`]) {
      const result = await verifyIntentSignature(intent, bad, BUYER.address, keccak256);
      expect(result.ok, bad).toBe(false);
    }
  });

  it("rejects a signature over a different amount", async () => {
    const signature = await sign(BUYER);
    const tampered = { ...intent, maxSpend: intent.maxSpend + 1n };
    const result = await verifyIntentSignature(tampered, signature, BUYER.address, keccak256);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("SIGNER_MISMATCH");
  });

  it("rejects a signature over a different destination", async () => {
    const signature = await sign(BUYER);
    const tampered = { ...intent, destination: "0x0000000000000000000000000000000000000bad" };
    expect(
      (await verifyIntentSignature(tampered, signature, BUYER.address, keccak256)).ok,
    ).toBe(false);
  });

  it("ATTACK: a signature for one chain does not verify on another", async () => {
    const signature = await sign(BUYER);
    const otherChain = { ...intent, chainId: 1 };
    expect(
      (await verifyIntentSignature(otherChain, signature, BUYER.address, keccak256)).ok,
    ).toBe(false);
  });

  it("ATTACK: a signature for one verifying contract does not verify against another", async () => {
    const signature = await sign(BUYER);
    const otherContract = {
      ...intent,
      verifyingContract: "0x000000000000000000000000000000000000beef",
    };
    expect(
      (await verifyIntentSignature(otherContract, signature, BUYER.address, keccak256)).ok,
    ).toBe(false);
  });

  it("ATTACK: a signature does not transfer to a different nonce", async () => {
    const signature = await sign(BUYER);
    const replayed = { ...intent, nonce: `0x${"22".repeat(32)}` };
    expect(
      (await verifyIntentSignature(replayed, signature, BUYER.address, keccak256)).ok,
    ).toBe(false);
  });

  it("is case-insensitive about the declared signer address only", async () => {
    const signature = await sign(BUYER);
    const upper = BUYER.address.toUpperCase().replace("0X", "0x");
    expect((await verifyIntentSignature(intent, signature, upper, keccak256)).ok).toBe(true);
  });
});

describe("the digest a wallet signs", () => {
  it("matches the digest the kernel computes", async () => {
    const ours = unwrap(hashIntent(intent, keccak256));
    const recovered = await recoverIntentSigner(intent, await sign(BUYER), keccak256);
    expect(recovered.ok).toBe(true);
    expect(ours).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
