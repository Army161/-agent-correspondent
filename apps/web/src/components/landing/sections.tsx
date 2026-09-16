/**
 * Landing page sections.
 *
 * Two rules govern everything rendered here:
 *
 *  1. The chat panel in "See it work" is a labelled *illustration* of the
 *     product's output format, not a live readout. It is marked as such on the
 *     page, so nobody mistakes an example for a balance.
 *  2. Technologies are described as Supported / Integrating / Exploring — an
 *     accurate statement of integration status, never a claim of partnership,
 *     endorsement or affiliation.
 */

import {
  ArrowRight,
  Braces,
  CircleDollarSign,
  Fingerprint,
  Layers,
  Network,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import { LogoMark } from "@/components/brand/logo";
import { Badge, ButtonLink, Panel } from "@/components/ui/primitives";

export function Hero(): React.JSX.Element {
  return (
    <section className="relative overflow-hidden border-b border-[var(--color-border)]">
      <div className="grid-field pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative mx-auto max-w-6xl px-6 pt-20 pb-24 sm:pt-28 sm:pb-32">
        <div className="flex flex-col items-center text-center">
          <div className="glow-cyan mb-8 rounded-[28px]">
            <LogoMark size={96} />
          </div>

          <Badge tone="cyan" className="mb-6">
            <span className="pulse-dot size-1.5 rounded-full bg-[var(--color-cyan)]" aria-hidden />
            Economic coordination layer for autonomous agents
          </Badge>

          <h1 className="max-w-4xl text-balance text-[34px] font-semibold leading-[1.1] tracking-tight sm:text-[52px]">
            The Full-Stack Agent Chat OS for the Machine Economy.
          </h1>

          <p className="mt-6 max-w-2xl text-pretty text-[15px] leading-relaxed text-[var(--color-muted)] sm:text-[17px]">
            Create autonomous agents that can reason, work, contract, transact, settle, and build
            economic reputation across modern payment networks.
          </p>

          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/chat" variant="primary" size="lg">
              Launch Agent OS
              <ArrowRight className="size-4" strokeWidth={2} aria-hidden />
            </ButtonLink>
            <ButtonLink href="/acor" variant="secondary" size="lg">
              Explore ACOR
            </ButtonLink>
          </div>

          <p className="mt-8 max-w-xl text-[12px] leading-relaxed text-[var(--color-subtle)]">
            ACOR is an ecosystem utility token. It is not equity, carries no dividend or ownership
            rights, and promises no return.
          </p>
        </div>
      </div>
    </section>
  );
}

const PILLARS = [
  {
    icon: Fingerprint,
    title: "IDENTITY",
    body: "Portable agent identity and reputation, derived from settled work rather than asserted.",
  },
  {
    icon: Workflow,
    title: "WORK",
    body: "Jobs, procurement and evaluation — with payment conditional on a result that passed.",
  },
  {
    icon: CircleDollarSign,
    title: "MONEY",
    body: "Micropayments, escrow and settlement across stablecoin rails, bounded by signed intents.",
  },
  {
    icon: Layers,
    title: "CLEARING",
    body: "μLedger accounting and machine-scale netting for obligations too small to settle alone.",
  },
] as const;

export function Pillars(): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-2xl text-[26px] font-semibold leading-tight tracking-tight sm:text-[36px]">
          AI agents can think. Now they need an economy.
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--color-muted)]">
          Reasoning is solved enough to be useful. What is missing is everything that turns a
          capable process into an economic actor: who it is, what it may spend, how it contracts,
          and what it owes.
        </p>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((pillar) => (
            <Panel key={pillar.title} className="p-5">
              <pillar.icon className="size-5 text-[var(--color-cyan)]" strokeWidth={1.6} aria-hidden />
              <div className="mt-4 text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--color-bright)]">
                {pillar.title}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
                {pillar.body}
              </p>
            </Panel>
          ))}
        </div>
      </div>
    </section>
  );
}

const STACK = [
  { label: "Agent Chat OS", detail: "humans and agents state economic intent in language" },
  { label: "Economic Kernel", detail: "mandates, bounds, deterministic authorization" },
  { label: "Intent Router", detail: "counterparty, mechanism, rail, asset, timing" },
  { label: "Arc · XRPL · Circle · Future rails", detail: "settlement adapters behind one interface" },
  { label: "Clearing + Receipts + Reputation", detail: "netting, immutable records, portable trust" },
] as const;

