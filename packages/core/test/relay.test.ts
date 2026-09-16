/**
 * Intent relay tests, written as attacks.
 *
 * The relay is the most exposed component in the system: it takes signed
 * documents from anyone on the internet. Its security property is that owning
 * it completely still does not let you spend anyone's money, so these tests
 * check the *refusals*.
 */

import { describe, expect, it } from "vitest";

import { unwrap } from "../src/errors/index";
import { compileIntent, type CompileIntentRequest } from "../src/intent/compile";
import { economicMandateSchema } from "../src/mandate/schema";
import {
  createMemoryStores,
  IntentRelay,
  nonceKey,
  type ProviderState,
} from "../src/relay/index";
import { usd } from "../src/units/money";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const SIGNER = "0x1111111111111111111111111111111111111111";

const mandate = economicMandateSchema.parse({
  dailySpendLimitUsd: "10",
  maxTransactionUsd: "1",
  minimumReserveUsd: "0",
  unverifiedCounterpartyLimitUsd: "0.01",
  humanApprovalAboveUsd: "5",
  creditAllowed: false,
  tokenTradingAllowed: false,
  allowedAssets: ["USDC"],
  allowedNetworks: ["ARC"],
});

const provider: ProviderState = {
  agentId: "agent_provider",
  available: true,
  destination: "0x00000000000000000000000000000000000000c1",
  verified: true,
};

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
  destination: provider.destination,
  evaluator: "evaluator.default.v1",
  chainId: 5042,
  verifyingContract: "0x000000000000000000000000000000000000dEaD",
  maxNetworkFee: "0.001",
  ttlSeconds: 300,
};

interface Harness {
  relay: IntentRelay;
  signatureValid: { value: boolean };
  providerState: { value: ProviderState | null };
  stores: ReturnType<typeof createMemoryStores>;
}

function harness(overrides: { now?: () => Date } = {}): Harness {
  const stores = createMemoryStores();
  const signatureValid = { value: true };
  const providerState: { value: ProviderState | null } = { value: provider };

  const relay = new IntentRelay({
    nonces: stores.nonces,
    intents: stores.intents,
    verifySignature: async () => signatureValid.value,
    // The buyer agent in these fixtures is owned by SIGNER.
    authorizeSigner: async (_agentId, signer) => signer.toLowerCase() === SIGNER.toLowerCase(),
    lookupProvider: async () => providerState.value,
    loadBuyerPolicy: async () => ({
      mandate,
      context: { availableBalance: usd("100"), spentToday: 0n },
    }),
    now: overrides.now ?? (() => NOW),
  });

  return { relay, signatureValid, providerState, stores };
}

function intentWithNonce(nonce: string) {
  return unwrap(compileIntent({ ...request, nonce }, NOW));
}

const NONCE_A = `0x${"11".repeat(32)}`;
const NONCE_B = `0x${"22".repeat(32)}`;

describe("relay — valid submissions are accepted", () => {
  it("accepts a well-formed, signed, mandate-passing intent", async () => {
    const { relay } = harness();
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    expect(result.accepted).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.mandate?.decision).toBe("ALLOW");
  });

  it("stores and serves the intent it accepted", async () => {
    const { relay } = harness();
    const intent = intentWithNonce(NONCE_A);
    await relay.submit(intent, "0xsig", SIGNER);
    const stored = await relay.get(intent.intentId);
    expect(stored?.status).toBe("OPEN");
    expect(stored?.signature).toBe("0xsig");
  });
});

