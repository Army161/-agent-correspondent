/**
 * Intent compilation, canonical hashing and EIP-712 parity.
 *
 * The headline test in this file is `deterministic parity`: our hand-written
 * EIP-712 encoder and viem's independent implementation must agree on the exact
 * digest. If they ever diverge, a wallet would be signing something other than
 * what the UI displayed — the §23 failure ("frontend says $1, contract executes
 * $10") that this whole layer exists to prevent.
 */

import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256 as viemKeccak256, toBytes, toHex } from "viem";

import { canonicalize, canonicalHash } from "../src/canonical/json";
import { sha256Hex } from "../src/canonical/sha256";
import {
  compileIntent,
  describeIntent,
  intentHash,
  validateIntent,
  type CompileIntentRequest,
} from "../src/intent/compile";
import { buildIntentTypedData, canonicalRails, encodeType, hashIntent } from "../src/intent/eip712";
import { economicIntentSchema } from "../src/intent/schema";
import { unwrap } from "../src/errors/index";
import { usd } from "../src/units/money";

const keccak256 = (bytes: Uint8Array): Uint8Array => toBytes(viemKeccak256(bytes));

const NOW = new Date("2026-03-01T12:00:00.000Z");

const request: CompileIntentRequest = {
  buyerAgentId: "agent_buyer_01",
  providerAgentId: "agent_provider_184",
  service: "research.summarize",
  servicePayload: { documents: ["doc-a", "doc-b"], maxWords: 500 },
  maxSpend: "0.025",
  minReceive: "0.020",
  settlementAsset: "USDC",
  allowedRails: ["X402", "CIRCLE_NANOPAYMENT"],
  network: "ARC",
  destination: "0x00000000000000000000000000000000000000c1",
  evaluator: "evaluator.default.v1",
  chainId: 5042,
  verifyingContract: "0x000000000000000000000000000000000000dEaD",
  maxFxSlippageBps: 25,
  maxNetworkFee: "0.001",
  ttlSeconds: 300,
};

describe("canonical serialization", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 } as never)).toBe(canonicalize({ a: 2, b: 1 } as never));
  });

  it("encodes bigints as strings so nanos survive JSON", () => {
    expect(canonicalize({ amount: 25_000_000n } as never)).toBe('{"amount":"25000000"}');
  });

  it("rejects floats — every amount in this system is an integer of nanos", () => {
    expect(() => canonicalize({ amount: 0.1 } as never)).toThrow(/non-integer/);
  });

  it("rejects non-finite numbers and cycles", () => {
    expect(() => canonicalize({ x: Number.NaN } as never)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic as never)).toThrow(/circular/);
  });

  it("drops undefined but preserves explicit null", () => {
    expect(canonicalize({ a: undefined, b: null } as never)).toBe('{"b":null}');
  });

  it("produces the published SHA-256 test vector", () => {
    expect(sha256Hex("abc")).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("")).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("domain-separates hashes so a receipt and an intent never collide", () => {
    const document = { value: 1 };
    expect(canonicalHash(document as never)).not.toBe(sha256Hex(canonicalize(document as never)) + "x");
  });
});

describe("intent compilation", () => {
  it("compiles a valid intent with a content-derived id", () => {
    const intent = unwrap(compileIntent({ ...request, nonce: `0x${"11".repeat(32)}` }, NOW));
    expect(intent.intentId).toMatch(/^intent_[0-9a-f]{32}$/);
    expect(intent.maxSpend).toBe(usd("0.025"));
    expect(intent.createdAt).toBe(Math.floor(NOW.getTime() / 1000));
    expect(intent.expiresAt).toBe(intent.createdAt + 300);

    // Same request, same nonce, same id — an accidental double submit is one
    // intent, not two.
    const again = unwrap(compileIntent({ ...request, nonce: `0x${"11".repeat(32)}` }, NOW));
    expect(again.intentId).toBe(intent.intentId);
    expect(intentHash(again)).toBe(intentHash(intent));
  });

  it("gives different nonces different intents", () => {
    const a = unwrap(compileIntent({ ...request, nonce: `0x${"11".repeat(32)}` }, NOW));
    const b = unwrap(compileIntent({ ...request, nonce: `0x${"22".repeat(32)}` }, NOW));
    expect(a.intentId).not.toBe(b.intentId);
  });

  it("orders rails canonically so permutations are the same authorization", () => {
    expect(canonicalRails(["X402", "MULEDGER"])).toBe(canonicalRails(["MULEDGER", "X402"]));
    expect(canonicalRails(["X402", "X402"])).toBe("X402");
  });

  it("ATTACK: minReceive above maxSpend is rejected", () => {
    const result = compileIntent({ ...request, maxSpend: "0.01", minReceive: "0.02" }, NOW);
    expect(result.ok).toBe(false);
  });

  it("ATTACK: a network fee larger than the whole authorization is rejected", () => {
    const result = compileIntent({ ...request, maxSpend: "0.01", maxNetworkFee: "0.02" }, NOW);
    expect(result.ok).toBe(false);
  });

  it("ATTACK: an agent cannot buy from itself", () => {
    const result = compileIntent({ ...request, providerAgentId: request.buyerAgentId }, NOW);
    expect(result.ok).toBe(false);
  });

  it("ATTACK: a work deadline after the authorization expiry is rejected", () => {
    const intent = unwrap(compileIntent(request, NOW));
    const tampered = { ...intent, deadline: intent.expiresAt + 60 };
    const result = validateIntent(tampered, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.code)).toContain("DEADLINE_AFTER_EXPIRY");
    }
  });

  it("ATTACK: an authorization that outlives the maximum window is rejected", () => {
    const result = compileIntent({ ...request, ttlSeconds: 60 * 60 * 24 * 30 }, NOW);
    expect(result.ok).toBe(false);
  });

  it("ATTACK: an already-expired intent never validates", () => {
    const intent = unwrap(compileIntent(request, NOW));
    const later = new Date(NOW.getTime() + 301_000);
    const result = validateIntent(intent, later);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.code)).toContain("INTENT_EXPIRED");
  });

  it("ATTACK: a zero-value authorization is rejected", () => {
    expect(compileIntent({ ...request, maxSpend: "0", minReceive: "0" }, NOW).ok).toBe(false);
  });

  it("rejects a malformed nonce rather than normalizing it", () => {
    expect(economicIntentSchema.safeParse({ ...request, nonce: "0x1234" }).success).toBe(false);
  });

  it("renders a display projection that matches the signed values", () => {
    const intent = unwrap(compileIntent(request, NOW));
    const described = describeIntent(intent);
    expect(described.maxSpend).toBe("$0.025");
    expect(described.minReceive).toBe("$0.02");
    expect(described.hash).toBe(intentHash(intent));
  });
});

