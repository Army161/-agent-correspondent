/**
 * Non-custodial intent relay (PRODUCT_SPEC §10).
 *
 * The relay's whole security story is what it *cannot* do. It holds no keys,
 * moves no funds, and has no authority to spend. An attacker who fully owns the
 * relay database can publish garbage intents and delete good ones — a
 * denial-of-service — but cannot make a signature appear, so cannot cause a
 * payment. Every check below exists to keep that property true.
 */

import { violation, type EconomicViolation } from "../errors/index";
import { evaluateMandate, type MandateContext, type MandateDecision } from "../mandate/engine";
import type { EconomicMandate } from "../mandate/schema";
import { intentHash, validateIntent, type IntentTimingRules } from "../intent/compile";
import type { EconomicIntent } from "../intent/schema";

export interface StoredIntent {
  readonly intent: EconomicIntent;
  readonly hash: string;
  readonly signature: string;
  readonly signer: string;
  readonly receivedAt: Date;
  readonly status: "OPEN" | "CONSUMED" | "CANCELLED" | "EXPIRED";
}

/** Nonce ledger. Implementations must make `reserve` atomic. */
export interface NonceStore {
  /**
   * Reserve `nonce` for `signer`. Returns false if it was already used.
   * The uniqueness domain is (signer, chainId, verifyingContract, nonce):
   * the same nonce on another chain is a different reservation, which is why
   * cross-chain replay is caught here as well as in the signature domain.
   */
  reserve(key: string): Promise<boolean>;
  isUsed(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface IntentStore {
  put(stored: StoredIntent): Promise<void>;
  get(intentId: string): Promise<StoredIntent | null>;
  list(filter?: { buyerAgentId?: string; providerAgentId?: string; status?: StoredIntent["status"] }): Promise<readonly StoredIntent[]>;
  updateStatus(intentId: string, status: StoredIntent["status"]): Promise<void>;
  /** Remove intents that expired before `before`. Returns how many were removed. */
  prune(before: Date): Promise<number>;
}

/** Verifies that `signature` over the intent's EIP-712 digest recovers `signer`. */
export type SignatureVerifier = (
  intent: EconomicIntent,
  signature: string,
  signer: string,
) => Promise<boolean>;

export interface ProviderState {
  readonly agentId: string;
  readonly available: boolean;
  /** Payout destination the provider currently advertises. */
  readonly destination: string;
  readonly verified: boolean;
}

export type ProviderLookup = (agentId: string) => Promise<ProviderState | null>;

export interface RelayDependencies {
  readonly nonces: NonceStore;
  readonly intents: IntentStore;
  readonly verifySignature: SignatureVerifier;
  readonly lookupProvider: ProviderLookup;
  /** Mandate + spend context for the buyer. Absent mandate means denial. */
  readonly loadBuyerPolicy: (
    agentId: string,
  ) => Promise<{ mandate: EconomicMandate | null; context: MandateContext } | null>;
  readonly timing?: IntentTimingRules;
  readonly now?: () => Date;
}

export interface SubmitResult {
  readonly accepted: boolean;
  readonly intentId: string;
  readonly hash: string;
  readonly violations: readonly EconomicViolation[];
  readonly mandate?: MandateDecision;
}

export function nonceKey(intent: EconomicIntent, signer: string): string {
  return [
    signer.toLowerCase(),
    String(intent.chainId),
    intent.verifyingContract.toLowerCase(),
    intent.nonce,
  ].join(":");
}

export class IntentRelay {
  private readonly deps: RelayDependencies;

  constructor(deps: RelayDependencies) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Accept a signed intent.
   *
   * Order matters: cheap structural checks run before signature recovery so a
   * flood of malformed submissions cannot make the relay do expensive
   * cryptography, and the nonce is only burned once everything else passed —
   * otherwise a rejected submission would permanently consume a nonce the user
   * still holds a valid signature for.
   */
  async submit(
    intent: EconomicIntent,
    signature: string,
    signer: string,
  ): Promise<SubmitResult> {
    const now = this.now();
    const hash = intentHash(intent);
    const violations: EconomicViolation[] = [];

    const structural = validateIntent(intent, now, this.deps.timing);
    if (!structural.ok) {
      return { accepted: false, intentId: intent.intentId, hash, violations: structural.violations };
    }

    // An intent id is derived from content; a duplicate submission of the same
    // id is idempotent rather than an error, but must not re-enter the pipeline.
    const existing = await this.deps.intents.get(intent.intentId);
    if (existing) {
      return {
        accepted: existing.status === "OPEN",
        intentId: intent.intentId,
        hash,
        violations:
          existing.status === "OPEN"
            ? []
            : [violation("NONCE_REUSED", `intent is already ${existing.status.toLowerCase()}`)],
      };
    }

    const key = nonceKey(intent, signer);
    if (await this.deps.nonces.isUsed(key)) {
      return {
        accepted: false,
        intentId: intent.intentId,
        hash,
        violations: [
          violation("NONCE_REUSED", "nonce has already been used by this signer on this chain", {
            nonce: intent.nonce,
            chainId: intent.chainId,
          }),
        ],
      };
    }

    const provider = await this.deps.lookupProvider(intent.providerAgentId);
    if (!provider || !provider.available) {
      violations.push(
        violation("PROVIDER_UNAVAILABLE", "provider is not currently available", {
          providerAgentId: intent.providerAgentId,
        }),
      );
    } else if (provider.destination.toLowerCase() !== intent.destination.toLowerCase()) {
      // The provider rotated its payout address after the buyer signed. The
      // relay does not "helpfully" update it: the buyer authorized a specific
      // destination and must re-sign.
      violations.push(
        violation("DESTINATION_SUBSTITUTION", "provider's payout destination has changed since signing", {
          authorized: intent.destination,
          current: provider.destination,
        }),
      );
    }

    const policy = await this.deps.loadBuyerPolicy(intent.buyerAgentId);
    let mandateDecision: MandateDecision | undefined;
    if (!policy) {
      violations.push(
        violation("MANDATE_MISSING", "buyer agent has no mandate on file", {
          buyerAgentId: intent.buyerAgentId,
        }),
      );
    } else {
      mandateDecision = evaluateMandate(
        policy.mandate,
        {
          amount: intent.maxSpend,
          asset: intent.settlementAsset,
          network: intent.network,
          counterpartyVerified: provider?.verified ?? false,
        },
        policy.context,
      );
      if (mandateDecision.decision !== "ALLOW") {
        violations.push(...mandateDecision.violations);
      }
    }

    const signatureValid = await this.deps.verifySignature(intent, signature, signer);
    if (!signatureValid) {
      violations.push(
        violation("SIGNATURE_INVALID", "signature does not recover to the declared signer", {
          signer,
        }),
      );
    }

    if (violations.length > 0) {
      return { accepted: false, intentId: intent.intentId, hash, violations, ...(mandateDecision ? { mandate: mandateDecision } : {}) };
    }

    const reserved = await this.deps.nonces.reserve(key);
    if (!reserved) {
      // Lost a race with a concurrent submission of the same nonce.
      return {
        accepted: false,
        intentId: intent.intentId,
        hash,
        violations: [violation("NONCE_REUSED", "nonce was consumed concurrently")],
      };
    }

    await this.deps.intents.put({
      intent,
      hash,
      signature,
      signer,
      receivedAt: now,
      status: "OPEN",
    });

    return {
      accepted: true,
      intentId: intent.intentId,
      hash,
      violations: [],
      ...(mandateDecision ? { mandate: mandateDecision } : {}),
    };
  }

  /** Fetch an intent, treating expiry as a live property rather than a stored one. */
  async get(intentId: string): Promise<StoredIntent | null> {
    const stored = await this.deps.intents.get(intentId);
    if (!stored) return null;
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (stored.status === "OPEN" && stored.intent.expiresAt <= nowSeconds) {
      return { ...stored, status: "EXPIRED" };
    }
    return stored;
  }

  async list(filter?: Parameters<IntentStore["list"]>[0]): Promise<readonly StoredIntent[]> {
    return this.deps.intents.list(filter);
  }

  /** Mark an intent consumed. Called once execution has been committed. */
  async consume(intentId: string): Promise<boolean> {
    const stored = await this.get(intentId);
    if (!stored || stored.status !== "OPEN") return false;
    await this.deps.intents.updateStatus(intentId, "CONSUMED");
    return true;
  }

  /** Cancel an intent. The nonce stays burned so the signature cannot be reused. */
  async cancel(intentId: string): Promise<boolean> {
    const stored = await this.get(intentId);
    if (!stored || stored.status !== "OPEN") return false;
    await this.deps.intents.updateStatus(intentId, "CANCELLED");
    return true;
  }

  /** Drop expired intents. Nonces are never released — that is the point. */
  async pruneStale(): Promise<number> {
    return this.deps.intents.prune(this.now());
  }
}

/** In-memory stores. Used by tests and by local development only. */
export function createMemoryStores(): { nonces: NonceStore; intents: IntentStore } {
  const used = new Set<string>();
  const byId = new Map<string, StoredIntent>();

  return {
    nonces: {
      async reserve(key) {
        if (used.has(key)) return false;
        used.add(key);
        return true;
      },
      async isUsed(key) {
        return used.has(key);
      },
      async release(key) {
        // Deliberately a no-op for used nonces: releasing a burned nonce would
        // re-open the replay window this store exists to close.
        void key;
      },
    },
    intents: {
      async put(stored) {
        byId.set(stored.intent.intentId, stored);
      },
      async get(intentId) {
        return byId.get(intentId) ?? null;
      },
      async list(filter) {
        return [...byId.values()].filter((stored) => {
          if (filter?.buyerAgentId && stored.intent.buyerAgentId !== filter.buyerAgentId) return false;
          if (filter?.providerAgentId && stored.intent.providerAgentId !== filter.providerAgentId) return false;
          if (filter?.status && stored.status !== filter.status) return false;
          return true;
        });
      },
      async updateStatus(intentId, status) {
        const stored = byId.get(intentId);
        if (stored) byId.set(intentId, { ...stored, status });
      },
      async prune(before) {
        const cutoff = Math.floor(before.getTime() / 1000);
        let removed = 0;
        for (const [id, stored] of byId) {
          if (stored.intent.expiresAt <= cutoff && stored.status !== "CONSUMED") {
            byId.delete(id);
            removed += 1;
          }
        }
        return removed;
      },
    },
  };
}