describe("ATTACK: replay", () => {
  it("blocks reusing a nonce for a second intent", async () => {
    const { relay } = harness();
    await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);

    // A different service, same nonce: a fresh intent id, so the id-level
    // idempotency check does not catch it — only the nonce ledger does.
    const second = unwrap(
      compileIntent({ ...request, nonce: NONCE_A, service: "research.other" }, NOW),
    );
    const result = await relay.submit(second, "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("NONCE_REUSED");
  });

  it("ATTACK: a second signer cannot claim an intent that is already stored", async () => {
    const { relay } = harness();
    const intent = intentWithNonce(NONCE_A);
    await relay.submit(intent, "0xsig", SIGNER);

    // Anyone who learns an intent id could otherwise submit it with their own
    // signature and receive an acceptance — appearing to have authorized
    // someone else's payment.
    const other = "0x9999999999999999999999999999999999999999";
    const result = await relay.submit(intent, "0xtheirs", other);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("SIGNER_MISMATCH");
  });

  it("treats a duplicate submission of the same intent as idempotent, not as a second authorization", async () => {
    const { relay, stores } = harness();
    const intent = intentWithNonce(NONCE_A);
    const first = await relay.submit(intent, "0xsig", SIGNER);
    const second = await relay.submit(intent, "0xsig", SIGNER);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect((await stores.intents.list()).length).toBe(1);
  });

  it("blocks re-submitting an intent that was already consumed", async () => {
    const { relay } = harness();
    const intent = intentWithNonce(NONCE_A);
    await relay.submit(intent, "0xsig", SIGNER);
    expect(await relay.consume(intent.intentId)).toBe(true);
    const replay = await relay.submit(intent, "0xsig", SIGNER);
    expect(replay.accepted).toBe(false);
    expect(replay.violations.map((v) => v.code)).toContain("NONCE_REUSED");
  });

  it("never releases a burned nonce, even after cancellation", async () => {
    const { relay, stores } = harness();
    const intent = intentWithNonce(NONCE_A);
    await relay.submit(intent, "0xsig", SIGNER);
    await relay.cancel(intent.intentId);
    await stores.nonces.release(nonceKey(intent, SIGNER));
    expect(await stores.nonces.isUsed(nonceKey(intent, SIGNER))).toBe(true);
  });

  it("scopes nonces per signer, chain and contract", () => {
    const intent = intentWithNonce(NONCE_A);
    const other = "0x2222222222222222222222222222222222222222";
    expect(nonceKey(intent, SIGNER)).not.toBe(nonceKey(intent, other));
    expect(nonceKey(intent, SIGNER)).not.toBe(nonceKey({ ...intent, chainId: 1 }, SIGNER));
    expect(nonceKey(intent, SIGNER)).not.toBe(
      nonceKey({ ...intent, verifyingContract: "0x000000000000000000000000000000000000beef" }, SIGNER),
    );
  });

  it("does not burn a nonce when the submission is rejected", async () => {
    const { relay, signatureValid, stores } = harness();
    signatureValid.value = false;
    const intent = intentWithNonce(NONCE_A);
    const rejected = await relay.submit(intent, "0xbad", SIGNER);
    expect(rejected.accepted).toBe(false);
    expect(await stores.nonces.isUsed(nonceKey(intent, SIGNER))).toBe(false);

    // The holder of the real signature can still use their nonce.
    signatureValid.value = true;
    const accepted = await relay.submit(intent, "0xsig", SIGNER);
    expect(accepted.accepted).toBe(true);
  });
});

describe("ATTACK: signing for an agent you do not own", () => {
  const OTHER = "0x9999999999999999999999999999999999999999";

  it("rejects a perfectly valid signature from a wallet that does not own the agent", async () => {
    const { relay } = harness();
    // The signature verifies. The signer simply has no claim on this agent's
    // money, and a relay that stopped at "the signature is valid" would let
    // anyone with a wallet authorize spending from anyone else's agent.
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", OTHER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("SIGNER_MISMATCH");
  });

  it("does not burn the nonce when the signer was not authorized", async () => {
    const { relay, stores } = harness();
    const intent = intentWithNonce(NONCE_A);
    await relay.submit(intent, "0xsig", OTHER);
    expect(await stores.nonces.isUsed(nonceKey(intent, OTHER))).toBe(false);
    expect(await stores.nonces.isUsed(nonceKey(intent, SIGNER))).toBe(false);
  });

  it("denies everything when the relay cannot establish agent ownership at all", async () => {
    const stores = createMemoryStores();
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      // No authorizeSigner. A relay that cannot tell who owns an agent has no
      // basis for accepting an authorization naming it.
      lookupProvider: async () => provider,
      loadBuyerPolicy: async () => ({
        mandate,
        context: { availableBalance: usd("100"), spentToday: 0n },
      }),
      now: () => NOW,
    });
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("SIGNER_MISMATCH");
  });

  it("refuses a cancellation from a wallet that does not own the agent", async () => {
    const { relay } = harness();
    const intent = intentWithNonce(NONCE_A);
    await relay.submit(intent, "0xsig", SIGNER);
    expect(await relay.cancel(intent.intentId, OTHER)).toBe(false);
    expect((await relay.get(intent.intentId))?.status).toBe("OPEN");
    expect(await relay.cancel(intent.intentId, SIGNER)).toBe(true);
    expect((await relay.get(intent.intentId))?.status).toBe("CANCELLED");
  });
});

