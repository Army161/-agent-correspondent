import type { Metadata } from "next";

import { PageHeader } from "@/components/shell/page-header";
import {
  Badge,
  ButtonLink,
  Code,
  EmptyState,
  Field,
  Panel,
  PanelHeader,
} from "@/components/ui/primitives";
import { DEFAULT_MANDATE } from "@acor/core";
import { currentUser } from "@/lib/auth";
import { serviceStates } from "@/lib/env";
import { providers } from "@/lib/ai/provider";

export const metadata: Metadata = {
  title: "Settings",
  description: "Organization, agent defaults, mandates and integrations.",
};

export const dynamic = "force-dynamic";

export default async function SettingsPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  const services = serviceStates();
  const modelProviders = providers();

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Organization, default mandate, model providers and integrations."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Organization" />
          <div className="px-5 pb-4">
            {user ? (
              <dl>
                <Field label="Organization" value={user.organizationName} />
                <Field label="Signed in as" value={user.email} />
                <Field label="Organization id" value={user.organizationId} mono />
              </dl>
            ) : (
              <EmptyState
                title="NOT SIGNED IN"
                description="Sign in to manage your organization. Authentication requires a configured database."
                action={
                  <ButtonLink href="/login" variant="primary" size="sm">
                    Sign in
                  </ButtonLink>
                }
              />
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Default mandate"
            description="Applied to every newly created agent. Deliberately conservative."
          />
          <div className="px-5 pb-4">
            <dl>
              <Field label="Daily limit" value={`$${DEFAULT_MANDATE.dailySpendLimitUsd}`} mono />
              <Field label="Per transaction" value={`$${DEFAULT_MANDATE.maxTransactionUsd}`} mono />
              <Field
                label="Unverified counterparty"
                value={`$${DEFAULT_MANDATE.unverifiedCounterpartyLimitUsd}`}
                mono
              />
              <Field
                label="Human approval above"
                value={`$${DEFAULT_MANDATE.humanApprovalAboveUsd}`}
                mono
              />
              <Field label="Credit" value={DEFAULT_MANDATE.creditAllowed ? "Allowed" : "Denied"} />
              <Field
                label="Token trading"
                value={DEFAULT_MANDATE.tokenTradingAllowed ? "Allowed" : "Denied"}
              />
            </dl>
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-subtle)]">
              A mandate can only be changed by a signed-in account owner. The language model can
              read a mandate but has no path to modify one.
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Model providers" description="Which model an agent runs on is configuration." />
          <ul className="divide-y divide-[var(--color-border)]">
            {modelProviders.map((provider) => (
              <li key={provider.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div>
                  <div className="text-[14px]">{provider.label}</div>
                  <div className="tabular mt-0.5 text-[12px] text-[var(--color-muted)]">
                    {provider.models.join(" · ")}
                  </div>
                </div>
                <Badge tone={provider.configured ? "success" : "neutral"}>
                  {provider.configured ? "CONFIGURED" : "MISSING KEY"}
                </Badge>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader title="Integrations" description="What this deployment is wired to." />
          <ul className="divide-y divide-[var(--color-border)]">
            {services.map((service) => (
              <li key={service.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px]">{service.label}</div>
                  {!service.configured ? (
                    <div className="mt-0.5 truncate text-[11px]">
                      <Code>{service.requires.join(", ")}</Code>
                    </div>
                  ) : null}
                </div>
                <Badge tone={service.configured ? "success" : "neutral"}>
                  {service.configured ? "CONFIGURED" : "MISSING"}
                </Badge>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
