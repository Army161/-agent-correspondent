import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CreateAgentForm } from "@/components/agents/create-agent-form";
import { PageHeader } from "@/components/shell/page-header";
import { Panel, PanelHeader } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Create agent",
  description: "Create an agent with a conservative economic mandate.",
};

export const dynamic = "force-dynamic";

export default async function NewAgentPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  if (!user) redirect("/login?next=%2Fagents%2Fnew");

  return (
    <>
      <PageHeader
        eyebrow="Intelligence plane"
        title="Create an agent"
        description="Start with an identity and a conservative mandate. Wallet binding and capabilities are added only after the agent exists."
      />
      <Panel className="max-w-2xl">
        <PanelHeader
          title="Agent identity"
          description="The model may propose work. It cannot change the mandate that controls economic actions."
        />
        <div className="p-5">
          <CreateAgentForm />
        </div>
      </Panel>
    </>
  );
}