describe("audit trail", () => {
  it("records both the acceptance and the refusal", async () => {
    const stores = createMemoryStores();
    const events: { action: string; outcome: string }[] = [];
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      authorizeSigner: async (_agentId, signer) => signer === SIGNER,
      lookupProvider: async () => provider,
      loadBuyerPolicy: async () => ({
        mandate,
        context: { availableBalance: usd("100"), spentToday: 0n },
      }),
      audit: async (event) => {
        events.push({ action: event.action, outcome: event.outcome });
      },
      now: () => NOW,
    });

    await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    const expensive = unwrap(compileIntent({ ...request, maxSpend: "5", nonce: NONCE_B }, NOW));
    await relay.submit(expensive, "0xsig", SIGNER);

    expect(events).toContainEqual({ action: "intent.accepted", outcome: "ALLOW" });
    expect(events).toContainEqual({ action: "intent.rejected", outcome: "DENY" });
  });

  it("does not fail a submission when the audit sink throws", async () => {
    const stores = createMemoryStores();
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      authorizeSigner: async () => true,
      lookupProvider: async () => provider,
      loadBuyerPolicy: async () => ({
        mandate,
        context: { availableBalance: usd("100"), spentToday: 0n },
      }),
      audit: async () => {
        throw new Error("audit store is down");
      },
      now: () => NOW,
    });
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    expect(result.accepted).toBe(true);
  });
});

describe("ATTACK: forged signatures and providers", () => {
  it("blocks an intent whose signature does not recover to the declared signer", async () => {
    const { relay, signatureValid } = harness();
    signatureValid.value = false;
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xforged", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("SIGNATURE_INVALID");
  });

  it("blocks an intent naming a provider that does not exist", async () => {
    const { relay, providerState } = harness();
    providerState.value = null;
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    expect(result.violations.map((v) => v.code)).toContain("PROVIDER_UNAVAILABLE");
  });

  it("blocks an intent naming a provider that is offline", async () => {
    const { relay, providerState } = harness();
    providerState.value = { ...provider, available: false };
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    expect(result.violations.map((v) => v.code)).toContain("PROVIDER_UNAVAILABLE");
  });

  it("blocks a provider that rotated its payout address after the buyer signed", async () => {
    const { relay, providerState } = harness();
    providerState.value = {
      ...provider,
      destination: "0x0000000000000000000000000000000000000bad",
    };
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("DESTINATION_SUBSTITUTION");
  });
});

describe("ATTACK: bypassing the mandate at the relay", () => {
  it("blocks an intent whose maxSpend exceeds the buyer's mandate", async () => {
    const { relay } = harness();
    const expensive = unwrap(compileIntent({ ...request, maxSpend: "5", nonce: NONCE_B }, NOW));
    const result = await relay.submit(expensive, "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("MAX_TRANSACTION_EXCEEDED");
  });

  it("blocks a buyer with no mandate on file", async () => {
    const stores = createMemoryStores();
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      authorizeSigner: async (_agentId, signer) => signer === SIGNER,
      lookupProvider: async () => provider,
      loadBuyerPolicy: async () => null,
      now: () => NOW,
    });
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("MANDATE_MISSING");
  });
});

