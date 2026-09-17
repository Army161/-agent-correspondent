/**
 * Sentinel-5 — the control plane that decides whether an economic action may
 * proceed.
 *
 * Five layers, evaluated in order, each a pure function of facts the caller
 * gathered. Any layer can deny, and the first denial stops the evaluation: a
 * request refused for having no identity should not also be told what its
 * mandate would have said.
 *
 *   1. IDENTITY       Is the caller who they say they are?
 *   2. AUTHORIZATION  Are they entitled to touch this resource at all?
 *   3. MANDATE        Is this spend inside the agent's economic policy?
 *   4. BOUNDS         Is this execution inside the authorization it claims?
 *   5. ANOMALY        Does this look like this account's normal behaviour?
 *
 * Layers 3 and 4 are the existing mandate engine and bounds checker; this
 * module does not re-implement them, it sequences them. Layer 5 is new, and is
 * the only one that can return HOLD rather than ALLOW or DENY.
 *
 * Two properties this module exists to make true:
 *
 *  - **A language model is never a layer.** Every rule here is a comparison
 *    against a stated threshold. A model can explain a decision afterwards; it
 *    cannot make one.
 *  - **Defence only.** Layer 5 detects and holds. There is no counter-attack,
 *    no probing back, nothing that reaches outside infrastructure we run.
 *    "Active defence" here means refusing, holding, and telling somebody.
 */

export type SentinelLayer =
  | "IDENTITY"
  | "AUTHORIZATION"
  | "MANDATE"
  | "BOUNDS"
  | "ANOMALY";

export const SENTINEL_LAYERS: readonly SentinelLayer[] = [
  "IDENTITY",
  "AUTHORIZATION",
  "MANDATE",
  "BOUNDS",
  "ANOMALY",
];

export type SentinelOutcome = "ALLOW" | "HOLD" | "DENY";

export interface LayerResult {
  readonly layer: SentinelLayer;
  readonly outcome: SentinelOutcome;
  /** A stable code, for metrics and for the audit log. */
  readonly code: string;
  /** One sentence for the person who hit it. */
  readonly message: string;
}

