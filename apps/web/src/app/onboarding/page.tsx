import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Check, Circle } from "lucide-react";

import { AppNav } from "@/components/shell/nav";
import {
  OrganizationStep,
  PlanStep,
  PurposeStep,
  VerifyEmailStep,
  type PlanChoice,
} from "@/components/onboarding/steps";
import { Badge, Panel } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth";
import { billingConfigured, plans } from "@/lib/plans";
import { onboardingFor } from "@/lib/onboarding";
import { dismissOnboardingAction } from "./actions";

export const metadata: Metadata = { title: "Get set up" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  if (!user) redirect("/login?next=%2Fonboarding");

  const view = await onboardingFor(user);
  const billing = billingConfigured();

  const choices: readonly PlanChoice[] = plans().map((plan) => {
    const needsCheckout = (plan.monthlyUsd ?? 0) > 0;
    const purchasable = !needsCheckout || (billing && plan.priceIds.monthly !== null);
    return {
      id: plan.id,
      name: plan.name,
      tagline: plan.tagline,
      monthlyUsd: plan.monthlyUsd,
      purchasable,
      unavailableReason:
        plan.monthlyUsd === null
          ? "Arranged directly."
          : purchasable
            ? null
            : "Checkout is not configured on this deployment yet.",
    };
  });

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <AppNav userEmail={user.email} />
      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-3xl px-5 py-8 sm:px-8 sm:py-10">
          <header className="mb-6">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[22px] font-semibold tracking-tight">Get set up</h1>
              <Badge tone={view.state.complete ? "success" : "cyan"}>
                {view.state.completedRequired} of {view.state.totalRequired}
              </Badge>
            </div>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[var(--color-muted)]">
              These are the prerequisites for anything economic. The list is computed from your
              account each time it loads, so finishing a step elsewhere — through the API, on
              another device — marks it done here.
            </p>
          </header>

          {view.readiness.ready ? null : (
            <Panel className="mb-6 border-[rgba(255,176,32,0.3)] bg-[rgba(255,176,32,0.05)] p-4">
              <p className="text-[13px] leading-relaxed text-[var(--color-warning)]">
                Economic actions are held until this account has {formatList(view.readiness.missing)}
                . Everything else in the product is available now.
              </p>
            </Panel>
          )}

          <ol className="space-y-3">
            {view.state.steps.map((step, index) => (
              <li key={step.id}>
                <Panel className="p-5">
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${
                        step.done
                          ? "border-[rgba(52,211,153,0.5)] bg-[rgba(52,211,153,0.12)] text-[var(--color-success)]"
                          : "border-[var(--color-border)] text-[var(--color-subtle)]"
                      }`}
                      aria-hidden
                    >
                      {step.done ? (
                        <Check className="size-3" strokeWidth={2.5} />
                      ) : (
                        <Circle className="size-2 fill-current" strokeWidth={0} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-[15px] font-semibold tracking-tight">
                          {index + 1}. {step.title}
                        </h2>
                        {step.required ? null : <Badge tone="neutral">Optional</Badge>}
                        {step.done ? <Badge tone="success">Done</Badge> : null}
                      </div>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
                        {step.description}
                      </p>
                      {step.blockedReason ? (
                        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-warning)]">
                          {step.blockedReason}
                        </p>
                      ) : null}

                      <div className="mt-4">
                        {step.id === "VERIFY_EMAIL" ? (
                          <VerifyEmailStep
                            email={user.email}
                            verified={view.facts.emailVerified}
                            deliverable={view.facts.emailDeliveryConfigured}
                          />
                        ) : null}
                        {step.id === "ORGANIZATION" ? (
                          <OrganizationStep
                            currentName={view.organizationName}
                            named={view.facts.organizationNamed}
                          />
                        ) : null}
                        {step.id === "PURPOSE" ? <PurposeStep purpose={view.purpose} /> : null}
                        {step.id === "PLAN" ? (
                          <PlanStep choices={choices} selected={view.selectedPlanId} />
                        ) : null}
                        {step.id === "FIRST_AGENT" ? (
                          <Link
                            href="/agents"
                            className="inline-flex h-8 items-center rounded-lg border border-[var(--color-border)] px-3 text-[13px] text-[var(--color-muted)] hover:border-[rgba(0,229,255,0.4)] hover:text-[var(--color-bright)]"
                          >
                            {view.facts.agentCount > 0
                              ? `${view.facts.agentCount} agent${view.facts.agentCount === 1 ? "" : "s"} — review them`
                              : "Create an agent"}
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Panel>
              </li>
            ))}
          </ol>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Link
              href="/chat"
              className="text-[13px] text-[var(--color-cyan)] hover:underline"
            >
              Go to the Agent Chat OS
            </Link>
            {view.state.complete ? null : (
              <form action={dismissOnboardingAction}>
                <button
                  type="submit"
                  className="text-[13px] text-[var(--color-subtle)] hover:text-[var(--color-muted)]"
                >
                  Hide this checklist
                </button>
              </form>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "nothing";
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] as string}`;
}
