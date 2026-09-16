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
import { amountFromAtomic } from "../assets/amount";
import { assetDefinition } from "../assets/registry";
import type { PriceQuote } from "../assets/valuation";
import { evaluateMandate, type MandateContext, type MandateDecision } from "../mandate/engine";
import type { EconomicMandate } from "../mandate/schema";
import { intentHash, validateIntent, type IntentTimingRules } from "../intent/compile";
import { intentAssetId, type EconomicIntent } from "../intent/schema";

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

/**
 * Verifies that `signature` over the intent's EIP-712 digest recovers `signer`.
 * Implementations come from `intent/signature.ts`; the indirection exists so the
 * kernel does not take a hard EVM dependency at this layer.
 */
export type SignatureVerifier = (
  intent: EconomicIntent,
  signature: string,
  signer: string,
) => Promise<boolean>;

/**
 * Whether `signer` is authorized to commit `buyerAgentId`'s money.
 *
 * A valid signature proves only that *someone* signed. It does not prove they
 * are allowed to spend this agent's balance — without this check, anyone with a
 * wallet could author a valid authorization naming someone else's agent as the
 * buyer, and every downstream check would pass.
 */
export type SignerAuthorization = (
  buyerAgentId: string,
  signer: string,
) => Promise<boolean>;

/** An economic decision worth keeping, including the refusals. */
export interface RelayAuditEvent {
  readonly action:
    | "intent.submitted"
    | "intent.accepted"
    | "intent.rejected"
    | "intent.consumed"
    | "intent.cancelled"
    | "intent.pruned";
  readonly intentId: string;
  readonly signer: string | null;
  readonly outcome: "ALLOW" | "DENY";
  readonly detail: Readonly<Record<string, string>>;
  readonly at: Date;
}

export type AuditSink = (event: RelayAuditEvent) => Promise<void>;

export interface ProviderState {
  readonly agentId: string;
  readonly available: boolean;
  /** Payout destination the provider currently advertises. */
  readonly destination: string;
  readonly verified: boolean;
}

/**
 * Resolve the provider's state *for this intent's network*.
 *
 * A provider's payout destination is network-specific: an Arc address on Arc, an
 * XRPL account on XRPL, and the agent id itself on the μLedger, where nothing
 * moves on a chain. Comparing a signed destination against the wrong network's
 * address would reject every legitimate authorization on the others.
 */
export type ProviderLookup = (intent: EconomicIntent) => Promise<ProviderState | null>;

export interface RelayDependencies {
  readonly nonces: NonceStore;
  readonly intents: IntentStore;
  readonly verifySignature: SignatureVerifier;
  readonly lookupProvider: ProviderLookup;
  /** Mandate + spend context for the buyer. Absent mandate means denial. */
  /**
   * The buyer's mandate and current spend context.
   *
   * Takes the whole intent rather than just the agent id, because the balance
   * that matters is the balance of the asset this intent would spend, on the
   * network it would spend it on. An agent's Arc USDC balance says nothing
   * about whether it can make an XRPL payment.
   */
  readonly loadBuyerPolicy: (
    intent: EconomicIntent,
  ) => Promise<{ mandate: EconomicMandate | null; context: MandateContext } | null>;
  /**
   * A live price for an asset with no registered USD peg.
   *
   * Absent — or returning null — means the relay cannot value such an intent,
   * and the mandate check denies it. That is the intended behaviour: an
   * unvaluable spend is an uncheckable spend.
   */
  readonly loadPriceQuote?: (assetId: string) => Promise<PriceQuote | null>;
  /**
   * Whether the recovered signer may commit the buyer agent's money.
   *
   * Omitting it denies every submission. A relay that cannot establish who owns
   * an agent cannot safely accept an authorization naming it, and defaulting to
   * "allow" would make the signature check decorative.
   */
  readonly authorizeSigner?: SignerAuthorization;
  /** Where economic decisions are recorded. Failures here never fail a request. */
  readonly audit?: AuditSink;
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

