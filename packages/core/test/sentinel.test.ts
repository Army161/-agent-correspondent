/**
 * Sentinel-5.
 *
 * The properties worth testing are the ordering (a request refused at layer 1
 * must not learn what layer 3 would have said), the hold-rather-than-deny
 * behaviour of layer 5, and the specific sequences an attacker who has taken
 * over a session would run.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_THRESHOLDS,
  evaluateSentinel,
  SENTINEL_LAYERS,
  type AnomalyFacts,
  type SentinelRequest,
} from "../src/sentinel/index";

const CLEAN_ANOMALY: AnomalyFacts = {
  authorizationsLastHour: 3,
  distinctCounterpartiesLastHour: 1,
  counterpartySeenBefore: true,
  counterpartyVerified: true,
  secondsSinceMandateWidened: null,
  secondsSincePayoutChanged: null,
  amountNanos: 1_000_000_000n,
  largestRecentSpendNanos: 5_000_000_000n,
};

function request(overrides: Partial<SentinelRequest> = {}): SentinelRequest {
  return {
    identity: {
      authenticated: true,
      principalKind: "session",
      fresh: true,
      requiresFresh: false,
    },
    authorization: {
      ownsResource: true,
      planPermits: true,
      verified: true,
      verificationRemedy: null,
    },
    mandate: { authorized: true, code: null, message: null, humanApprovalRequired: false },
    bounds: { authorized: true, code: null, message: null },
    anomaly: CLEAN_ANOMALY,
    ...overrides,
  };
}

describe("ordering", () => {
  it("allows a clean request and records every layer", () => {
    const decision = evaluateSentinel(request());
    expect(decision.outcome).toBe("ALLOW");
    expect(decision.decidedBy).toBeNull();
    expect(decision.layers.map((layer) => layer.layer)).toEqual(SENTINEL_LAYERS);
  });

  it("stops at the first denial and says nothing about later layers", () => {
    // A caller with no identity must not learn what the mandate would have
    // said: that is a free oracle for someone probing.
    const decision = evaluateSentinel(
      request({
        identity: {
          authenticated: false,
          principalKind: "none",
          fresh: false,
          requiresFresh: false,
        },
        mandate: {
          authorized: false,
          code: "DAILY_LIMIT_EXCEEDED",
          message: "secret",
          humanApprovalRequired: false,
        },
      }),
    );
    expect(decision.outcome).toBe("DENY");
    expect(decision.decidedBy).toBe("IDENTITY");
    expect(decision.layers).toHaveLength(1);
    expect(JSON.stringify(decision)).not.toContain("secret");
  });

  it("refuses a stale session for an action that needs freshness", () => {
    const decision = evaluateSentinel(
      request({
        identity: {
          authenticated: true,
          principalKind: "session",
          fresh: false,
          requiresFresh: true,
        },
      }),
    );
    expect(decision.code).toBe("STALE_SESSION");
  });
});

describe("authorization", () => {
  it("answers a foreign resource exactly as it answers a missing one", () => {
    const decision = evaluateSentinel(
      request({
        authorization: {
          ownsResource: false,
          planPermits: true,
          verified: true,
          verificationRemedy: null,
        },
      }),
    );
    // Deliberately indistinguishable from "there is no such resource", so
    // this cannot be used to discover what exists elsewhere.
    expect(decision.code).toBe("NOT_FOUND");
    expect(decision.message).toBe("No such resource in this organization.");
  });

  it("denies on plan and on verification, with the verification remedy", () => {
    expect(
      evaluateSentinel(
        request({
          authorization: {
            ownsResource: true,
            planPermits: false,
            verified: true,
            verificationRemedy: null,
          },
        }),
      ).code,
    ).toBe("PLAN_LIMIT");

    const decision = evaluateSentinel(
      request({
        authorization: {
          ownsResource: true,
          planPermits: true,
          verified: false,
          verificationRemedy: "Verify to continue.",
        },
      }),
    );
    expect(decision.code).toBe("VERIFICATION_REQUIRED");
    expect(decision.message).toBe("Verify to continue.");
  });
});

describe("mandate and bounds", () => {
  it("holds rather than denies when the mandate asks for a human", () => {
    const decision = evaluateSentinel(
      request({
        mandate: {
          authorized: false,
          code: "HUMAN_APPROVAL_REQUIRED",
          message: "Above the approval threshold.",
          humanApprovalRequired: true,
        },
      }),
    );
    expect(decision.outcome).toBe("HOLD");
    expect(decision.decidedBy).toBe("MANDATE");
  });

  it("denies a mandate violation, and never reaches bounds", () => {
    const decision = evaluateSentinel(
      request({
        mandate: {
          authorized: false,
          code: "DAILY_LIMIT_EXCEEDED",
          message: "Over the day's limit.",
          humanApprovalRequired: false,
        },
      }),
    );
    expect(decision.outcome).toBe("DENY");
    expect(decision.layers.map((layer) => layer.layer)).not.toContain("BOUNDS");
  });

  it("denies a bounds violation", () => {
    const decision = evaluateSentinel(
      request({
        bounds: { authorized: false, code: "MAX_SPEND_EXCEEDED", message: "Over maxSpend." },
      }),
    );
    expect(decision.outcome).toBe("DENY");
    expect(decision.decidedBy).toBe("BOUNDS");
  });
});

describe("anomaly", () => {
  function withAnomaly(overrides: Partial<AnomalyFacts>) {
    return evaluateSentinel(request({ anomaly: { ...CLEAN_ANOMALY, ...overrides } }));
  }

  it("holds a payment made just after the mandate was widened", () => {
    // "Raise the limit, then drain it" is the single most valuable sequence to
    // an attacker holding a stolen session.
    const decision = withAnomaly({ secondsSinceMandateWidened: 60 });
    expect(decision.outcome).toBe("HOLD");
    expect(decision.code).toBe("MANDATE_RECENTLY_WIDENED");
  });

  it("holds a payment made just after the payout wallet changed", () => {
    const decision = withAnomaly({ secondsSincePayoutChanged: 5 });
    expect(decision.outcome).toBe("HOLD");
    expect(decision.code).toBe("PAYOUT_RECENTLY_CHANGED");
  });

  it("holds a spend far larger than anything recent", () => {
    const decision = withAnomaly({
      amountNanos: 60_000_000_000n,
      largestRecentSpendNanos: 5_000_000_000n,
    });
    expect(decision.code).toBe("SPEND_SPIKE");
  });

  it("does not hold a spend on an account with no history to compare against", () => {
    // Everything is a spike relative to nothing, and holding every first
    // payment would make the control useless.
    const decision = withAnomaly({
      amountNanos: 999_000_000_000n,
      largestRecentSpendNanos: null,
    });
    expect(decision.outcome).toBe("ALLOW");
  });

  it("holds on velocity and on counterparty fan-out", () => {
    expect(
      withAnomaly({ authorizationsLastHour: DEFAULT_THRESHOLDS.maxAuthorizationsPerHour + 1 }).code,
    ).toBe("AUTHORIZATION_VELOCITY");
    expect(
      withAnomaly({
        distinctCounterpartiesLastHour: DEFAULT_THRESHOLDS.maxDistinctCounterpartiesPerHour + 1,
      }).code,
    ).toBe("COUNTERPARTY_FANOUT");
  });

  it("notes but allows a first payment to an unregistered counterparty", () => {
    // Most legitimate first payments look exactly like this, and the mandate's
    // unverified-counterparty limit already bounds them.
    const decision = withAnomaly({
      counterpartySeenBefore: false,
      counterpartyVerified: false,
    });
    expect(decision.outcome).toBe("ALLOW");
    expect(decision.layers.at(-1)?.code).toBe("NEW_UNVERIFIED_COUNTERPARTY");
  });

  it("reports the most serious reason rather than all of them", () => {
    const decision = withAnomaly({
      secondsSinceMandateWidened: 10,
      secondsSincePayoutChanged: 10,
      authorizationsLastHour: 1000,
    });
    expect(decision.code).toBe("MANDATE_RECENTLY_WIDENED");
  });

  it("never denies: layer five holds, so it cannot be the thing that blocks business", () => {
    const cases: readonly [string, Partial<AnomalyFacts>][] = [
      ["mandate widened", { secondsSinceMandateWidened: 1 }],
      ["payout changed", { secondsSincePayoutChanged: 1 }],
      ["spend spike", { amountNanos: 10_000_000_000_000n }],
      ["velocity", { authorizationsLastHour: 10_000 }],
      ["fan-out", { distinctCounterpartiesLastHour: 10_000 }],
    ];
    for (const [label, overrides] of cases) {
      expect(withAnomaly(overrides).outcome, label).not.toBe("DENY");
    }
  });
});
