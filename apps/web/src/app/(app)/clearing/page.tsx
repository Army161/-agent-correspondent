import type { Metadata } from "next";

import { DataState } from "@/components/shell/data-state";
import { PageHeader } from "@/components/shell/page-header";
import {
  Badge,
  Field,
  Metric,
  Panel,
  PanelHeader,
} from "@/components/ui/primitives";
import { describeSavings } from "@acor/core";
import { currentUser } from "@/lib/auth";
import { AWAITING, relativeTime, truncateMiddle, usdDisplay } from "@/lib/format";
import { getClearing } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Clearing",
  description: "μLedger netting: gross obligations, net positions and settlement operations saved.",
};

export const dynamic = "force-dynamic";

export default async function ClearingPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  const view = user
    ? await getClearing(user.organizationId)
    : ({ state: "NOT_CONNECTED", reason: "Sign in to see clearing for your organization." } as const);

  const projected = view.state === "READY" ? view.data.projected : null;

  return (
    <>
      <PageHeader
        eyebrow="Clearing plane"
        title="Clearing"
        description="Obligations accumulate at full nanodollar precision and settle in aggregate. Gross history is never discarded: every cycle can be recomputed from the ledger entries that produced it."
      />

      <div className="grid gap-4 lg:grid-cols-4">
        <Panel className="lg:col-span-4">
          <div className="grid divide-y divide-[var(--color-border)] sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
            <Metric
              label="Gross obligations"
              value={view.state === "READY" ? usdDisplay(view.data.grossTotal) : AWAITING}
            />
            <Metric
              label="Net after clearing"
              value={projected ? usdDisplay(projected.netTotal) : AWAITING}
              tone="cyan"
            />
            <Metric
              label="Open entries"
              value={view.state === "READY" ? String(view.data.openEntries) : AWAITING}
            />
            <Metric
              label="Transfers avoided"
              value={projected ? String(projected.savedTransfers) : AWAITING}
            />
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Next clearing cycle"
            description="What bilateral netting would produce if it ran right now."
          />
          <DataState
            view={view}
            emptyTitle="NOTHING TO CLEAR"
            emptyDescription="There are no open μLedger obligations, so no clearing cycle is pending."
          />
          {projected ? (
            <div className="px-5 pb-5">
              <p className="mb-4 text-[13px] leading-relaxed text-[var(--color-muted)]">
                {describeSavings(projected)}
              </p>
              <div className="space-y-2">
                {projected.positions.map((position) => (
                  <div
                    key={`${position.agentA}|${position.agentB}`}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] p-3"
                  >
                    <div className="tabular flex items-center justify-between gap-3 text-[12px] text-[var(--color-muted)]">
                      <span className="truncate">{truncateMiddle(position.agentA, 10, 4)}</span>
                      <span className="shrink-0">↔</span>
                      <span className="truncate">{truncateMiddle(position.agentB, 10, 4)}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-subtle)]">
                          A → B
                        </div>
                        <div className="tabular mt-1 text-[13px]">{usdDisplay(position.grossAToB)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-subtle)]">
                          B → A
                        </div>
                        <div className="tabular mt-1 text-[13px]">{usdDisplay(position.grossBToA)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-cyan)]">
                          Net
                        </div>
                        <div className="tabular mt-1 text-[13px] text-[var(--color-cyan)]">
                          {position.netDebtor ? usdDisplay(position.netAmount) : "cancels"}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Settlement instructions"
            description="What would actually move on a rail."
          />
          {projected && projected.instructions.length > 0 ? (
            <ul className="divide-y divide-[var(--color-border)]">
              {projected.instructions.map((instruction, index) => (
                <li
                  key={`${instruction.from}-${instruction.to}-${index}`}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <span className="tabular truncate text-[12px] text-[var(--color-muted)]">
                    {truncateMiddle(instruction.from, 8, 4)} → {truncateMiddle(instruction.to, 8, 4)}
                  </span>
                  <span className="tabular text-[13px]">{usdDisplay(instruction.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-10 text-center text-[13px] text-[var(--color-muted)]">
              {view.state === "READY"
                ? "No transfer is required — obligations cancel exactly."
                : "AWAITING DATA"}
            </div>
          )}
        </Panel>

        <Panel className="lg:col-span-4">
          <PanelHeader
            title="Completed cycles"
            description="Each cycle carries a proof hash over its inputs and outputs, so it can be re-derived and audited."
          />
          {view.state === "READY" && view.data.recentCycles.length > 0 ? (
            <ul className="divide-y divide-[var(--color-border)]">
              {view.data.recentCycles.map((cycle) => (
                <li key={cycle.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Badge tone="neutral">{cycle.mode}</Badge>
                      <span className="tabular text-[13px]">{cycle.asset}</span>
                      <span className="text-[12px] text-[var(--color-muted)]">
                        {relativeTime(cycle.openedAt)}
                      </span>
                    </div>
                    <Badge tone={cycle.settledAt ? "success" : "warning"}>
                      {cycle.settledAt ? "SETTLED" : "PENDING"}
                    </Badge>
                  </div>
                  <dl className="mt-2">
                    <Field label="Gross" value={usdDisplay(cycle.gross)} mono />
                    <Field label="Net" value={usdDisplay(cycle.net)} mono />
                    <Field label="Entries → transfers" value={`${cycle.entryCount} → ${cycle.instructionCount}`} mono />
                    <Field label="Proof" value={truncateMiddle(cycle.proofHash, 10, 8)} mono />
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-10 text-center text-[13px] text-[var(--color-muted)]">
              No clearing cycle has run yet.
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
