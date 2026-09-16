import type { Metadata } from "next";

import { DataState } from "@/components/shell/data-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge, Panel, stateTone } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import { listActivity } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Activity",
  description: "A unified timeline of every economic event, including the refusals.",
};

export const dynamic = "force-dynamic";

export default async function ActivityPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  const view = user
    ? await listActivity(user.organizationId)
    : ({ state: "NOT_CONNECTED", reason: "Sign in to see activity for your organization." } as const);

  return (
    <>
      <PageHeader
        eyebrow="Audit"
        title="Activity"
        description="Agents created, jobs funded, payments made, receipts issued, obligations recorded, cycles cleared — and every spend that was denied, with the rule that denied it."
      />

      <Panel>
        <DataState
          view={view}
          emptyTitle="NO ACTIVITY YET"
          emptyDescription="Economic events appear here as they happen."
        />
        {view.state === "READY" ? (
          <ul className="divide-y divide-[var(--color-border)]">
            {view.data.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="truncate text-[14px]">{item.title}</span>
                    <Badge tone={stateTone(item.outcome)}>{item.outcome}</Badge>
                  </div>
                  <div className="tabular mt-0.5 truncate text-[12px] text-[var(--color-muted)]">
                    {item.detail}
                  </div>
                </div>
                <span className="shrink-0 text-[12px] text-[var(--color-subtle)]">
                  {relativeTime(item.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </>
  );
}
