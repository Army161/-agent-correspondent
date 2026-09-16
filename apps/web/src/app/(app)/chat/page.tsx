import type { Metadata } from "next";

import { ChatConsole } from "@/components/chat/console";
import { PageHeader } from "@/components/shell/page-header";
import { configuredProviders } from "@/lib/ai/provider";
import { currentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Chat",
  description:
    "The Agent Chat OS: state an economic intent in language and watch the deterministic kernel decide.",
};

export const dynamic = "force-dynamic";

export default async function ChatPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  const available = configuredProviders();

  return (
    <>
      <PageHeader
        eyebrow="Agent Chat OS"
        title="Chat"
        description="Say what you want done and what it may cost. Discovery, procurement, mandate enforcement and routing run as deterministic services."
      />
      <ChatConsole
        signedIn={user !== null}
        providerConfigured={available.length > 0}
        providerLabel={available[0]?.label ?? null}
      />
    </>
  );
}