    // An intent id is derived from content, so the same buyer resubmitting the
    // same authorization is idempotent rather than an error.
    //
    // The signer is re-checked before saying so. Without that, anyone who
    // learned an intent id could submit it with their own signature and get a
    // 200 back — a way to confirm, and appear to have authorized, someone
    // else's intent.
    const existing = await this.deps.intents.get(intent.intentId);
    if (existing) {
      if (existing.signer.toLowerCase() !== signer.toLowerCase()) {
        await this.record({
          action: "intent.rejected",
          intentId: intent.intentId,
          signer,
          outcome: "DENY",
          detail: { reason: "intent already submitted by a different signer", hash },
          at: now,
        });
        return {
          accepted: false,
          intentId: intent.intentId,
          hash,
          violations: [
            violation(
              "SIGNER_MISMATCH",
              "this intent was already submitted by a different signer",
              { existingSigner: existing.signer, signer },
            ),
          ],
        };
      }
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

    const provider = await this.deps.lookupProvider(intent);
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

    const policy = await this.deps.loadBuyerPolicy(intent);
    let mandateDecision: MandateDecision | undefined;
    if (!policy) {
      violations.push(
        violation("MANDATE_MISSING", "buyer agent has no mandate on file", {
          buyerAgentId: intent.buyerAgentId,
        }),
      );
    } else {
      // The intent's maxSpend is an atomic quantity of its settlement asset,
      // not a dollar figure. It is reconstituted as an asset amount so the
      // mandate engine values it properly — treating it as dollars here is how
      // 5 USDC becomes "half a cent".
      const assetId = intentAssetId(intent);
      if (!assetDefinition(assetId)) {
        violations.push(
          violation(
            "UNKNOWN_ASSET",
            `intent settles in ${assetId}, which is not a registered asset`,
            { assetId },
          ),
        );
      } else {
        const amount = amountFromAtomic(intent.maxSpend, assetId);
        const quote = this.deps.loadPriceQuote
          ? await this.deps.loadPriceQuote(assetId)
          : null;

        mandateDecision = evaluateMandate(
          policy.mandate,
          {
            amount,
            ...(quote ? { quote } : {}),
            counterpartyVerified: provider?.verified ?? false,
          },
          { ...policy.context, now },
        );
        if (mandateDecision.decision !== "ALLOW") {
          violations.push(...mandateDecision.violations);
        }
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

    // A valid signature proves someone signed; it does not prove they may spend
    // this agent's money. Without this check anyone with a wallet could author a
    // well-formed authorization naming someone else's agent as the buyer.
    const authorized = this.deps.authorizeSigner
      ? await this.deps.authorizeSigner(intent.buyerAgentId, signer)
      : false;
    if (!authorized) {
      violations.push(
        violation(
          "SIGNER_MISMATCH",
          this.deps.authorizeSigner
            ? `signer ${signer} is not authorized to commit funds for ${intent.buyerAgentId}`
            : "this relay cannot establish agent ownership, so it accepts no authorizations",
          { signer, buyerAgentId: intent.buyerAgentId },
        ),
      );
    }

    if (violations.length > 0) {
      await this.record({
        action: "intent.rejected",
        intentId: intent.intentId,
        signer,
        outcome: "DENY",
        detail: { codes: violations.map((v) => v.code).join(","), hash },
        at: now,
      });
      return {
        accepted: false,
        intentId: intent.intentId,
        hash,
        violations,
        ...(mandateDecision ? { mandate: mandateDecision } : {}),
      };
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

    await this.record({
      action: "intent.accepted",
      intentId: intent.intentId,
      signer,
      outcome: "ALLOW",
      detail: { hash, service: intent.service, nonce: intent.nonce },
      at: now,
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
    await this.record({
      action: "intent.consumed",
      intentId,
      signer: stored.signer,
      outcome: "ALLOW",
      detail: { hash: stored.hash },
      at: this.now(),
    });
    return true;
  }

  /**
   * Cancel an intent.
   *
   * Only the agent's authorized signer may cancel, and the nonce stays burned
   * either way — releasing it would re-open the replay window the burn exists
   * to close, and the holder of the original signature could simply resubmit.
   */
  async cancel(intentId: string, requestedBy?: string): Promise<boolean> {
    const stored = await this.get(intentId);
    if (!stored || stored.status !== "OPEN") return false;

    if (requestedBy !== undefined) {
      const permitted = this.deps.authorizeSigner
        ? await this.deps.authorizeSigner(stored.intent.buyerAgentId, requestedBy)
        : false;
      if (!permitted) {
        await this.record({
          action: "intent.cancelled",
          intentId,
          signer: requestedBy,
          outcome: "DENY",
          detail: { reason: "not authorized to cancel this agent's authorization" },
          at: this.now(),
        });
        return false;
      }
    }

    await this.deps.intents.updateStatus(intentId, "CANCELLED");
    await this.record({
      action: "intent.cancelled",
      intentId,
      signer: requestedBy ?? stored.signer,
      outcome: "ALLOW",
      detail: { hash: stored.hash },
      at: this.now(),
    });
    return true;
  }

  /** Record an economic decision. An audit failure never fails the request. */
  private async record(event: RelayAuditEvent): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit(event);
    } catch {
      // The decision has already been made deterministically; losing its
      // audit line must not change the answer the caller receives.
    }
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
