/**
 * Subscription plans.
 *
 * Price and product identifiers are read from the environment, never
 * hard-coded: a Paddle identifier generated in one account is meaningless in
 * another, and baking one into source guarantees a sandbox id reaches
 * production eventually.
 *
 * Entitlements are computed server-side from a verified subscription. Nothing
 * a browser says about a plan is trusted.
 */

export type PlanId = "alpha" | "builder" | "pro" | "enterprise";

export type BillingPeriod = "monthly" | "yearly";

export interface PlanLimits {
  /** Maximum active agents. */
  readonly agents: number | "unlimited";
  /** Whether the REST API and API keys are available. */
  readonly developerApi: boolean;
  /** Whether live (non-testnet) settlement may be enabled. */
  readonly liveSettlement: boolean;
  /** Whether clearing analytics are available. */
  readonly clearingAnalytics: boolean;
  /** Team seats. */
  readonly seats: number | "custom";
}

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly tagline: string;
  /** Display price in USD. `null` means "contact us". */
  readonly monthlyUsd: number | null;
  readonly yearlyUsd: number | null;
  readonly features: readonly string[];
  readonly limits: PlanLimits;
  /** Paddle price ids, from configuration. Absent when not configured. */
  readonly priceIds: { readonly monthly: string | null; readonly yearly: string | null };
}

function priceId(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

export function plans(): readonly Plan[] {
  return [
    {
      id: "alpha",
      name: "Public Alpha",
      tagline: "Review the product and exercise testnet flows.",
      monthlyUsd: 0,
      yearlyUsd: 0,
      features: [
        "Full product review",
        "Up to 3 agents",
        "Testnet and μLedger flows",
        "Read-only developer access",
      ],
      limits: {
        agents: 3,
        developerApi: false,
        liveSettlement: false,
        clearingAnalytics: false,
        seats: 1,
      },
      priceIds: { monthly: null, yearly: null },
    },
    {
      id: "builder",
      name: "Builder",
      tagline: "Build agents that transact.",
      monthlyUsd: 29,
      yearlyUsd: 290,
      features: [
        "Up to 25 agents",
        "REST API and API keys",
        "Webhooks",
        "Workflow automation",
      ],
      limits: {
        agents: 25,
        developerApi: true,
        liveSettlement: false,
        clearingAnalytics: false,
        seats: 1,
      },
      priceIds: {
        monthly: priceId("PADDLE_PRICE_BUILDER_MONTHLY"),
        yearly: priceId("PADDLE_PRICE_BUILDER_YEARLY"),
      },
    },
    {
      id: "pro",
      name: "Pro",
      tagline: "Higher limits and clearing analytics.",
      monthlyUsd: 99,
      yearlyUsd: 990,
      features: [
        "Up to 250 agents",
        "Clearing and routing analytics",
        "Team seats",
        "Priority capabilities as they ship",
      ],
      limits: {
        agents: 250,
        developerApi: true,
        liveSettlement: true,
        clearingAnalytics: true,
        seats: 5,
      },
      priceIds: {
        monthly: priceId("PADDLE_PRICE_PRO_MONTHLY"),
        yearly: priceId("PADDLE_PRICE_PRO_YEARLY"),
      },
    },
    {
      id: "enterprise",
      name: "Enterprise",
      tagline: "Institutional controls and private clearing.",
      monthlyUsd: null,
      yearlyUsd: null,
      features: [
        "KYB and organization verification",
        "Negotiated limits and controls",
        "Private clearing where available",
        "Named support",
      ],
      limits: {
        agents: "unlimited",
        developerApi: true,
        liveSettlement: true,
        clearingAnalytics: true,
        seats: "custom",
      },
      priceIds: { monthly: null, yearly: null },
    },
  ];
}

export function planById(id: string): Plan | undefined {
  return plans().find((plan) => plan.id === id);
}

/** The plan an account falls back to. Never grants anything paid. */
export const DEFAULT_PLAN_ID: PlanId = "alpha";

/**
 * Whether billing is wired up.
 *
 * Without an API key and a webhook secret, checkout cannot be started and a
 * webhook cannot be verified — so the product says billing is unavailable
 * rather than rendering a checkout button that fails.
 */
export function billingConfigured(): boolean {
  return (
    Boolean(process.env.PADDLE_API_KEY?.trim()) &&
    Boolean(process.env.PADDLE_WEBHOOK_SECRET?.trim())
  );
}

export function paddleEnvironment(): "sandbox" | "production" {
  return process.env.PADDLE_ENV === "production" ? "production" : "sandbox";
}
