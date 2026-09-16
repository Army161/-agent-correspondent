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

export const metadata: Metadata = {
  title: "Agent Correspondent — Full-Stack Agent Chat OS",
  description:
    "Create autonomous AI agents that can work, transact, settle, clear payments, and build portable economic reputation across modern financial networks.",
  alternates: { canonical: SITE_URL },
};

export default function HomePage(): React.JSX.Element {
  return (
    <main>
      <Hero />
      <Pillars />
      <Architecture />
      <ChatPreview />
      <MuLedgerSection />
      <Integrations />
      <TokenSection />
      <DeveloperSection />
      <Roadmap />
      <FinalCta />
      <SiteFooter />
    </main>
  );
}
