import { describe, expect, it } from "vitest";

import {
  economicReadiness,
  isOrganizationNamed,
  onboardingState,
  type OnboardingFacts,
} from "../src/onboarding/index";

const BLANK: OnboardingFacts = {
  emailVerified: false,
  emailDeliveryConfigured: true,
  organizationNamed: false,
  purposeRecorded: false,
  planSelected: false,
  agentCount: 0,
  dismissedAt: null,
};

describe("onboarding state", () => {
  it("starts at the first step and counts only required steps", () => {
    const state = onboardingState(BLANK);
    expect(state.current).toBe("VERIFY_EMAIL");
    expect(state.completedRequired).toBe(0);
    expect(state.totalRequired).toBe(4);
    expect(state.complete).toBe(false);
    expect(state.finished).toBe(false);
  });

  it("is derived from the world, not from a stored cursor", () => {
    // An agent created through the API, with nothing else done, must not leave
    // the checklist claiming the agent step is still outstanding.
    const state = onboardingState({ ...BLANK, agentCount: 2 });
    expect(state.steps.find((step) => step.id === "FIRST_AGENT")?.done).toBe(true);
    expect(state.current).toBe("VERIFY_EMAIL");
  });

  it("completes when every required step is done, whatever the optional one says", () => {
    const state = onboardingState({
      ...BLANK,
      emailVerified: true,
      organizationNamed: true,
      planSelected: true,
      agentCount: 1,
    });
    expect(state.complete).toBe(true);
    expect(state.finished).toBe(true);
    // The optional step is still offered.
    expect(state.current).toBe("PURPOSE");
  });

  it("treats a dismissal as finished but never as complete", () => {
    const state = onboardingState({ ...BLANK, dismissedAt: new Date() });
    expect(state.finished).toBe(true);
    expect(state.complete).toBe(false);
  });

  it("says why email verification cannot be completed when mail is unconfigured", () => {
    const state = onboardingState({ ...BLANK, emailDeliveryConfigured: false });
    const step = state.steps.find((entry) => entry.id === "VERIFY_EMAIL");
    expect(step?.blockedReason).toMatch(/no email provider/i);
  });
});

describe("economic readiness", () => {
  it("denies until an agent exists", () => {
    const readiness = economicReadiness(
      { ...BLANK, emailVerified: true },
      { requireVerifiedEmail: true },
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain("at least one agent");
  });

  it("denies an unverified address when the deployment requires verification", () => {
    const readiness = economicReadiness(
      { ...BLANK, agentCount: 1 },
      { requireVerifiedEmail: true },
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain("a confirmed email address");
  });

  it("allows an unverified address only where the deployment says so", () => {
    const readiness = economicReadiness(
      { ...BLANK, agentCount: 1 },
      { requireVerifiedEmail: false },
    );
    expect(readiness.ready).toBe(true);
  });
});

describe("organization naming", () => {
  it("does not count the generated names as chosen", () => {
    expect(isOrganizationNamed("My organization")).toBe(false);
    expect(isOrganizationNamed("my ORGANIZATION")).toBe(false);
    expect(isOrganizationNamed("Ada's organization")).toBe(false);
    expect(isOrganizationNamed("   ")).toBe(false);
  });

  it("counts a real name", () => {
    expect(isOrganizationNamed("Acme Research")).toBe(true);
    // A real company whose name happens to end that way is still a real name
    // only if it does not match the generated shape; this one does not.
    expect(isOrganizationNamed("Organization of Ada")).toBe(true);
  });
});
