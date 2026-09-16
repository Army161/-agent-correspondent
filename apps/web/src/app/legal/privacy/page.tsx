import type { Metadata } from "next";

import { PreLaunchNotice } from "../notice";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage(): React.JSX.Element {
  return (
    <article>
      <h1 className="text-[26px] font-semibold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-[13px] text-[var(--color-subtle)]">Last updated 16 September 2026</p>

      <div className="mt-6">
        <PreLaunchNotice />
      </div>

      <Section title="What we store">
        <List
          items={[
            "Account identity: your email address, display name, and the authentication methods you enrol (a password hash, TOTP secret, or passkey public key). Passwords are stored only as hashes; passkeys store a public key, which is public by construction.",
            "Organization data: the agents, mandates, wallets, jobs, intents, receipts and ledger entries your organization creates.",
            "Operational records: sign-in times, sessions and their IP addresses and user agents, API key usage, and audit entries for security-relevant actions.",
            "Billing state: a payment-provider customer and subscription identifier, the plan, and the status. Card numbers never reach our servers.",
          ]}
        />
      </Section>

      <Section title="What we do not store">
        <List
          items={[
            "Seed phrases and private keys. The platform never asks for one and has nowhere to put one.",
            "Card numbers or bank credentials. Payment details go directly to the payment provider.",
            "Personal data on a public ledger. On-chain records carry addresses, amounts and intent hashes — never names, emails or documents.",
          ]}
        />
      </Section>

      <Section title="Why we store it">
        To operate your account, enforce the spending controls you configure, keep an auditable
        record of economic actions, bill correctly, and investigate abuse or a security incident.
      </Section>

      <Section title="Who else sees it">
        Service providers we depend on, each seeing only what its function requires: a database
        host, a transactional email provider (your address, for verification and security mail), a
        payment provider (your billing identity), and the model providers you choose to route chat
        through. Where you enable a settlement network, the transaction details you submit become
        public on that network. We do not sell personal data.
      </Section>

      <Section title="How long">
        Account and organization data for as long as the account exists. Financial records —
        receipts, ledger entries, audit logs — are append-only and retained after deletion where we
        are required to keep them; they are pseudonymous, keyed by identifiers rather than by name.
        Sessions expire within fourteen days of their last use.
      </Section>

      <Section title="Your choices">
        You can change or delete your agents, mandates and wallet links at any time, export your
        organization&rsquo;s data through the developer API, revoke individual sessions and API
        keys, and ask us to delete your account. Deleting an account removes identity and
        organization data; it does not rewrite an append-only financial record or an on-chain
        transaction, because neither can be rewritten.
      </Section>

      <Section title="Contact">privacy@agentcorrespondent.com</Section>
    </article>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mt-7">
      <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
      <div className="mt-2 text-[14px] leading-relaxed text-[var(--color-muted)]">{children}</div>
    </section>
  );
}

function List({ items }: { items: readonly string[] }): React.JSX.Element {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <span className="mt-2 size-1 shrink-0 rounded-full bg-[var(--color-cyan)]" aria-hidden />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
