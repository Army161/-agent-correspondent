import type { Metadata } from "next";

import {
  Architecture,
  ChatPreview,
  DeveloperSection,
  FinalCta,
  Hero,
  Integrations,
  MuLedgerSection,
  Pillars,
  Roadmap,
  SiteFooter,
  TokenSection,
} from "@/components/landing/sections";
import { SITE_URL } from "@/lib/env";
import { getCapabilityManifest } from "@/lib/manifest";

export const metadata: Metadata = {
  title: "Agent Correspondent — Full-Stack Agent Chat OS",
  description:
    "Create autonomous AI agents that can work, transact, settle, clear payments, and build portable economic reputation across modern financial networks.",
  alternates: { canonical: SITE_URL },
};

export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<React.JSX.Element> {
  // Integration and roadmap statuses come from the runtime, not from copy.
  const manifest = await getCapabilityManifest();

  return (
    <main>
      <Hero />
      <Pillars />
      <Architecture />
      <ChatPreview />
      <MuLedgerSection />
      <Integrations manifest={manifest} />
      <TokenSection />
      <DeveloperSection />
      <Roadmap manifest={manifest} />
      <FinalCta />
      <SiteFooter />
    </main>
  );
}
