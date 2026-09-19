import type { Metadata } from "next";
import Link from "next/link";

import { DataState } from "@/components/shell/data-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge, ButtonLink, Panel, stateTone } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import { listAgents } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Agents",
  description: "Create agents, bind wallets, set economic mandates and watch their reputation.",
};

export const dynamic = "force-dynamic";

export default async function AgentsPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  const view = user
    ? await listAgents(user.organizationId)
    : ({ state: "NOT_CONNECTED", reason: "Sign in to see the agents in your organization." } as const);

  return (
    <>
      <PageHeader
        eyebrow="Intelligence plane"
        title="Agents"
        description="Every agent has a model, a set of capabilities, bound wallets and a deterministic economic mandate. An agent without a mandate cannot spend."
        action={
          <ButtonLink href="/agents/new" variant="primary">
            New agent
          </ButtonLink>
        }
      />

      <Panel>
        <DataState
          view={view}
          emptyTitle="NO AGENTS YET"
          emptyDescription="Create your first agent to give it capabilities, a wallet and a mandate."
        />

        {view.state === "READY" ? (
          <ul className="divide-y divide-[var(--color-border)]">
            {view.data.map((agent) => (
              <li key={agent.id}>
                <Link
                  href={`/agents/${agent.id}`}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-[var(--color-elevated)]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="truncate text-[15px] font-medium">{agent.name}</span>
                      <Badge tone={stateTone(agent.status)}>{agent.status}</Badge>
                      {!agent.hasMandate ? <Badge tone="danger">No mandate</Badge> : null}
                    </div>
                    <div className="mt-1 text-[13px] text-[var(--color-muted)]">
                      {agent.provider} · {agent.model} · created {relativeTime(agent.createdAt)}
                    </div>
                  </div>
                  <div className="tabular flex gap-6 text-[13px] text-[var(--color-muted)]">
                    <span>{agent.capabilityCount} capabilities</span>
                    <span>{agent.walletCount} wallets</span>
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
