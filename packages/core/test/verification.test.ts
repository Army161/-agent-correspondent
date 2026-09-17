import { describe, expect, it } from "vitest";

import {
  checkEvidence,
  effectiveLevel,
  meetsLevel,
  REQUIREMENTS,
  verificationGate,
  type VerificationRecord,
} from "../src/identity/verification";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function record(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    level: "INDIVIDUAL",
    status: "APPROVED",
    decidedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
    provider: "test",
    ...overrides,
  };
}

describe("levels", () => {
  it("are ordered, and each implies the ones before it", () => {
    expect(meetsLevel("BUSINESS", "INDIVIDUAL")).toBe(true);
    expect(meetsLevel("INDIVIDUAL", "BUSINESS")).toBe(false);
    expect(meetsLevel("NONE", "NONE")).toBe(true);
  });
});

describe("effective level", () => {
  it("is NONE unless the record is actually approved", () => {
    for (const status of ["NOT_STARTED", "PENDING", "IN_REVIEW", "REJECTED", "EXPIRED"] as const) {
      expect(effectiveLevel(record({ status }), NOW), status).toBe("NONE");
    }
  });

  it("is NONE once an approval has aged out, whatever the stored status says", () => {
    // The row still reads APPROVED — the provider never sent anything else —
    // but time passed, and an expired approval is not an approval.
    const stale = record({ expiresAt: new Date(NOW.getTime() - 1000) });
    expect(stale.status).toBe("APPROVED");
    expect(effectiveLevel(stale, NOW)).toBe("NONE");
  });

  it("is the recorded level while the approval is live", () => {
    expect(effectiveLevel(record({ expiresAt: new Date(NOW.getTime() + 1000) }), NOW)).toBe(
      "INDIVIDUAL",
    );
  });
});

describe("the gate", () => {
  it("allows anything that requires nothing", () => {
    expect(verificationGate(null, REQUIREMENTS.NONE, NOW).allowed).toBe(true);
  });

  it("denies when nothing is on file, and says what to do", () => {
    const decision = verificationGate(null, REQUIREMENTS.LIVE_SETTLEMENT, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe("NOT_STARTED");
    expect(decision.remedy).toMatch(/Start verification/);
  });

  it("allows a live approval at or above the required level", () => {
    expect(verificationGate(record(), REQUIREMENTS.LIVE_SETTLEMENT, NOW).allowed).toBe(true);
    expect(
      verificationGate(record({ level: "BUSINESS" }), REQUIREMENTS.LIVE_SETTLEMENT, NOW).allowed,
    ).toBe(true);
  });

  it("denies an individual approval where an entity is required", () => {
    const decision = verificationGate(record(), REQUIREMENTS.ORGANIZATION_CONTROLS, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.remedy).toMatch(/legal entity/);
  });

  it("distinguishes in-progress from rejected from expired", () => {
    expect(
      verificationGate(record({ status: "IN_REVIEW" }), REQUIREMENTS.LIVE_SETTLEMENT, NOW).remedy,
    ).toMatch(/still in progress/);
    expect(
      verificationGate(record({ status: "REJECTED" }), REQUIREMENTS.LIVE_SETTLEMENT, NOW).remedy,
    ).toMatch(/not approved/);
    expect(
      verificationGate(
        record({ expiresAt: new Date(NOW.getTime() - 1) }),
        REQUIREMENTS.LIVE_SETTLEMENT,
        NOW,
      ).remedy,
    ).toMatch(/expired/);
  });
});

describe("evidence", () => {
  it("accepts a digest", () => {
    const evidence = { provider: "test", providerReference: "ref_1", digest: "a".repeat(64) };
    expect(checkEvidence(evidence).ok).toBe(true);
  });

  it("refuses anything that is not a digest", () => {
    // The point of the check: a document pasted in by mistake is refused
    // rather than stored.
    for (const digest of ["", "short", "PASSPORT SCAN BASE64...", "a".repeat(63)]) {
      expect(
        checkEvidence({ provider: "test", providerReference: "ref_1", digest }).ok,
        digest,
      ).toBe(false);
    }
  });

  it("refuses a decision with no provider reference", () => {
    expect(
      checkEvidence({ provider: "test", providerReference: "  ", digest: "a".repeat(64) }).ok,
    ).toBe(false);
  });
});