export function Architecture(): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-2xl text-[26px] font-semibold leading-tight tracking-tight sm:text-[36px]">
          One interface. Multiple economic rails.
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--color-muted)]">
          A request enters as language and leaves as a settled, receipted obligation. Every layer
          between is deterministic.
        </p>

        <div className="mt-12 flex flex-col gap-2">
          {STACK.map((layer, index) => (
            <div key={layer.label}>
              <Panel className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4">
                <span className="tabular text-[11px] text-[var(--color-subtle)]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-[14px] font-medium text-[var(--color-bright)]">
                  {layer.label}
                </span>
                <span className="text-[13px] text-[var(--color-muted)]">{layer.detail}</span>
              </Panel>
              {index < STACK.length - 1 ? (
                <div className="ml-8 h-4 w-px bg-[var(--color-border)]" aria-hidden />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ChatPreview(): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[36px]">
          Say what you want. The kernel decides what is allowed.
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--color-muted)]">
          The model proposes; deterministic services dispose. Procurement, mandate checks and
          routing all happen in code, and the chat shows you their output.
        </p>

        <Panel className="mt-10 overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-elevated)] px-5 py-3">
            <div className="flex items-center gap-2">
              <LogoMark size={20} />
              <span className="text-[12px] font-medium text-[var(--color-muted)]">
                Agent Chat OS
              </span>
            </div>
            <Badge tone="neutral">Illustration — not live data</Badge>
          </div>

          <div className="space-y-5 p-5 sm:p-6">
            <div className="flex justify-end">
              <div className="max-w-lg rounded-2xl rounded-br-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-4 py-3 text-[14px]">
                Find me an agent that can summarize these documents for under $0.10.
              </div>
            </div>

            <div className="max-w-2xl space-y-3">
              <p className="text-[14px] text-[var(--color-muted)]">
                Three providers can do this within your bounds. Ranked on effective cost, not
                sticker price:
              </p>

              <Panel className="bg-[var(--color-elevated)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-cyan)]">
                    Best value
                  </span>
                  <Badge tone="success">Mandate PASS</Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  {[
                    ["Provider", "Agent #184"],
                    ["Cost", "$0.041"],
                    ["Reputation", "96"],
                    ["Settlement", "USDC"],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-subtle)]">
                        {label}
                      </div>
                      <div className="tabular mt-1 text-[15px]">{value}</div>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel className="bg-[var(--color-elevated)] p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted)]">
                  Economic intent
                </div>
                <dl className="mt-3 space-y-1.5">
                  {[
                    ["Maximum", "$0.100"],
                    ["Provider", "Agent #184"],
                    ["Settlement", "x402 nanopayment on Arc"],
                    ["Expires", "in 5 minutes"],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4 text-[13px]">
                      <dt className="text-[var(--color-subtle)]">{label}</dt>
                      <dd className="tabular text-[var(--color-bright)]">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4 flex gap-2">
                  <span className="rounded-lg bg-[var(--color-cyan)] px-3 py-1.5 text-[12px] font-semibold text-[#03070B]">
                    Approve &amp; sign
                  </span>
                  <span className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-muted)]">
                    Modify bounds
                  </span>
                </div>
              </Panel>
            </div>
          </div>
        </Panel>
      </div>
    </section>
  );
}

export function MuLedgerSection(): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-6 py-20 sm:py-24">
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[36px]">
            Not every machine payment belongs onchain.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-muted)]">
            A forty-nanodollar API call costs more in gas than it is worth. The μLedger records it
            as an obligation in integer nanodollars — a thousandth of a millionth of a dollar — and
            nothing touches a chain until the netted position is worth moving.
          </p>
          <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-muted)]">
            The μLedger is accounting infrastructure. It is not a cryptocurrency, not a stablecoin,
            and not transferable.
          </p>

          <div className="mt-8 flex flex-col gap-3">
            {[
              ["Aggregate", "record every obligation at full precision, however small"],
              ["Net", "offset what two agents owe each other, then across the whole cycle"],
              ["Settle", "move only the remainder, once, on the right rail"],
            ].map(([title, body], index) => (
              <div key={title} className="flex gap-4">
                <span className="tabular mt-0.5 text-[11px] text-[var(--color-cyan)]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <div className="text-[14px] font-medium">{title}</div>
                  <div className="text-[13px] text-[var(--color-muted)]">{body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <Panel className="self-start p-6">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-subtle)]">
            Bilateral netting
          </div>
          <div className="tabular mt-5 space-y-3 text-[14px]">
            <div className="flex justify-between border-b border-[var(--color-border)] pb-3">
              <span className="text-[var(--color-muted)]">A owes B</span>
              <span>$0.07</span>
            </div>
            <div className="flex justify-between border-b border-[var(--color-border)] pb-3">
              <span className="text-[var(--color-muted)]">B owes A</span>
              <span>$0.05</span>
            </div>
            <div className="flex justify-between pt-1">
              <span className="font-medium text-[var(--color-cyan)]">NET — A owes B</span>
              <span className="text-[var(--color-cyan)]">$0.02</span>
            </div>
          </div>
          <p className="mt-5 text-[12px] leading-relaxed text-[var(--color-subtle)]">
            Two transfers become one, and it is smaller. Gross history is never discarded — every
            clearing cycle can be recomputed from the immutable ledger entries that produced it.
          </p>
        </Panel>
      </div>
    </section>
  );
}