describe("ATTACK: the intent amount is not a dollar amount", () => {
  it("blocks a USDC intent whose value exceeds the mandate, in dollars", async () => {
    const { relay } = harness();
    // 5 USDC is 5_000_000 atomic units. Read as nanodollars that would be half
    // a cent and would sail through a $1 ceiling.
    const expensive = unwrap(compileIntent({ ...request, maxSpend: "5", nonce: NONCE_B }, NOW));
    expect(expensive.maxSpend).toBe(5_000_000n);
    const result = await relay.submit(expensive, "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("MAX_TRANSACTION_EXCEEDED");
    expect(result.mandate?.valuation?.nanos).toBe(usd("5"));
  });

  it("blocks an XRP intent when the relay has no price for XRP", async () => {
    const stores = createMemoryStores();
    const xrplProvider: ProviderState = { ...provider, destination: "rProviderAccount" };
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      authorizeSigner: async (_agentId, signer) => signer === SIGNER,
      lookupProvider: async () => xrplProvider,
      loadBuyerPolicy: async () => ({
        mandate: economicMandateSchema.parse({
          dailySpendLimitUsd: "10",
          maxTransactionUsd: "1",
          minimumReserveUsd: "0",
          unverifiedCounterpartyLimitUsd: "0.01",
          humanApprovalAboveUsd: "5",
          creditAllowed: false,
          tokenTradingAllowed: false,
          allowedAssets: ["XRP"],
          allowedNetworks: ["XRPL"],
        }),
        context: { availableBalance: usd("100"), spentToday: 0n },
      }),
      now: () => NOW,
    });

    const xrpIntent = unwrap(
      compileIntent(
        {
          ...request,
          settlementAsset: "XRP",
          network: "XRPL",
          destination: "rProviderAccount",
          allowedRails: ["XRPL_PAYMENT"],
          maxSpend: "0.5",
          minReceive: "0",
          maxNetworkFee: "0",
          nonce: NONCE_A,
        },
        NOW,
      ),
    );
    // Half an XRP is 500000 drops. Nothing about that number is a dollar.
    expect(xrpIntent.maxSpend).toBe(500_000n);

    const result = await relay.submit(xrpIntent, "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("VALUATION_UNAVAILABLE");
  });

  it("accepts the same XRP intent once a fresh price makes it checkable", async () => {
    const stores = createMemoryStores();
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      authorizeSigner: async (_agentId, signer) => signer === SIGNER,
      lookupProvider: async () => ({ ...provider, destination: "rProviderAccount" }),
      loadBuyerPolicy: async () => ({
        mandate: economicMandateSchema.parse({
          dailySpendLimitUsd: "10",
          maxTransactionUsd: "1",
          minimumReserveUsd: "0",
          unverifiedCounterpartyLimitUsd: "0.01",
          humanApprovalAboveUsd: "5",
          creditAllowed: false,
          tokenTradingAllowed: false,
          allowedAssets: ["XRP"],
          allowedNetworks: ["XRPL"],
        }),
        context: { availableBalance: usd("100"), spentToday: 0n },
      }),
      // $0.50 per XRP, so half an XRP is $0.25 — inside the $1 ceiling.
      loadPriceQuote: async (assetId) => ({
        assetId,
        usdNanosPerUnit: usd("0.50"),
        asOf: NOW,
        source: "test-oracle",
      }),
      now: () => NOW,
    });

    const xrpIntent = unwrap(
      compileIntent(
        {
          ...request,
          settlementAsset: "XRP",
          network: "XRPL",
          destination: "rProviderAccount",
          allowedRails: ["XRPL_PAYMENT"],
          maxSpend: "0.5",
          minReceive: "0",
          maxNetworkFee: "0",
          nonce: NONCE_A,
        },
        NOW,
      ),
    );
    const result = await relay.submit(xrpIntent, "0xsig", SIGNER);
    expect(result.accepted).toBe(true);
    expect(result.mandate?.valuation?.nanos).toBe(usd("0.25"));
  });

  it("blocks the same XRP intent when the only price available is stale", async () => {
    const stores = createMemoryStores();
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      authorizeSigner: async (_agentId, signer) => signer === SIGNER,
      lookupProvider: async () => ({ ...provider, destination: "rProviderAccount" }),
      loadBuyerPolicy: async () => ({
        mandate: economicMandateSchema.parse({
          dailySpendLimitUsd: "10",
          maxTransactionUsd: "1",
          minimumReserveUsd: "0",
          unverifiedCounterpartyLimitUsd: "0.01",
          humanApprovalAboveUsd: "5",
          creditAllowed: false,
          tokenTradingAllowed: false,
          allowedAssets: ["XRP"],
          allowedNetworks: ["XRPL"],
        }),
        context: { availableBalance: usd("100"), spentToday: 0n },
      }),
      loadPriceQuote: async (assetId) => ({
        assetId,
        usdNanosPerUnit: usd("0.50"),
        asOf: new Date(NOW.getTime() - 86_400_000),
        source: "test-oracle",
      }),
      now: () => NOW,
    });

    const xrpIntent = unwrap(
      compileIntent(
        {
          ...request,
          settlementAsset: "XRP",
          network: "XRPL",
          destination: "rProviderAccount",
          allowedRails: ["XRPL_PAYMENT"],
          maxSpend: "0.5",
          minReceive: "0",
          maxNetworkFee: "0",
          nonce: NONCE_A,
        },
        NOW,
      ),
    );
    const result = await relay.submit(xrpIntent, "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("VALUATION_STALE");
  });
});

