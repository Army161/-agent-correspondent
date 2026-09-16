import type { Metadata } from "next";

import { DataState } from "@/components/shell/data-state";
import { PageHeader } from "@/components/shell/page-header";
import {
  Badge,
  EmptyState,
  Metric,
  Panel,
  PanelHeader,
  stateTone,
} from "@/components/ui/primitives";
import { probeAll } from "@acor/adapters";
import { currentUser } from "@/lib/auth";
import { AWAITING, NO_VALUATION, truncateMiddle, usdDisplay } from "@/lib/format";
import { getLedgerTotals, listWallets } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Wallets",
  description: "Agent wallets, live balances, escrow and μLedger positions.",
};

export const dynamic = "force-dynamic";

export default async function WalletsPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  const [wallets, totals, adapters] = await Promise.all([
    user
      ? listWallets(user.organizationId)
      : Promise.resolve({ state: "NOT_CONNECTED", reason: "Sign in to see wallets." } as const),
    user
      ? getLedgerTotals(user.organizationId)
      : Promise.resolve({ state: "NOT_CONNECTED", reason: "Sign in to see balances." } as const),
    probeAll(),
  ]);

  const anyRailReady = adapters.some((adapter) => adapter.status === "READY");

  return (
    <>
      <PageHeader
        eyebrow="Settlement plane"
        title="Wallets"
        description="Balances are read live from the configured rails. Where a rail is not configured, this page says so — it never shows a placeholder balance."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-3">
          <PanelHeader
            title="Balances"
            description={
              anyRailReady
                ? "Read from the configured settlement adapters."
                : "No settlement rail is configured, so no on-chain balance can be read."
            }
          />
          <div className="grid divide-y divide-[var(--color-border)] sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
            <Metric
              label="Arc USDC"
              value={anyRailReady ? AWAITING : "NOT CONNECTED"}
              hint="USD-par by registered peg"
              tone="muted"
            />
            <Metric
              label="XRPL RLUSD"
              value={anyRailReady ? AWAITING : "NOT CONNECTED"}
              hint="USD-par by registered peg"
              tone="muted"
            />
            <Metric
              label="XRPL XRP"
              value={anyRailReady ? AWAITING : "NOT CONNECTED"}
              // XRP has no peg. Its balance is a quantity of XRP; a dollar
              // figure needs a live price this deployment does not have.
              hint={anyRailReady ? `USD value: ${NO_VALUATION}` : "no price source configured"}
              tone="muted"
            />
            <Metric
              label="Pending escrow"
              value={totals.state === "READY" ? usdDisplay(totals.data.pendingEscrow) : AWAITING}
              tone="muted"
            />
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Bound wallets"
            description="Addresses bound to agents. This platform stores no seed phrases and no private keys."
          />
          <DataState
            view={wallets}
            emptyTitle="NO WALLETS BOUND"
            emptyDescription="Bind a wallet to an agent before it can transact."
          />
          {wallets.state === "READY" ? (
            <ul className="divide-y divide-[var(--color-border)]">
              {wallets.data.map((wallet) => (
                <li
                  key={`${wallet.agentId}:${wallet.network}:${wallet.address}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium">{wallet.agentName}</div>
                    <div className="tabular mt-0.5 text-[12px] text-[var(--color-muted)]">
                      {truncateMiddle(wallet.address, 12, 8)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{wallet.network}</Badge>
                    <Badge tone="neutral">{wallet.custody}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="μLedger position" description="Obligations not yet settled." />
          <div className="pb-2">
            {totals.state === "READY" ? (
              <>
                <Metric label="Receivables" value={usdDisplay(totals.data.receivable)} />
                <Metric label="Payables" value={usdDisplay(totals.data.payable)} />
              </>
            ) : (
              <EmptyState
                title={totals.state === "NOT_CONNECTED" ? "NOT CONNECTED" : "NO OBLIGATIONS"}
                description={
                  totals.state === "NOT_CONNECTED"
                    ? totals.reason
                    : "There are no outstanding μLedger obligations."
                }
              />
            )}
          </div>
        </Panel>

        <Panel className="lg:col-span-3">
          <PanelHeader
            title="Settlement rails"
            description="Live adapter status. Funding instructions become available once a rail reports READY."
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {adapters.map((adapter) => (
              <li
                key={adapter.adapter}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0">
                  <div className="text-[14px] font-medium capitalize">{adapter.adapter}</div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
                    {adapter.detail}
                  </div>
                </div>
                <Badge tone={stateTone(adapter.status)}>{adapter.status}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
