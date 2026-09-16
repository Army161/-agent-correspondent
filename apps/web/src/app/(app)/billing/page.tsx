import type { Metadata } from "next";
import Link from "next/link";

import { CheckoutButton } from "@/components/billing/checkout";
import { PageHeader } from "@/components/shell/page-header";
import { Badge, Panel, PanelHeader } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth";
import { entitlementsFor } from "@/lib/billing/entitlements";
import { paddleClientToken } from "@/lib/billing/paddle";
import { billingConfigured, paddleEnvironment, plans } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Billing",
  description: "The plan this organization is on, and what it includes.",
};

export const dynamic = "force-dynamic";

export default async function BillingPage(): Promise<React.JSX.Element> {
  const user = await currentUser();

  if (!user) {
    return (
      <>
        <PageHeader eyebrow="Account" title="Billing" description="Sign in to see your plan." />
        <Panel className="p-6">
          <p className="text-[14px] text-[var(--color-muted)]">
            <Link href="/login" className="text-[var(--color-cyan)] hover:underline">
              Sign in
            </Link>{" "}
            to see which plan this organization is on.
          </p>
        </Panel>
      </>
    );
  }

  const entitlements = await entitlementsFor(user.organizationId);
  const configured = billingConfigured();
  const clientToken = paddleClientToken();
  const environment = paddleEnvironment();

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Billing"
        description="Entitlements are read from the payment provider's signed notifications. Nothing this page shows is taken from the browser."
      />

      <div className="grid gap-4">
        <Panel>
          <PanelHeader
            title="Current plan"
            description={
              entitlements.source === "subscription"
                ? "From a verified subscription."
                : entitlements.source === "unavailable"
                  ? "The subscription could not be read, so the default plan applies."
                  : "No paid subscription is on file, so the default plan applies."
            }
          />
          <div className="p-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[18px] font-semibold tracking-tight">
                {entitlements.plan.name}
              </span>
              <Badge tone={entitlements.status === "ACTIVE" ? "success" : "neutral"}>
                {entitlements.status}
              </Badge>
              {entitlements.cancelAt ? (
                <Badge tone="warning">
                  Ends {entitlements.cancelAt.toISOString().slice(0, 10)}
                </Badge>
              ) : null}
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
              {entitlements.plan.tagline}
            </p>
            <dl className="mt-4 grid gap-3 text-[13px] sm:grid-cols-2">
              <Limit label="Agents" value={String(entitlements.plan.limits.agents)} />
              <Limit label="Seats" value={String(entitlements.plan.limits.seats)} />
              <Limit
                label="Developer API"
                value={entitlements.plan.limits.developerApi ? "Included" : "Not included"}
              />
              <Limit
                label="Live settlement"
                value={entitlements.plan.limits.liveSettlement ? "Permitted" : "Not permitted"}
              />
            </dl>
            {entitlements.currentPeriodEnd ? (
              <p className="mt-4 text-[12px] text-[var(--color-subtle)]">
                Current period ends {entitlements.currentPeriodEnd.toISOString().slice(0, 10)}.
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Change plan"
            description={
              configured
                ? "Checkout is handled by Paddle. Card details never reach this service."
                : "Billing is not configured on this deployment, so no plan can be purchased here."
            }
          />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            {plans().map((plan) => {
              const current = plan.id === entitlements.plan.id;
              const priceConfigured = plan.priceIds.monthly !== null;
              return (
                <div
                  key={plan.id}
                  className={`rounded-lg border p-4 ${
                    current
                      ? "border-[rgba(0,229,255,0.5)] bg-[rgba(0,229,255,0.05)]"
                      : "border-[var(--color-border)]"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[14px] font-semibold">{plan.name}</span>
                    <span className="text-[13px] text-[var(--color-muted)]">
                      {plan.monthlyUsd === null
                        ? "Contact us"
                        : plan.monthlyUsd === 0
                          ? "Free"
                          : `$${plan.monthlyUsd}/mo`}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
                    {plan.tagline}
                  </p>
                  <ul className="mt-3 space-y-1.5">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex gap-2 text-[12px] text-[var(--color-muted)]">
                        <span
                          className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--color-cyan)]"
                          aria-hidden
                        />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4">
                    {current ? (
                      <Badge tone="cyan">Current plan</Badge>
                    ) : plan.monthlyUsd === null ? (
                      <a
                        href="mailto:sales@agentcorrespondent.com"
                        className="text-[13px] text-[var(--color-cyan)] hover:underline"
                      >
                        Talk to us
                      </a>
                    ) : plan.monthlyUsd === 0 ? (
                      <span className="text-[12px] text-[var(--color-subtle)]">
                        The plan every account falls back to.
                      </span>
                    ) : (
                      <CheckoutButton
                        planId={plan.id}
                        planName={plan.name}
                        period="monthly"
                        clientToken={clientToken}
                        environment={environment}
                        disabledReason={
                          !configured
                            ? "Billing is not configured on this deployment."
                            : !priceConfigured
                              ? `No price id is configured for ${plan.name}.`
                              : null
                        }
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel className="p-5">
          <h2 className="text-[14px] font-semibold tracking-tight">How a plan is granted</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
            Reaching a checkout success page proves that a browser reached a success page. The plan
            on this account changes only when Paddle sends a notification whose HMAC signature
            verifies against this deployment&rsquo;s webhook secret, and whose price identifier maps
            to a plan in this deployment&rsquo;s configuration. A price that maps to nothing is
            recorded and left unapplied rather than guessed at.
          </p>
        </Panel>
      </div>
    </>
  );
}

function Limit({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.1em] text-[var(--color-subtle)]">{label}</dt>
      <dd className="mt-0.5 text-[14px] text-[var(--color-bright)]">{value}</dd>
    </div>
  );
}
