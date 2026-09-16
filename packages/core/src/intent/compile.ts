/**
 * Compiling an intent turns a human/agent request into a signable
 * authorization, and is the last point at which anything is allowed to be
 * ambiguous.
 */

import { domainHash } from "../canonical/json";
import { sha256Hex } from "../canonical/sha256";
import { fail, ok, violation, type EconomicViolation, type Outcome } from "../errors/index";
import { newNonce } from "../ids/index";
import { formatUsd } from "../units/money";
import { canonicalRails } from "./eip712";
import {
  economicIntentSchema,
  INTENT_VERSION,
  type EconomicIntent,
  type EconomicIntentInput,
} from "./schema";

/** Canonical document used for the off-chain intent hash and the audit log. */
export function canonicalIntentDocument(intent: EconomicIntent): Record<string, unknown> {
  return {
    allowedRails: canonicalRails(intent.allowedRails),
    buyerAgentId: intent.buyerAgentId,
    chainId: intent.chainId,
    createdAt: intent.createdAt,
    deadline: intent.deadline,
    destination: intent.destination,
    evaluator: intent.evaluator,
    expiresAt: intent.expiresAt,
    intentId: intent.intentId,
    maxFxSlippageBps: intent.maxFxSlippageBps,
    maxNetworkFee: intent.maxNetworkFee,
    maxSpend: intent.maxSpend,
    minReceive: intent.minReceive,
    network: intent.network,
    nonce: intent.nonce,
    providerAgentId: intent.providerAgentId,
    service: intent.service,
    serviceHash: intent.serviceHash,
    settlementAsset: intent.settlementAsset,
    version: intent.version,
    verifyingContract: intent.verifyingContract,
  };
}

export function intentHash(intent: EconomicIntent): string {
  return domainHash("intent.v1", canonicalIntentDocument(intent) as never);
}

/** Hash of the work request. Two identical requests hash identically. */
export function serviceHashOf(payload: unknown): string {
  return sha256Hex(JSON.stringify(payload ?? null));
}

export interface IntentTimingRules {
  /** Reject authorizations that live longer than this, in seconds. */
  readonly maxLifetimeSeconds: number;
  /** Reject authorizations whose window is shorter than this, in seconds. */
  readonly minLifetimeSeconds: number;
}

export const DEFAULT_TIMING: IntentTimingRules = {
  maxLifetimeSeconds: 60 * 60, // an hour is a long time for a machine
  minLifetimeSeconds: 5,
};

/**
 * Structural validation. This runs on every intent — freshly compiled, or
 * arriving at the relay from an untrusted client.
 */
export function validateIntent(
  intent: EconomicIntent,
  now: Date,
  timing: IntentTimingRules = DEFAULT_TIMING,
): Outcome<EconomicIntent> {
  const violations: EconomicViolation[] = [];
  const nowSeconds = Math.floor(now.getTime() / 1000);

  if (intent.version !== INTENT_VERSION) {
    violations.push(
      violation("INTENT_MALFORMED", `unsupported intent version ${intent.version}`, {
        version: intent.version,
      }),
    );
  }

  if (intent.expiresAt <= intent.createdAt) {
    violations.push(
      violation("INTENT_MALFORMED", "expiresAt must be after createdAt", {
        createdAt: intent.createdAt,
        expiresAt: intent.expiresAt,
      }),
    );
  }

  // The work deadline must sit inside the authorization window. A deadline
  // after expiry would let a provider deliver work that can no longer be paid
  // for under this authorization.
  if (intent.deadline > intent.expiresAt) {
    violations.push(
      violation("DEADLINE_AFTER_EXPIRY", "work deadline is after the authorization expiry", {
        deadline: intent.deadline,
        expiresAt: intent.expiresAt,
      }),
    );
  }

  if (intent.expiresAt <= nowSeconds) {
    violations.push(
      violation("INTENT_EXPIRED", "authorization has already expired", {
        expiresAt: intent.expiresAt,
        now: nowSeconds,
      }),
    );
  }

  const lifetime = intent.expiresAt - intent.createdAt;
  if (lifetime > timing.maxLifetimeSeconds) {
    violations.push(
      violation(
        "INTENT_MALFORMED",
        `authorization window of ${lifetime}s exceeds the maximum of ${timing.maxLifetimeSeconds}s`,
        { lifetime, max: timing.maxLifetimeSeconds },
      ),
    );
  }
  if (lifetime < timing.minLifetimeSeconds) {
    violations.push(
      violation(
        "INTENT_MALFORMED",
        `authorization window of ${lifetime}s is shorter than the minimum of ${timing.minLifetimeSeconds}s`,
        { lifetime, min: timing.minLifetimeSeconds },
      ),
    );
  }

  if (intent.minReceive > intent.maxSpend) {
    violations.push(
      violation(
        "INTENT_MALFORMED",
        `minReceive ${formatUsd(intent.minReceive, { symbol: true })} exceeds maxSpend ${formatUsd(intent.maxSpend, { symbol: true })}`,
        { minReceive: intent.minReceive, maxSpend: intent.maxSpend },
      ),
    );
  }

  if (intent.maxNetworkFee > intent.maxSpend) {
    violations.push(
      violation("INTENT_MALFORMED", "maxNetworkFee cannot exceed maxSpend", {
        maxNetworkFee: intent.maxNetworkFee,
        maxSpend: intent.maxSpend,
      }),
    );
  }

  if (intent.maxSpend <= 0n) {
    violations.push(violation("INVALID_AMOUNT", "maxSpend must be greater than zero"));
  }

  if (intent.buyerAgentId === intent.providerAgentId) {
    violations.push(
      violation("INTENT_MALFORMED", "buyer and provider must be different agents", {
        agentId: intent.buyerAgentId,
      }),
    );
  }

  return violations.length > 0 ? fail(violations) : ok(intent);
}