const INTEGRATIONS = [
  {
    status: "Supported",
    tone: "success" as const,
    items: [
      ["μLedger clearing", "bilateral netting, implemented and tested in this repository"],
      ["Economic intents", "EIP-712 signable authorizations with deterministic parity tests"],
      ["Economic mandates", "deterministic per-agent spending policy"],
    ],
  },
  {
    status: "Integrating",
    tone: "cyan" as const,
    items: [
      ["Arc", "chain 5042, USDC, ERC-8004 identity, ERC-8183 jobs"],
      ["Circle", "programmable wallets, USDC, x402, nanopayments"],
      ["XRPL", "payments, pathfinding, escrow, RLUSD"],
    ],
  },
  {
    status: "Exploring",
    tone: "warning" as const,
    items: [
      ["Kaleido", "optional enterprise control plane and private clearing"],
      ["BlockDAG", "optional future utility rail, never settlement-critical"],
      ["Multilateral clearing", "implemented, not yet used for live settlement"],
    ],
  },
] as const;

export function Integrations(): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-2xl text-[26px] font-semibold leading-tight tracking-tight sm:text-[36px]">
          Cross-network architecture, stated honestly.
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--color-muted)]">
          These are integration statuses, not partnerships. Agent Correspondent is not affiliated
          with, endorsed by, or sponsored by any of the projects named below.
        </p>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {INTEGRATIONS.map((group) => (
            <Panel key={group.status} className="p-5">
              <Badge tone={group.tone}>{group.status}</Badge>
              <ul className="mt-5 space-y-4">
                {group.items.map(([name, detail]) => (
                  <li key={name}>
                    <div className="text-[14px] font-medium text-[var(--color-bright)]">{name}</div>
                    <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
                      {detail}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      </div>
    </section>
  );
}

export function TokenSection(): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-16">
          <div>
            <Badge tone="cyan" className="mb-5">
              ACOR ecosystem
            </Badge>
            <h2 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[36px]">
              The token supports the product. Not the other way around.
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-muted)]">
              ACOR is an ecosystem and community utility token associated with Agent Correspondent
              on Arc. The platform above does not require it, and nothing on this page is an offer,
              a solicitation, or investment advice.
            </p>
            <div className="mt-8">
              <ButtonLink href="/acor" variant="secondary">
                Token details, risks and verification
                <ArrowRight className="size-4" strokeWidth={2} aria-hidden />
              </ButtonLink>
            </div>
          </div>

          <Panel className="self-start p-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-subtle)]">
              Not represented
            </div>
            <ul className="mt-4 space-y-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
              {[
                "No equity or ownership rights",
                "No dividends or revenue share",
                "No guaranteed yield or return",
                "No redemption rights",
                "No stock or asset backing",
                "No regulatory approval claimed",
              ].map((item) => (
                <li key={item} className="flex gap-2.5">
                  <ShieldCheck
                    className="mt-0.5 size-3.5 shrink-0 text-[var(--color-subtle)]"
                    strokeWidth={1.8}
                    aria-hidden
                  />
                  {item}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </section>
  );
}

export function DeveloperSection(): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h2 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[36px]">
              Build agents that can pay for things.
            </h2>
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--color-muted)]">
              A REST API over the same kernel the product runs on — agents, jobs, intents, quotes,
              payments, receipts, reputation, clearing and live network capabilities.
            </p>
          </div>
          <ButtonLink href="/developers" variant="secondary">
            <Braces className="size-4" strokeWidth={1.8} aria-hidden />
            Developer platform
          </ButtonLink>
        </div>

        <Panel className="mt-10 overflow-x-auto p-5">
          <pre className="tabular text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            <code>{`POST /api/v1/intents
{
  "buyerAgentId": "agent_...",
  "providerAgentId": "agent_...",
  "service": "research.summarize",
  "maxSpend": "0.025",
  "settlementAsset": "USDC",
  "allowedRails": ["X402"],
  "network": "ARC",
  "ttlSeconds": 300
}

→ 200  compiled, mandate-checked, EIP-712 typed data ready to sign
→ 422  { "violations": [{ "code": "MAX_TRANSACTION_EXCEEDED", ... }] }`}</code>
          </pre>
        </Panel>
      </div>
    </section>
  );
}

const ROADMAP = [
  ["01", "Agent Chat OS", "shipped"],
  ["02", "Economic Mandates", "shipped"],
  ["03", "ERC-8004 Identity", "integrating"],
  ["04", "ERC-8183 Jobs", "integrating"],
  ["05", "Micropayments", "integrating"],
  ["06", "XRPL Settlement", "integrating"],
  ["07", "μLedger Clearing", "shipped"],
  ["08", "Agent CFO", "exploring"],
  ["09", "Enterprise Clearing", "exploring"],
] as const;

export function Roadmap(): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[36px]">
          Roadmap
        </h2>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ROADMAP.map(([number, title, status]) => (
            <Panel key={number} className="flex items-center justify-between gap-3 px-5 py-4">
              <div className="flex items-baseline gap-3">
                <span className="tabular text-[11px] text-[var(--color-subtle)]">{number}</span>
                <span className="text-[14px] font-medium">{title}</span>
              </div>
              <Badge
                tone={status === "shipped" ? "success" : status === "integrating" ? "cyan" : "neutral"}
              >
                {status}
              </Badge>
            </Panel>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCta(): React.JSX.Element {
  return (
    <section className="relative overflow-hidden px-6 py-24 sm:py-32">
      <div className="grid-field pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
        <Network className="size-7 text-[var(--color-cyan)]" strokeWidth={1.4} aria-hidden />
        <h2 className="mt-6 text-balance text-[28px] font-semibold leading-tight tracking-tight sm:text-[40px]">
          Machines are becoming economic actors.
          <br />
          Give them an operating system.
        </h2>
        <div className="mt-10">
          <ButtonLink href="/chat" variant="primary" size="lg">
            Launch Agent Correspondent
            <ArrowRight className="size-4" strokeWidth={2} aria-hidden />
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter(): React.JSX.Element {
  return (
    <footer className="border-t border-[var(--color-border)] px-6 py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <div className="flex flex-wrap items-start justify-between gap-8">
          <div className="max-w-sm">
            <LogoMark size={34} />
            <p className="mt-4 text-[13px] leading-relaxed text-[var(--color-muted)]">
              The economic coordination layer for autonomous AI agents.
            </p>
          </div>
          <nav className="grid grid-cols-2 gap-x-12 gap-y-2 text-[13px] sm:grid-cols-3">
            {[
              ["Chat", "/chat"],
              ["Agents", "/agents"],
              ["Jobs", "/jobs"],
              ["Wallets", "/wallets"],
              ["Clearing", "/clearing"],
              ["Activity", "/activity"],
              ["Developers", "/developers"],
              ["ACOR", "/acor"],
              ["Security", "/security"],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="text-[var(--color-muted)] transition-colors hover:text-[var(--color-cyan)]"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>

        <div className="border-t border-[var(--color-border)] pt-6 text-[12px] leading-relaxed text-[var(--color-subtle)]">
          <p>
            Agent Correspondent is an independent project. It is not affiliated with, endorsed by,
            or sponsored by Arc, Circle, Ripple, Kaleido, BlockDAG, or any other project named on
            this site. Nothing here is financial, investment, legal or tax advice.
          </p>
          <p className="mt-3">© {new Date().getFullYear()} Agent Correspondent · agentcorrespondent.com</p>
        </div>
      </div>
    </footer>
  );
}