export interface SentinelDecision {
  readonly outcome: SentinelOutcome;
  /** Every layer that was evaluated, in order, including the ones that passed. */
  readonly layers: readonly LayerResult[];
  /** The layer that decided, when something other than ALLOW. */
  readonly decidedBy: SentinelLayer | null;
  readonly code: string | null;
  readonly message: string | null;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface IdentityFacts {
  /** A verified principal exists: a session, or an API key that resolved. */
  readonly authenticated: boolean;
  /** `session` or `api_key`. Recorded so a decision can be explained later. */
  readonly principalKind: string;
  /** The session authenticated recently enough for a sensitive action. */
  readonly fresh: boolean;
  /** Whether this action is one that needs freshness. */
  readonly requiresFresh: boolean;
}

export interface AuthorizationFacts {
  /** The resource belongs to the caller's organization. */
  readonly ownsResource: boolean;
  /** The plan permits this action. */
  readonly planPermits: boolean;
  /** Identity verification satisfies what this action requires. */
  readonly verified: boolean;
  /** Why verification is missing, when it is. */
  readonly verificationRemedy: string | null;
}

export interface MandateFacts {
  /** The mandate engine authorized the spend. */
  readonly authorized: boolean;
  /** The first violation code, when it did not. */
  readonly code: string | null;
  readonly message: string | null;
  /** The mandate asked for a human, rather than refusing. */
  readonly humanApprovalRequired: boolean;
}

export interface BoundsFacts {
  readonly authorized: boolean;
  readonly code: string | null;
  readonly message: string | null;
}

/**
 * What the account has been doing, as counts rather than scores.
 *
 * Every one of these is a number somebody can check against the database. A
 * model-derived "risk score" would be unauditable, and a control nobody can
 * audit is not a control.
 */
export interface AnomalyFacts {
  /** Authorizations by this agent in the last hour. */
  readonly authorizationsLastHour: number;
  /** Distinct counterparties this agent has paid in the last hour. */
  readonly distinctCounterpartiesLastHour: number;
  /** Whether this counterparty has ever been paid by this agent before. */
  readonly counterpartySeenBefore: boolean;
  /** Whether the counterparty has a registry identity. */
  readonly counterpartyVerified: boolean;
  /** Seconds since this agent's mandate was last widened. */
  readonly secondsSinceMandateWidened: number | null;
  /** Seconds since the payout wallet for this agent last changed. */
  readonly secondsSincePayoutChanged: number | null;
  /** This spend, in nanodollars. */
  readonly amountNanos: bigint;
  /** The largest single spend by this agent in the last 30 days. */
  readonly largestRecentSpendNanos: bigint | null;
}

export interface SentinelThresholds {
  /** Authorizations per hour above which an agent is held for review. */
  readonly maxAuthorizationsPerHour: number;
  /** Distinct new counterparties per hour above which it is held. */
  readonly maxDistinctCounterpartiesPerHour: number;
  /** A spend within this window of a mandate being widened is held. */
  readonly mandateWidenedCooldownSeconds: number;
  /** A spend within this window of the payout wallet changing is held. */
  readonly payoutChangedCooldownSeconds: number;
  /** A spend this many times the recent maximum is held. */
  readonly spendSpikeMultiple: number;
}

/**
 * Defaults chosen to be boring.
 *
 * Every one is a round number that an operator can argue with, which is the
 * point: a threshold nobody can explain is a threshold nobody will tune, and an
 * untuned control gets switched off the first time it is inconvenient.
 */
export const DEFAULT_THRESHOLDS: SentinelThresholds = {
  maxAuthorizationsPerHour: 60,
  maxDistinctCounterpartiesPerHour: 10,
  // Long enough that "raise the limit, then drain it" costs an hour and shows
  // up in an alert, rather than completing inside a minute.
  mandateWidenedCooldownSeconds: 60 * 60,
  payoutChangedCooldownSeconds: 60 * 60,
  spendSpikeMultiple: 10,
};

export interface SentinelRequest {
  readonly identity: IdentityFacts;
  readonly authorization: AuthorizationFacts;
  readonly mandate: MandateFacts;
  readonly bounds: BoundsFacts;
  readonly anomaly: AnomalyFacts;
}

function allow(layer: SentinelLayer, message: string): LayerResult {
  return { layer, outcome: "ALLOW", code: "OK", message };
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function identityLayer(facts: IdentityFacts): LayerResult {
  if (!facts.authenticated) {
    return {
      layer: "IDENTITY",
      outcome: "DENY",
      code: "NOT_AUTHENTICATED",
      message: "No verified principal is attached to this request.",
    };
  }
  if (facts.requiresFresh && !facts.fresh) {
    return {
      layer: "IDENTITY",
      outcome: "DENY",
      code: "STALE_SESSION",
      message: "This action needs a recent sign-in, not merely a valid session.",
    };
  }
  return allow("IDENTITY", `Authenticated as ${facts.principalKind}.`);
}

function authorizationLayer(facts: AuthorizationFacts): LayerResult {
  if (!facts.ownsResource) {
    // Deliberately the same answer a missing resource gets, so this cannot be
    // used to discover what exists in another organization.
    return {
      layer: "AUTHORIZATION",
      outcome: "DENY",
      code: "NOT_FOUND",
      message: "No such resource in this organization.",
    };
  }
  if (!facts.planPermits) {
    return {
      layer: "AUTHORIZATION",
      outcome: "DENY",
      code: "PLAN_LIMIT",
      message: "This organization's plan does not include this action.",
    };
  }
  if (!facts.verified) {
    return {
      layer: "AUTHORIZATION",
      outcome: "DENY",
      code: "VERIFICATION_REQUIRED",
      message: facts.verificationRemedy ?? "This action requires a verified identity.",
    };
  }
  return allow("AUTHORIZATION", "Entitled to this resource.");
}

function mandateLayer(facts: MandateFacts): LayerResult {
  if (facts.humanApprovalRequired) {
    return {
      layer: "MANDATE",
      outcome: "HOLD",
      code: facts.code ?? "HUMAN_APPROVAL_REQUIRED",
      message: facts.message ?? "This spend is above the mandate's approval threshold.",
    };
  }
  if (!facts.authorized) {
    return {
      layer: "MANDATE",
      outcome: "DENY",
      code: facts.code ?? "MANDATE_DENIED",
      message: facts.message ?? "The agent's mandate does not permit this spend.",
    };
  }
  return allow("MANDATE", "Within the agent's economic mandate.");
}

function boundsLayer(facts: BoundsFacts): LayerResult {
  if (!facts.authorized) {
    return {
      layer: "BOUNDS",
      outcome: "DENY",
      code: facts.code ?? "BOUNDS_EXCEEDED",
      message: facts.message ?? "This execution is outside the authorization it claims.",
    };
  }
  return allow("BOUNDS", "Inside the signed authorization's limits.");
}

/**
 * Layer 5.
 *
 * Every rule holds, rather than denies. An unusual payment is not a forbidden
 * one, and a control that blocks legitimate business gets turned off. Holding
 * puts a person in the loop, which is the actual goal.
 *
 * The rules are evaluated in order of how strongly they suggest a compromise,
 * and the first one that fires decides — a held request needs one clear reason,
 * not five.
 */
function anomalyLayer(facts: AnomalyFacts, thresholds: SentinelThresholds): LayerResult {
  // "Widen the mandate, then drain it" is the single most valuable sequence to
  // an attacker who has taken over a session, so it is checked first.
  if (
    facts.secondsSinceMandateWidened !== null &&
    facts.secondsSinceMandateWidened < thresholds.mandateWidenedCooldownSeconds
  ) {
    return {
      layer: "ANOMALY",
      outcome: "HOLD",
      code: "MANDATE_RECENTLY_WIDENED",
      message:
        "This agent's spending limits were raised in the last hour. Payments are held for review until the cooldown passes.",
    };
  }

  // "Change where the money goes, then send it" is the second.
  if (
    facts.secondsSincePayoutChanged !== null &&
    facts.secondsSincePayoutChanged < thresholds.payoutChangedCooldownSeconds
  ) {
    return {
      layer: "ANOMALY",
      outcome: "HOLD",
      code: "PAYOUT_RECENTLY_CHANGED",
      message:
        "The payout wallet for this agent changed in the last hour. Payments are held for review until the cooldown passes.",
    };
  }

  if (
    facts.largestRecentSpendNanos !== null &&
    facts.largestRecentSpendNanos > 0n &&
    facts.amountNanos >
      facts.largestRecentSpendNanos * BigInt(thresholds.spendSpikeMultiple)
  ) {
    return {
      layer: "ANOMALY",
      outcome: "HOLD",
      code: "SPEND_SPIKE",
      message: `This payment is more than ${thresholds.spendSpikeMultiple}× the largest this agent has made in the last 30 days.`,
    };
  }

  if (facts.authorizationsLastHour > thresholds.maxAuthorizationsPerHour) {
    return {
      layer: "ANOMALY",
      outcome: "HOLD",
      code: "AUTHORIZATION_VELOCITY",
      message: `This agent has authorized ${facts.authorizationsLastHour} payments in the last hour.`,
    };
  }

  if (facts.distinctCounterpartiesLastHour > thresholds.maxDistinctCounterpartiesPerHour) {
    return {
      layer: "ANOMALY",
      outcome: "HOLD",
      code: "COUNTERPARTY_FANOUT",
      message: `This agent has paid ${facts.distinctCounterpartiesLastHour} different counterparties in the last hour.`,
    };
  }

  // A first payment to an unregistered counterparty is the weakest signal here,
  // and on its own it only earns a note rather than a hold: most legitimate
  // first payments look exactly like this.
  if (!facts.counterpartySeenBefore && !facts.counterpartyVerified) {
    return {
      layer: "ANOMALY",
      outcome: "ALLOW",
      code: "NEW_UNVERIFIED_COUNTERPARTY",
      message:
        "First payment to a counterparty with no registry identity. Allowed; the mandate's unverified-counterparty limit already bounds it.",
    };
  }

  return allow("ANOMALY", "Consistent with this account's recent behaviour.");
}

/**
 * Evaluate all five layers.
 *
 * Stops at the first non-ALLOW result. A request refused for having no identity
 * should not also be told what its mandate would have said — that is a free
 * oracle for someone probing.
 */
export function evaluateSentinel(
  request: SentinelRequest,
  thresholds: SentinelThresholds = DEFAULT_THRESHOLDS,
): SentinelDecision {
  const evaluated: LayerResult[] = [];

  const steps: readonly LayerResult[] = [
    identityLayer(request.identity),
    authorizationLayer(request.authorization),
    mandateLayer(request.mandate),
    boundsLayer(request.bounds),
    anomalyLayer(request.anomaly, thresholds),
  ];

  for (const result of steps) {
    evaluated.push(result);
    if (result.outcome !== "ALLOW") {
      return {
        outcome: result.outcome,
        layers: evaluated,
        decidedBy: result.layer,
        code: result.code,
        message: result.message,
      };
    }
  }

  return {
    outcome: "ALLOW",
    layers: evaluated,
    decidedBy: null,
    code: null,
    message: null,
  };
}

/** What each layer is for, for the security page and the docs. */
export const LAYER_DESCRIPTIONS: Record<SentinelLayer, string> = {
  IDENTITY: "Establishes who is calling, and whether they authenticated recently enough.",
  AUTHORIZATION: "Establishes that they may touch this resource at all: ownership, plan, verified identity.",
  MANDATE: "Tests the spend against the agent's economic policy.",
  BOUNDS: "Tests the execution against the limits in the signature that authorized it.",
  ANOMALY: "Compares the request to this account's recent behaviour, and holds what does not fit.",
};
