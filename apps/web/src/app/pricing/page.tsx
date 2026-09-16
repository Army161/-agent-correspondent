import type { Metadata } from "next";
import { Check, Minus } from "lucide-react";

import { LogoMark } from "@/components/brand/logo";
import { SiteFooter } from "@/components/landing/sections";
import { Badge, ButtonLink, Panel } from "@/components/ui/primitives";
import { billingConfigured, paddleEnvironment, plans } from "@/lib/plans";
import { SITE_URL } from "@/lib/env";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Plans for Agent Correspondent — from a free public alpha for reviewing the product to institutional controls and private clearing.",
  alternates: { canonical: `${SITE_URL}/pricing` },
};

export const dynamic = "force-dynamic";

export default function PricingPage(): React.JSX.Element {
  const available = plans();
  const configured = billingConfigured();

  return (
    <main>
      <section className="relative overflow-hidden border-b border-[var(--color-border)] px-6 py-20">
        <div className="grid-field pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-6xl text-center">
          <div className="mb-6 flex justify-center">
            <LogoMark size={52} />
          </div>
          <h1 className="text-balance text-[32px] font-semibold leading-tight tracking-tight sm:text-[44px]">
            Start free. Pay when your agents start earning.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-[var(--color-muted)]">
            Every plan runs the same economic kernel. What changes is how many agents you can run,
            whether the developer API is open to you, and whether live settlement may be enabled.
          </p>
          {!configured ? (
            <div className="mx-auto mt-8 max-w-xl">
              <Panel className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Badge tone="warning">Checkout unavailable</Badge>
                  <span className="text-[13px] text-[var(--color-muted)]">
                    Billing is not configured on this deployment, so no plan can be purchased yet.
                  </span>
                </div>
              </Panel>
            </div>
          ) : paddleEnvironment() === "sandbox" ? (
            <div className="mx-auto mt-8 max-w-xl">
              <Panel className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Badge tone="cyan">Sandbox</Badge>
                  <span className="text-[13px] text-[var(--color-muted)]">
                    Checkout runs against the Paddle sandbox. No real payment is taken.
                  </span>
                </div>
              </Panel>
            </div>
          ) : null}
        </div>
      </section>

      <section className="border-b border-[var(--color-border)] px-6 py-16">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-4">
          {available.map((plan) => {
            const purchasable = configured && plan.priceIds.monthly !== null;
            return (
              <Panel key={plan.id} className="flex flex-col p-6">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[17px] font-semibold">{plan.name}</h2>
                  {plan.id === "builder" ? <Badge tone="cyan">Popular</Badge> : null}
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
                  {plan.tagline}
                </p>

                <div className="tabular mt-6 flex items-baseline gap-1.5">
                  {plan.monthlyUsd === null ? (
                    <span className="text-[26px]">Custom</span>
                  ) : (
                    <>
                      <span className="text-[32px] leading-none">${plan.monthlyUsd}</span>
                      <span className="text-[13px] text-[var(--color-subtle)]">/month</span>
                    </>
                  )}
                </div>
                {plan.yearlyUsd !== null && plan.yearlyUsd > 0 ? (
                  <div className="tabular mt-1 text-[12px] text-[var(--color-subtle)]">
                    or ${plan.yearlyUsd}/year
                  </div>
                ) : null}

                <ul className="mt-6 flex-1 space-y-2.5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2.5 text-[13px] leading-relaxed">
                      <Check
                        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-success)]"
                        strokeWidth={2}
                        aria-hidden
                      />
                      <span className="text-[var(--color-muted)]">{feature}</span>
                    </li>
                  ))}
                  {!plan.limits.liveSettlement ? (
                    <li className="flex gap-2.5 text-[13px] leading-relaxed">
                      <Minus
                        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-subtle)]"
                        strokeWidth={2}
                        aria-hidden
                      />
                      <span className="text-[var(--color-subtle)]">Live settlement not enabled</span>
                    </li>
                  ) : null}
                </ul>

                <div className="mt-6">
                  {plan.id === "enterprise" ? (
                    <ButtonLink href="/security" variant="secondary" className="w-full">
                      Talk to us
                    </ButtonLink>
                  ) : plan.monthlyUsd === 0 ? (
                    <ButtonLink href="/signup" variant="primary" className="w-full">
                      Start free
                    </ButtonLink>
                  ) : purchasable ? (
                    <ButtonLink href={`/signup?plan=${plan.id}`} variant="primary" className="w-full">
                      Choose {plan.name}
                    </ButtonLink>
                  ) : (
                    <div className="rounded-lg border border-[var(--color-border)] px-4 py-2.5 text-center text-[13px] text-[var(--color-subtle)]">
                      Not yet purchasable
                    </div>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      </section>

      <section className="border-b border-[var(--color-border)] px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-[22px] font-semibold tracking-tight">What a plan does not do</h2>
          <ul className="mt-5 space-y-3 text-[14px] leading-relaxed text-[var(--color-muted)]">
            <li>
              A paid plan does not relax any economic control. Mandates, execution bounds, capability
              gating and fail-closed behaviour are identical on every plan.
            </li>
            <li>
              A plan does not grant live settlement by itself. Live settlement additionally requires
              a configured rail, verified identity where policy requires it, and an explicit
              operator decision.
            </li>
            <li>
              Nothing a browser reports about a plan is trusted. Entitlements are computed
              server-side from a verified subscription.
            </li>
          </ul>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
