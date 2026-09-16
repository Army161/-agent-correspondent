/**
 * Onboarding as a state machine.
 *
 * The point of modelling this rather than storing a `step` integer is that the
 * step number and the world can disagree. A user who created an agent through
 * the API, then came back to the browser, is not on the "create your first
 * agent" step any more — and a stored counter would say otherwise.
 *
 * So progress is *derived* from facts. Some facts are observations (an agent
 * exists, the address is verified); some are recorded answers that have nowhere
 * else to live (what they are building). Either way the current step is a
 * function of the facts, which makes it resumable on any device, impossible to
 * skip by URL, and testable without a browser.
 *
 * This module decides nothing about money. `economicReadiness` reports whether
 * the prerequisites for economic actions are met; the API still enforces that
 * itself on every request.
 */

export type OnboardingStepId =
  | "VERIFY_EMAIL"
  | "ORGANIZATION"
  | "PURPOSE"
  | "PLAN"
  | "FIRST_AGENT";

/** What the system can observe or has been told. */
export interface OnboardingFacts {
  /** The address on the account has been confirmed. */
  readonly emailVerified: boolean;
  /** Whether this deployment can send verification mail at all. */
  readonly emailDeliveryConfigured: boolean;
  /** The organization has a name its owner chose, not the generated default. */
  readonly organizationNamed: boolean;
  /** The "what are you building" answer has been recorded. */
  readonly purposeRecorded: boolean;
  /** A plan has been chosen — including an explicit choice of the free tier. */
  readonly planSelected: boolean;
  /** How many agents the organization has. */
  readonly agentCount: number;
  /** When the owner explicitly dismissed the checklist, if they did. */
  readonly dismissedAt: Date | null;
}

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly title: string;
  readonly description: string;
  readonly done: boolean;
  /** A step that must be completed before the checklist counts as finished. */
  readonly required: boolean;
  /** Why this step cannot be completed right now, if it cannot. */
  readonly blockedReason: string | null;
}

export interface OnboardingState {
  readonly steps: readonly OnboardingStep[];
  /** The first incomplete step, or `null` when there is nothing left to do. */
  readonly current: OnboardingStepId | null;
  readonly completedRequired: number;
  readonly totalRequired: number;
  /** Every required step is done. */
  readonly complete: boolean;
  /** Complete, or explicitly dismissed by the owner. */
  readonly finished: boolean;
}

/**
 * Compute the current state.
 *
 * Pure: same facts in, same state out, no clock and no I/O.
 */
export function onboardingState(facts: OnboardingFacts): OnboardingState {
  const steps: OnboardingStep[] = [
    {
      id: "VERIFY_EMAIL",
      title: "Confirm your email",
      description:
        "Economic actions — mandates, intents, settlement — require a confirmed address. You can look around before confirming.",
      done: facts.emailVerified,
      required: true,
      blockedReason: facts.emailDeliveryConfigured
        ? null
        : "This deployment has no email provider configured, so a verification link cannot be sent.",
    },
    {
      id: "ORGANIZATION",
      title: "Name your organization",
      description:
        "Every agent, wallet and ledger entry belongs to one organization. Yours starts with a generated name.",
      done: facts.organizationNamed,
      required: true,
      blockedReason: null,
    },
    {
      id: "PURPOSE",
      title: "Tell us what you are building",
      description:
        "Used to pick sensible mandate defaults for your first agent. One sentence is enough.",
      done: facts.purposeRecorded,
      required: false,
      blockedReason: null,
    },
    {
      id: "PLAN",
      title: "Choose a plan",
      description:
        "Including the free tier — an explicit choice, so nobody is billed for something they did not pick.",
      done: facts.planSelected,
      required: true,
      blockedReason: null,
    },
    {
      id: "FIRST_AGENT",
      title: "Create your first agent",
      description:
        "An agent is an identity with a spending mandate. Nothing can be spent until one exists.",
      done: facts.agentCount > 0,
      required: true,
      blockedReason: null,
    },
  ];

  const required = steps.filter((step) => step.required);
  const completedRequired = required.filter((step) => step.done).length;
  const complete = completedRequired === required.length;
  const current = steps.find((step) => !step.done)?.id ?? null;

  return {
    steps,
    current,
    completedRequired,
    totalRequired: required.length,
    complete,
    finished: complete || facts.dismissedAt !== null,
  };
}

export interface EconomicReadiness {
  readonly ready: boolean;
  /** Everything standing in the way, so the UI can list it rather than hint. */
  readonly missing: readonly string[];
}

/**
 * Whether the prerequisites for an economic action are in place.
 *
 * `requireVerifiedEmail` is a deployment policy, not a user preference: it is
 * on in production. A production deployment that cannot send mail therefore
 * cannot authorize economic actions, which is the correct failure — an
 * unverifiable account is an unattributable one.
 */
export function economicReadiness(
  facts: OnboardingFacts,
  options: { readonly requireVerifiedEmail: boolean },
): EconomicReadiness {
  const missing: string[] = [];
  if (options.requireVerifiedEmail && !facts.emailVerified) {
    missing.push("a confirmed email address");
  }
  if (facts.agentCount === 0) {
    missing.push("at least one agent");
  }
  return { ready: missing.length === 0, missing };
}

/** The generated organization names onboarding treats as "not yet named". */
const GENERATED_NAMES = new Set(["my organization"]);

/**
 * Whether an organization name was chosen by a person.
 *
 * `"Ada's organization"` is generated from a display name, so it is matched by
 * shape rather than listed.
 */
export function isOrganizationNamed(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (GENERATED_NAMES.has(trimmed.toLowerCase())) return false;
  if (/^.+'s organization$/i.test(trimmed)) return false;
  return true;
}