export interface CompileIntentRequest {
  readonly buyerAgentId: string;
  readonly providerAgentId: string;
  readonly service: string;
  /** The work request itself; hashed into `serviceHash`. */
  readonly servicePayload: unknown;
  readonly maxSpend: string | number | bigint;
  readonly minReceive?: string | number | bigint;
  readonly settlementAsset: EconomicIntentInput["settlementAsset"];
  readonly allowedRails: EconomicIntentInput["allowedRails"];
  readonly network: EconomicIntentInput["network"];
  readonly destination: string;
  readonly evaluator: string;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly maxFxSlippageBps?: number;
  readonly maxNetworkFee?: string | number | bigint;
  /** Seconds the authorization stays valid. */
  readonly ttlSeconds?: number;
  /** Seconds the provider has to deliver. Defaults to the full TTL. */
  readonly deadlineSeconds?: number;
  readonly nonce?: string;
}

/**
 * Compile a request into a validated, signable intent.
 *
 * The `intentId` is derived from the content, so the same request compiled
 * twice with the same nonce produces the same id — an accidental double submit
 * is one intent, not two.
 */
export function compileIntent(
  request: CompileIntentRequest,
  now: Date,
  timing: IntentTimingRules = DEFAULT_TIMING,
): Outcome<EconomicIntent> {
  const createdAt = Math.floor(now.getTime() / 1000);
  const ttl = request.ttlSeconds ?? 300;
  const expiresAt = createdAt + ttl;
  const deadline = createdAt + Math.min(request.deadlineSeconds ?? ttl, ttl);
  const nonce = request.nonce ?? newNonce();
  const serviceHash = serviceHashOf(request.servicePayload);

  const draft: EconomicIntentInput = {
    intentId: "intent_pending",
    version: INTENT_VERSION,
    buyerAgentId: request.buyerAgentId,
    providerAgentId: request.providerAgentId,
    service: request.service,
    serviceHash,
    maxSpend: request.maxSpend,
    minReceive: request.minReceive ?? 0,
    settlementAsset: request.settlementAsset,
    allowedRails: request.allowedRails,
    maxFxSlippageBps: request.maxFxSlippageBps ?? 0,
    maxNetworkFee: request.maxNetworkFee ?? 0,
    evaluator: request.evaluator,
    deadline: new Date(deadline * 1000).toISOString(),
    nonce,
    createdAt: new Date(createdAt * 1000).toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    chainId: request.chainId,
    verifyingContract: request.verifyingContract,
    destination: request.destination,
    network: request.network,
  };

  const parsed = economicIntentSchema.safeParse(draft);
  if (!parsed.success) {
    return fail(
      parsed.error.issues.map((issue) =>
        violation("INTENT_MALFORMED", `${issue.path.join(".") || "intent"}: ${issue.message}`),
      ),
    );
  }

  const withoutId = { ...parsed.data, intentId: "" };
  const derivedId = `intent_${intentHash(withoutId).slice(2, 34)}`;
  const intent: EconomicIntent = { ...parsed.data, intentId: derivedId };

  return validateIntent(intent, now, timing);
}

/** Parse an intent arriving from the wire. */
export function parseIntent(input: unknown): Outcome<EconomicIntent> {
  const parsed = economicIntentSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues.map((issue) =>
        violation("INTENT_MALFORMED", `${issue.path.join(".") || "intent"}: ${issue.message}`),
      ),
    );
  }
  return ok(parsed.data);
}

/** Display projection for chat cards and the intent inspector. */
export function describeIntent(intent: EconomicIntent): Record<string, string> {
  return {
    intentId: intent.intentId,
    service: intent.service,
    buyer: intent.buyerAgentId,
    provider: intent.providerAgentId,
    maxSpend: formatUsd(intent.maxSpend, { symbol: true }),
    minReceive: formatUsd(intent.minReceive, { symbol: true }),
    maxNetworkFee: formatUsd(intent.maxNetworkFee, { symbol: true }),
    settlementAsset: intent.settlementAsset,
    network: intent.network,
    rails: canonicalRails(intent.allowedRails),
    maxFxSlippage: `${intent.maxFxSlippageBps} bps`,
    evaluator: intent.evaluator,
    deadline: new Date(intent.deadline * 1000).toISOString(),
    expiresAt: new Date(intent.expiresAt * 1000).toISOString(),
    destination: intent.destination,
    hash: intentHash(intent),
  };
}
