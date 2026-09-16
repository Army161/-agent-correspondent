import type { Metadata } from "next";
import Link from "next/link";

import { DataState } from "@/components/shell/data-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge, Panel, stateTone } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth";
import { relativeTime, usdDisplay } from "@/lib/format";
import { listJobs } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Jobs",
  description: "Escrowed, evaluated agent work following the ERC-8183 lifecycle.",
};

export const dynamic = "force-dynamic";

const LIFECYCLE = [
  "DRAFT",
  "QUOTED",
  "FUNDED",
  "IN_PROGRESS",
  "SUBMITTED",
  "EVALUATING",
  "COMPLETE",
  "SETTLED",
] as const;

export default async function JobsPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  const view = user
    ? await listJobs(user.organizationId)
    : ({ state: "NOT_CONNECTED", reason: "Sign in to see jobs in your organization." } as const);

  return (
    <>
      <PageHeader
        eyebrow="Intent plane"
        title="Jobs"
        description="Conditional and asynchronous work: funded into escrow, delivered, evaluated, then settled. Sub-cent synchronous calls do not become jobs — the router sends those to a nanopayment rail or the μLedger."
      />

      <Panel className="mb-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[12px] text-[var(--color-subtle)]">
          {LIFECYCLE.map((state, index) => (
            <span key={state} className="flex items-center gap-2">
              <span className="tabular">{state}</span>
              {index < LIFECYCLE.length - 1 ? <span aria-hidden>→</span> : null}
            </span>
          ))}
        </div>
      </Panel>

      <Panel>
        <DataState
          view={view}
          emptyTitle="NO JOBS YET"
          emptyDescription="Jobs appear here once an agent quotes and funds escrowed work."
        />
        {view.state === "READY" ? (
          <ul className="divide-y divide-[var(--color-border)]">
            {view.data.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/jobs/${job.id}`}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-[var(--color-elevated)]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="truncate text-[15px] font-medium">{job.title}</span>
                      <Badge tone={stateTone(job.state)}>{job.state}</Badge>
                    </div>
                    <div className="mt-1 text-[13px] text-[var(--color-muted)]">
                      {job.service} · created {relativeTime(job.createdAt)}
                    </div>
                  </div>
                  <div className="tabular text-right text-[13px]">
                    <div>{job.escrow === null ? "—" : usdDisplay(job.escrow)}</div>
                    <div className="text-[var(--color-muted)]">
                      {job.settlementAsset ?? "—"} {job.network ? `on ${job.network}` : ""}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </>
  );
}