describe("ATTACK: expiry", () => {
  it("blocks an intent that is already expired on arrival", async () => {
    const { relay } = harness({ now: () => new Date(NOW.getTime() + 600_000) });
    const result = await relay.submit(intentWithNonce(NONCE_A), "0xsig", SIGNER);
    expect(result.accepted).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("INTENT_EXPIRED");
  });

  it("reports a stored intent as EXPIRED once its window closes", async () => {
    const stores = createMemoryStores();
    const clock = { value: NOW };
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      authorizeSigner: async (_agentId, signer) => signer === SIGNER,
      lookupProvider: async () => provider,
      loadBuyerPolicy: async () => ({
        mandate,
        context: { availableBalance: usd("100"), spentToday: 0n },
      }),
      now: () => clock.value,
    });
    const intent = intentWithNonce(NONCE_A);
    await relay.submit(intent, "0xsig", SIGNER);
    clock.value = new Date(NOW.getTime() + 600_000);
    expect((await relay.get(intent.intentId))?.status).toBe("EXPIRED");
    expect(await relay.consume(intent.intentId)).toBe(false);
  });

  it("prunes stale intents but keeps consumed ones for the record", async () => {
    const stores = createMemoryStores();
    const clock = { value: NOW };
    const relay = new IntentRelay({
      nonces: stores.nonces,
      intents: stores.intents,
      verifySignature: async () => true,
      authorizeSigner: async (_agentId, signer) => signer === SIGNER,
      lookupProvider: async () => provider,
      loadBuyerPolicy: async () => ({
        mandate,
        context: { availableBalance: usd("100"), spentToday: 0n },
      }),
      now: () => clock.value,
    });

    const stale = intentWithNonce(NONCE_A);
    const consumed = unwrap(
      compileIntent({ ...request, nonce: NONCE_B, service: "research.other" }, NOW),
    );
    await relay.submit(stale, "0xsig", SIGNER);
    await relay.submit(consumed, "0xsig", SIGNER);
    await relay.consume(consumed.intentId);

    clock.value = new Date(NOW.getTime() + 600_000);
    expect(await relay.pruneStale()).toBe(1);
    expect(await relay.get(stale.intentId)).toBeNull();
    expect((await relay.get(consumed.intentId))?.status).toBe("CONSUMED");
  });
});
