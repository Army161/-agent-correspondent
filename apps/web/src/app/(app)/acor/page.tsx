import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Badge, Field, Panel, PanelHeader } from "@/components/ui/primitives";
import { acorContractAddress, SITE_URL } from "@/lib/env";

export const metadata: Metadata = {
  title: "ACOR",
  description:
    "ACOR is an ecosystem and community utility token associated with Agent Correspondent on Arc. It is not equity, carries no dividend or ownership rights, and promises no return.",
  alternates: { canonical: `${SITE_URL}/acor` },
};

export const dynamic = "force-dynamic";

const UTILITY = [
  ["Ecosystem access", "Access to community spaces and early product surfaces."],
  ["Developer incentives", "Programs that reward building on the developer platform."],
  ["Agent incentives", "Programs that reward operating useful agents in the network."],
  ["Product testing", "Participation in testing new economic rails and clearing features."],
  ["Future service discounts", "Potential discounts on platform services."],
  ["Future platform utility", "Additional utility as the platform develops."],
] as const;

const NOT_REPRESENTED = [
  "Equity or any ownership interest in any entity",
  "Dividends, revenue share, or profit participation",
  "Guaranteed yield, return, or token appreciation",
  "Redemption rights or a claim on any asset",
  "Backing by stock, securities, or any company balance sheet",
  "Exposure to NVIDIA or any other company",
  "Approval, registration or endorsement by any regulator",
] as const;

const OFFICIAL_LINKS = [
  { label: "Website", href: "https://agentcorrespondent.com" },
  { label: "X", href: "https://x.com/AgentCorrespondent" },
] as const;

const VERIFY = [
  ["Start here", "Only trust a contract address published on agentcorrespondent.com and on the official X account."],
  ["Check the chain", "ACOR is intended to exist on Arc. An address on another chain claiming to be ACOR is not ACOR."],
  ["Compare character by character", "Address-poisoning attacks use lookalike addresses that match at the start and end. Compare the whole string."],
  ["Never trust a DM", "Nobody from Agent Correspondent will DM you a contract address, a sale, or an allocation."],
  ["No presale, no airdrop claim links", "Treat any link asking you to connect a wallet to claim ACOR as hostile."],
] as const;

export default function AcorPage(): React.JSX.Element {
  const contract = acorContractAddress();

  return (
    <>
      <PageHeader
        eyebrow="Token"
        title="ACOR"
        description="An ecosystem and community utility token associated with Agent Correspondent. The platform does not require it, and the product does not exist to support it."
        action={<Badge tone="cyan">Arc</Badge>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Overview"
            description="What ACOR is, stated without embellishment."
          />
          <div className="px-5 pb-5 text-[14px] leading-relaxed text-[var(--color-muted)]">
            <p>
              Agent Correspondent is a Full-Stack Agent Chat OS: autonomous agents that reason,
              contract, transact, settle, clear obligations and build economic reputation. That
              product is the thing being built. ACOR is a community and ecosystem token associated
              with it.
            </p>
            <p className="mt-4">
              Every utility listed on this page is <em>potential</em> and subject to implementation
              and legal review. Nothing here is an offer to sell, a solicitation to buy, or
              financial, investment, legal or tax advice.
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Network" />
          <div className="px-5 pb-4">
            <dl>
              <Field label="Token name" value="Agent Correspondent" />
              <Field label="Ticker" value="ACOR" mono />
              <Field label="Network" value="Arc" />
              <Field label="Launch venue" value="Tolly" />
            </dl>
          </div>
        </Panel>

        <Panel className="lg:col-span-3 border-[rgba(0,229,255,0.25)]">
          <PanelHeader
            title="Contract address"
            description="The single most impersonated piece of information about any token."
          />
          <div className="px-5 pb-5">
            {contract ? (
              <>
                <div className="tabular break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4 text-[14px] text-[var(--color-cyan)]">
                  {contract}
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-subtle)]">
                  Verify this address against the official X account before interacting with it.
                  Compare every character.
                </p>
              </>
            ) : (
              <>
                <div className="rounded-lg border border-[rgba(255,184,77,0.35)] bg-[rgba(255,184,77,0.06)] p-5 text-center">
                  <div className="text-[13px] font-semibold uppercase tracking-[0.18em] text-[var(--color-warning)]">
                    Contract not yet deployed
                  </div>
                  <p className="mx-auto mt-3 max-w-xl text-[13px] leading-relaxed text-[var(--color-muted)]">
                    No ACOR contract address exists yet. Any address you are shown anywhere — a
                    website, a DM, a reply, a group chat — is not ACOR. This page will display the
                    canonical address only once a real deployment has been verified.
                  </p>
                </div>
              </>
            )}
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Potential utility"
            description="Subject to implementation and legal review. None of it is committed."
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {UTILITY.map(([title, body]) => (
              <li key={title} className="px-5 py-3">
                <div className="text-[14px] font-medium">{title}</div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">{body}</p>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader title="What ACOR is not" />
          <ul className="space-y-2.5 px-5 py-4">
            {NOT_REPRESENTED.map((item) => (
              <li key={item} className="flex gap-2.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--color-danger)]" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="lg:col-span-3">
          <PanelHeader title="How to verify" description="Read this before interacting with anything claiming to be ACOR." />
          <ul className="divide-y divide-[var(--color-border)]">
            {VERIFY.map(([title, body], index) => (
              <li key={title} className="flex gap-4 px-5 py-3">
                <span className="tabular mt-0.5 shrink-0 text-[11px] text-[var(--color-cyan)]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <div className="text-[14px] font-medium">{title}</div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader title="Official links" description="These are the only official channels." />
          <ul className="divide-y divide-[var(--color-border)]">
            {OFFICIAL_LINKS.map(({ label, href }) => (
              <li key={href} className="flex items-center justify-between gap-3 px-5 py-3">
                <span className="text-[13px] text-[var(--color-muted)]">{label}</span>
                <a
                  href={href}
                  rel="noopener noreferrer me"
                  className="flex items-center gap-1.5 text-[13px] text-[var(--color-cyan)] hover:underline"
                >
                  {href.replace("https://", "")}
                  <ExternalLink className="size-3.5" strokeWidth={1.8} aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="border-[rgba(255,92,112,0.3)]">
          <PanelHeader title="Risk disclosures" />
          <ul className="space-y-2.5 px-5 py-4 text-[12px] leading-relaxed text-[var(--color-muted)]">
            {[
              "Tokens can lose all of their value. You may lose everything you put in.",
              "Liquidity may be thin or disappear entirely; you may be unable to sell.",
              "Smart contracts can contain bugs that result in total, irreversible loss.",
              "Regulatory treatment of tokens varies by jurisdiction and can change.",
              "Impersonation and address-poisoning scams are common. Verify everything.",
              "Nothing on this page is financial, investment, legal or tax advice.",
            ].map((risk) => (
              <li key={risk} className="flex gap-2.5">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--color-warning)]" aria-hidden />
                {risk}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
