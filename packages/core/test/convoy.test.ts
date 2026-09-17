import { describe, expect, it } from "vitest";

import { checkConvoyPool, checkConvoyVelocity } from "../src/convoy/index";
import { unwrap } from "../src/errors/index";

describe("convoy pool", () => {
  it("allows a spend that fits inside what remains", () => {
    const result = unwrap(
      checkConvoyPool({ poolLimitNanos: 100n, spentTodayNanos: 40n, candidateNanos: 30n }),
    );
    expect(result.allowed).toBe(true);
    expect(result.remainingNanos).toBe(60n);
  });

  it("denies a spend that would exceed the pool", () => {
    const result = unwrap(
      checkConvoyPool({ poolLimitNanos: 100n, spentTodayNanos: 90n, candidateNanos: 20n }),
    );
    expect(result.allowed).toBe(false);
    expect(result.remainingNanos).toBe(10n);
  });

  it("allows exactly using up what remains", () => {
    const result = unwrap(
      checkConvoyPool({ poolLimitNanos: 100n, spentTodayNanos: 80n, candidateNanos: 20n }),
    );
    expect(result.allowed).toBe(true);
    expect(result.remainingNanos).toBe(20n);
  });

  it("treats a pool already overspent as zero remaining, not negative", () => {
    const result = unwrap(
      checkConvoyPool({ poolLimitNanos: 100n, spentTodayNanos: 150n, candidateNanos: 1n }),
    );
    expect(result.allowed).toBe(false);
    expect(result.remainingNanos).toBe(0n);
  });

  it("refuses a negative pool limit or candidate rather than guessing", () => {
    expect(checkConvoyPool({ poolLimitNanos: -1n, spentTodayNanos: 0n, candidateNanos: 1n }).ok).toBe(
      false,
    );
    expect(checkConvoyPool({ poolLimitNanos: 100n, spentTodayNanos: 0n, candidateNanos: -1n }).ok).toBe(
      false,
    );
  });
});

describe("convoy velocity", () => {
  const base = { maxAuthorizationsPerHour: 20, maxDistinctCounterpartiesPerHour: 5 };

  it("passes activity within both thresholds", () => {
    const result = checkConvoyVelocity({
      ...base,
      authorizationsLastHour: 10,
      distinctCounterpartiesLastHour: 3,
    });
    expect(result.withinLimits).toBe(true);
    expect(result.code).toBeNull();
  });

  it("catches combined velocity that no single member would trip", () => {
    // Five agents each authorizing 5/hour (well under any individual
    // threshold) sums to 25 -- over the convoy's own combined limit.
    const result = checkConvoyVelocity({
      ...base,
      authorizationsLastHour: 25,
      distinctCounterpartiesLastHour: 3,
    });
    expect(result.withinLimits).toBe(false);
    expect(result.code).toBe("CONVOY_VELOCITY");
  });

  it("catches combined counterparty fan-out", () => {
    const result = checkConvoyVelocity({
      ...base,
      authorizationsLastHour: 10,
      distinctCounterpartiesLastHour: 6,
    });
    expect(result.withinLimits).toBe(false);
    expect(result.code).toBe("CONVOY_FANOUT");
  });

  it("reports velocity before fan-out when both trip", () => {
    const result = checkConvoyVelocity({
      ...base,
      authorizationsLastHour: 999,
      distinctCounterpartiesLastHour: 999,
    });
    expect(result.code).toBe("CONVOY_VELOCITY");
  });
});