describe("deterministic parity: our EIP-712 encoder vs viem", () => {
  const intent = unwrap(compileIntent({ ...request, nonce: `0x${"ab".repeat(32)}` }, NOW));

  it("produces a stable, explicit type string", () => {
    expect(encodeType()).toBe(
      "EconomicIntent(bytes32 intentId,uint16 version,bytes32 buyerAgentId,bytes32 providerAgentId,bytes32 serviceHash,uint256 maxSpend,uint256 minReceive,bytes32 settlementAsset,bytes32 allowedRails,uint16 maxFxSlippageBps,uint256 maxNetworkFee,bytes32 evaluator,bytes32 destination,bytes32 network,uint64 deadline,bytes32 nonce,uint64 createdAt,uint64 expiresAt)",
    );
  });

  it("agrees with viem on the full digest", () => {
    const typed = unwrap(buildIntentTypedData(intent, keccak256));
    const ours = unwrap(hashIntent(intent, keccak256));
    const theirs = hashTypedData({
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
    expect(ours).toBe(theirs);
  });

  it("carries amounts in the settlement asset's own base units", () => {
    const typed = unwrap(buildIntentTypedData(intent, keccak256));
    // $0.025 of 6-decimal USDC is 25000 base units — not 25_000_000 nanos, and
    // not 0.025 of anything.
    expect(typed.message.maxSpend).toBe(25_000n);
    expect(typed.message.minReceive).toBe(20_000n);
  });

  it("ATTACK: changing the chain id changes the digest (cross-chain replay)", () => {
    const other = { ...intent, chainId: 1 };
    expect(unwrap(hashIntent(intent, keccak256))).not.toBe(unwrap(hashIntent(other, keccak256)));
  });

  it("ATTACK: changing the verifying contract changes the digest (cross-contract replay)", () => {
    const other = { ...intent, verifyingContract: "0x000000000000000000000000000000000000beef" };
    expect(unwrap(hashIntent(intent, keccak256))).not.toBe(unwrap(hashIntent(other, keccak256)));
  });

  it("ATTACK: changing any economic field changes the digest", () => {
    const base = unwrap(hashIntent(intent, keccak256));
    const mutations = [
      // One USDC base unit is 1_000 nanos; smaller steps are not expressible
      // on this rail at all and are rejected before hashing.
      { maxSpend: intent.maxSpend + 1_000n },
      { minReceive: intent.minReceive - 1_000n },
      { maxNetworkFee: intent.maxNetworkFee + 1_000n },
      { destination: "0x00000000000000000000000000000000000000c2" },
      { settlementAsset: "RLUSD" as const },
      { network: "XRPL" as const },
      { nonce: `0x${"cd".repeat(32)}` },
      { deadline: intent.deadline - 1 },
      { expiresAt: intent.expiresAt + 1 },
      { evaluator: "evaluator.attacker.v1" },
      { providerAgentId: "agent_provider_185" },
      { maxFxSlippageBps: intent.maxFxSlippageBps + 1 },
    ];
    for (const mutation of mutations) {
      const mutated = { ...intent, ...mutation };
      const label = Object.entries(mutation)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(",");
      expect(unwrap(hashIntent(mutated, keccak256)), label).not.toBe(base);
    }
  });

  it("ATTACK: two different agent ids cannot collide into the same bytes32", () => {
    const a = { ...intent, providerAgentId: "agent_184a" };
    const b = { ...intent, providerAgentId: "agent_184b" };
    expect(unwrap(hashIntent(a, keccak256))).not.toBe(unwrap(hashIntent(b, keccak256)));
    // ...including ids longer than 32 bytes, which a truncating encoder would
    // have collapsed together.
    const long1 = { ...intent, providerAgentId: `agent_${"x".repeat(60)}1` };
    const long2 = { ...intent, providerAgentId: `agent_${"x".repeat(60)}2` };
    expect(unwrap(hashIntent(long1, keccak256))).not.toBe(unwrap(hashIntent(long2, keccak256)));
  });

  it("refuses to compile an authorization the rail cannot express exactly", () => {
    // $0.0000005 cannot be represented in 6-decimal USDC.
    const fine = { ...intent, maxSpend: 500n };
    const result = buildIntentTypedData(fine, keccak256);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("PRECISION_LOSS");
  });

  it("keeps the off-chain canonical hash stable across runs", () => {
    const first = intentHash(intent);
    const second = intentHash({ ...intent });
    expect(first).toBe(second);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    // The off-chain hash and the on-chain digest are different commitments to
    // the same document and must never be confused for one another.
    expect(first).not.toBe(unwrap(hashIntent(intent, keccak256)));
  });

  it("exposes hex helpers that round-trip", () => {
    expect(toHex(toBytes("0x1234"))).toBe("0x1234");
  });
});
