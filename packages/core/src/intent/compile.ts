/**
 * Compiling an intent turns a human/agent request into a signable
 * authorization, and is the last point at which anything is allowed to be
 * ambiguous.
 */

import { domainHash } from "../canonical/json";
import { sha256Hex } from "../canonical/sha256";
import { fail, ok, violation, type EconomicViolation, type Outcome } from "../errors/index";
import { newNonce } from "../ids/index";
import { amountFromAtomic, formatAmount } from "../assets/amount";
import { assetDefinition, canonicalAssetId } from "../assets/registry";
import { parseDecimalToAtomic } from "../units/decimal";
import { canonicalRails } from "./eip712";
import {
  economicIntentSchema,
  intentAssetId,
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
        `minReceive ${describeAmount(intent, intent.minReceive)} exceeds maxSpend ${describeAmount(intent, intent.maxSpend)}`,
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

  // An amount is only meaningful alongside the scale it is counted in, so an
  // intent settling in an unregistered asset is malformed rather than merely
  // unsupported.
  if (!assetDefinition(intentAssetId(intent))) {
    violations.push(
      violation(
        "UNKNOWN_ASSET",
        `intent settles in ${intent.settlementAsset} on ${intent.network}, which is not a registered asset`,
        { assetId: intentAssetId(intent) },
      ),
    );
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

/** Render an intent amount at its settlement asset's scale. */
function describeAmount(
  intent: { network: string; settlementAsset: string },
  atomic: bigint,
): string {
  const definition = assetDefinition(intentAssetId(intent));
  if (!definition) return `${atomic} (unknown scale)`;
  return formatAmount(amountFromAtomic(atomic, definition.id));
}

export interface CompileIntentRequest {
  readonly buyerAgentId: string;
  readonly providerAgentId: string;
  readonly service: string;
  /** The work request itself; hashed into `serviceHash`. */
  readonly servicePayload: unknown;
  /** Decimal string in the settlement asset, e.g. "0.025" USDC. Never dollars. */
  readonly maxSpend: string | bigint;
  readonly minReceive?: string | bigint;
  readonly settlementAsset: EconomicIntentInput["settlementAsset"];
  readonly allowedRails: EconomicIntentInput["allowedRails"];
  readonly network: EconomicIntentInput["network"];
  readonly destination: string;
  readonly evaluator: string;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly maxFxSlippageBps?: number;
  readonly maxNetworkFee?: string | bigint;
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

  // Amounts are parsed at the settlement asset's own scale. This is the point
  // at which "0.025 USDC" becomes 25000, and at which "0.025 XRP" would become
  // 25000 drops instead — the two are different quantities of different things,
  // and nothing downstream has to know which.
  const assetId = canonicalAssetId(request.network, request.settlementAsset);
  const definition = assetDefinition(assetId);
  if (!definition) {
    return fail(
      violation(
        "UNKNOWN_ASSET",
        `cannot compile an intent in ${request.settlementAsset} on ${request.network}: the asset is not registered, so its atomic scale is unknown`,
        { assetId },
      ),
    );
  }

  const amounts: Record<string, bigint> = {};
  for (const [field, value] of [
    ["maxSpend", request.maxSpend],
    ["minReceive", request.minReceive ?? "0"],
    ["maxNetworkFee", request.maxNetworkFee ?? "0"],
  ] as const) {
    const parsedAmount = parseDecimalToAtomic(value, definition.decimals, {
      allowNegative: false,
    });
    if (!parsedAmount.ok) {
      return fail(
        parsedAmount.violations.map((v) => ({ ...v, message: `${field}: ${v.message}` })),
      );
    }
    amounts[field] = parsedAmount.value;
  }

  const draft: EconomicIntentInput = {
    intentId: "intent_pending",
    version: INTENT_VERSION,
    buyerAgentId: request.buyerAgentId,
    providerAgentId: request.providerAgentId,
    service: request.service,
    serviceHash,
    maxSpend: amounts.maxSpend as bigint,
    minReceive: amounts.minReceive as bigint,
    settlementAsset: request.settlementAsset,
    allowedRails: request.allowedRails,
    maxFxSlippageBps: request.maxFxSlippageBps ?? 0,
    maxNetworkFee: amounts.maxNetworkFee as bigint,
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
    maxSpend: describeAmount(intent, intent.maxSpend),
    minReceive: describeAmount(intent, intent.minReceive),
    maxNetworkFee: describeAmount(intent, intent.maxNetworkFee),
    settlementAssetId: intentAssetId(intent),
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

/**
 * The canonical wire form of an intent.
 *
 * This is what a client signs and hands back to the relay, so every field is
 * expressed in a form JSON can carry losslessly: atomic amounts as integer
 * strings (a JSON number cannot hold a uint256) and times as ISO-8601.
 */
export function intentToWire(intent: EconomicIntent): Record<string, unknown> {
  return {
    intentId: intent.intentId,
    version: intent.version,
    buyerAgentId: intent.buyerAgentId,
    providerAgentId: intent.providerAgentId,
    service: intent.service,
    serviceHash: intent.serviceHash,
    maxSpend: intent.maxSpend.toString(10),
    minReceive: intent.minReceive.toString(10),
    settlementAsset: intent.settlementAsset,
    allowedRails: [...intent.allowedRails],
    maxFxSlippageBps: intent.maxFxSlippageBps,
    maxNetworkFee: intent.maxNetworkFee.toString(10),
    evaluator: intent.evaluator,
    deadline: new Date(intent.deadline * 1000).toISOString(),
    nonce: intent.nonce,
    createdAt: new Date(intent.createdAt * 1000).toISOString(),
    expiresAt: new Date(intent.expiresAt * 1000).toISOString(),
    chainId: intent.chainId,
    verifyingContract: intent.verifyingContract,
    destination: intent.destination,
    network: intent.network,
  };
}
