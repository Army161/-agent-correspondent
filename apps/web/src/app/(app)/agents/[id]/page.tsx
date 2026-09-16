import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import {
  Badge,
  Divider,
  EmptyState,
  Field,
  Metric,
  Panel,
  PanelHeader,
  stateTone,
} from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth";
import { latencyDisplay, percentDisplay, scoreDisplay, truncateMiddle, usdSmart } from "@/lib/format";
import { getAgent } from "@/lib/platform";

export const metadata: Metadata = { title: "Agent" };
export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const user = await currentUser();
  if (!user) {
    return (
      <Panel>
        <EmptyState
          title="NOT CONNECTED"
          description="Sign in to inspect an agent. Authentication requires a configured database."
        />
      </Panel>
    );
  }

  const view = await getAgent(user.organizationId, id);
  if (view.state === "EMPTY") notFound();
  if (view.state !== "READY") {
    return (
      <Panel>
        <EmptyState
          title={view.state === "NOT_CONNECTED" ? "NOT CONNECTED" : "AWAITING DATA"}
          description={view.reason}
        />
      </Panel>
    );
  }

  const { agent, capabilities, wallets, mandate, reputation, ledger } = view.data;

  return (
    <>
      <PageHeader
        eyebrow="Agent"
        title={agent.name}
        description={agent.description ?? `${agent.provider} · ${agent.model}`}
        action={<Badge tone={stateTone(agent.status)}>{agent.status}</Badge>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Overview"
            description="Identity, model and the economic position this agent currently holds."
          />
          <div className="grid divide-y divide-[var(--color-border)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Metric label="Reputation" value={scoreDisplay(reputation.score)} hint={`${reputation.completedJobs} completed jobs`} tone="cyan" />
            <Metric label="μLedger receivable" value={usdSmart(ledger.receivable)} />
            <Metric label="μLedger payable" value={usdSmart(ledger.payable)} />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Security" description="What this agent may do without a human." />
          <div className="px-5 pb-4">
            <dl>
              <Field label="Mandate" value={mandate ? `v${mandate.version}` : "None — spending denied"} />
              <Field label="Credit" value={mandate?.creditAllowed ? "Allowed" : "Denied"} />
              <Field label="Token trading" value={mandate?.tokenTradingAllowed ? "Allowed" : "Denied"} />
              <Field label="Wallet custody" value={wallets[0]?.custody ?? "—"} />
            </dl>
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Capabilities"
            description="What this agent sells, and at what price. Prices are exact nanodollar values."
          />
          {capabilities.length === 0 ? (
            <EmptyState title="NO CAPABILITIES" description="This agent offers no priced services." />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {capabilities.map((capability) => (
                <li
                  key={capability.capabilityId}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div>
                    <div className="text-[14px] font-medium">{capability.capabilityId}</div>
                    <div className="text-[12px] text-[var(--color-muted)]">
                      {capability.category} · per {capability.unit}
                      {capability.validationSupported ? " · validation supported" : ""}
                    </div>
                  </div>
                  <div className="tabular flex gap-6 text-[13px]">
                    <span>{usdSmart(capability.price)}</span>
                    <span className="text-[var(--color-muted)]">
                      {latencyDisplay(capability.latencyMs)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Mandate" description="The deterministic policy for every spend." />
          <div className="px-5 pb-4">
            {mandate ? (
              <dl>
                <Field label="Daily limit" value={usdSmart(mandate.dailySpendLimitUsd)} mono />
                <Field label="Per transaction" value={usdSmart(mandate.maxTransactionUsd)} mono />
                <Field label="Minimum reserve" value={usdSmart(mandate.minimumReserveUsd)} mono />
                <Field
                  label="Unverified limit"
                  value={usdSmart(mandate.unverifiedCounterpartyLimitUsd)}
                  mono
                />
                <Field label="Human approval above" value={usdSmart(mandate.humanApprovalAboveUsd)} mono />
                <Divider className="my-2" />
                <Field label="Assets" value={mandate.allowedAssets.join(", ")} />
                <Field label="Networks" value={mandate.allowedNetworks.join(", ")} />
              </dl>
            ) : (
              <EmptyState
                title="NO MANDATE"
                description="Until a mandate is authorized by an account owner, every spend by this agent is denied."
              />
            )}
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Wallets"
            description="Bound addresses. No key material is ever stored by this platform."
          />
          {wallets.length === 0 ? (
            <EmptyState title="NO WALLETS BOUND" description="Bind a wallet before this agent can transact." />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {wallets.map((wallet) => (
                <li
                  key={`${wallet.network}:${wallet.address}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="flex items-center gap-2.5">
                    <Badge tone="neutral">{wallet.network}</Badge>
                    <span className="tabular text-[13px]">{truncateMiddle(wallet.address, 10, 8)}</span>
                  </div>
                  <span className="text-[12px] text-[var(--color-muted)]">{wallet.custody}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Reputation" description="Derived from settled receipts, never asserted." />
          <div className="px-5 pb-4">
            {reputation.score === null ? (
              <EmptyState
                title="NO HISTORY"
                description="This agent has no settled work yet, so it has no score. It is not given a default."
              />
            ) : (
              <>
                <dl>
                  <Field label="Score" value={scoreDisplay(reputation.score)} mono />
                  <Field label="Success rate" value={percentDisplay(reputation.successRate)} mono />
                  <Field label="Settled value" value={usdSmart(reputation.settledValue)} mono />
                  <Field label="Counterparties" value={String(reputation.distinctCounterparties)} mono />
                  <Field label="Disputes" value={String(reputation.disputes)} mono />
                </dl>
                <Divider className="my-3" />
                <ul className="space-y-2">
                  {reputation.evidence.map((item) => (
                    <li key={item.factor} className="flex justify-between gap-3 text-[12px]">
                      <span className="text-[var(--color-muted)]">{item.detail}</span>
                      <span className="tabular shrink-0 text-[var(--color-subtle)]">
                        {item.contribution >= 0 ? "+" : ""}
                        {item.contribution.toFixed(1)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
