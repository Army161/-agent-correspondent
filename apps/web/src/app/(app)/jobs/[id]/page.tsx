import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import {
  Badge,
  EmptyState,
  Field,
  Panel,
  PanelHeader,
  stateTone,
} from "@/components/ui/primitives";
import { allowedTransitions, isTerminal, requiresEscrow, type JobState } from "@acor/core";
import { currentUser } from "@/lib/auth";
import { relativeTime, truncateMiddle, usdDisplay } from "@/lib/format";
import { getJob } from "@/lib/platform";

export const metadata: Metadata = { title: "Job" };
export const dynamic = "force-dynamic";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const user = await currentUser();
  if (!user) {
    return (
      <Panel>
        <EmptyState title="NOT CONNECTED" description="Sign in to inspect a job." />
      </Panel>
    );
  }

  const view = await getJob(user.organizationId, id);
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

  const { job, intentId, resultHash, evaluator } = view.data;
  const state = job.state as JobState;
  const transitions = allowedTransitions(state);

  return (
    <>
      <PageHeader
        eyebrow="Job"
        title={job.title}
        description={job.service}
        action={<Badge tone={stateTone(job.state)}>{job.state}</Badge>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Participants and terms"
            description="What was agreed, and under which authorization."
          />
          <div className="px-5 pb-4">
            <dl>
              <Field label="Buyer" value={job.buyerAgentId} mono />
              <Field label="Provider" value={job.providerAgentId ?? "Not yet selected"} mono />
              <Field label="Economic intent" value={intentId ?? "—"} mono />
              <Field label="Evaluator" value={evaluator ?? "—"} />
              <Field label="Result hash" value={resultHash ? truncateMiddle(resultHash, 10, 8) : "—"} mono />
              <Field label="Created" value={relativeTime(job.createdAt)} />
            </dl>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Escrow" description="Funds held against delivery." />
          <div className="px-5 pb-4">
            <dl>
              <Field label="Held" value={job.escrow === null ? "—" : usdDisplay(job.escrow)} mono />
              <Field label="Asset" value={job.settlementAsset ?? "—"} />
              <Field label="Network" value={job.network ?? "—"} />
              <Field
                label="Escrow required"
                value={requiresEscrow(state) ? "Yes, at this state" : "No"}
              />
            </dl>
          </div>
        </Panel>

        <Panel className="lg:col-span-3">
          <PanelHeader
            title="Lifecycle"
            description="The state machine is enforced in the kernel, not implied by which button is rendered."
          />
          <div className="px-5 pb-5">
            {isTerminal(state) ? (
              <p className="text-[13px] text-[var(--color-muted)]">
                <span className="tabular">{state}</span> is terminal. No further transition is legal.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {transitions.map((transition) => (
                  <Badge key={transition} tone="cyan">
                    {transition}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
