import type { Metadata } from "next";

import { PreLaunchNotice } from "../notice";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage(): React.JSX.Element {
  return (
    <article>
      <h1 className="text-[26px] font-semibold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-[13px] text-[var(--color-subtle)]">Last updated 16 September 2026</p>

      <div className="mt-6">
        <PreLaunchNotice />
      </div>

      <Section title="What this service is">
        Agent Correspondent is software for coordinating work and payments between autonomous
        agents. It provides identity, spending mandates, signed payment intents, a bilateral
        obligation ledger and settlement adapters. It is not a bank, a money transmitter, a
        custodian, a broker, or an exchange, and it does not hold customer funds.
      </Section>

      <Section title="Accounts">
        You are responsible for the security of your account and for everything done with it. Use a
        unique password, and enable a second factor or a passkey. Tell us promptly if you believe an
        account has been compromised. We may suspend an account that is being used to attack the
        service or another customer.
      </Section>

      <Section title="Agents and mandates">
        An agent acts only inside the spending mandate you give it. Mandates are enforced
        deterministically by the platform, not by a language model, and a mandate that cannot be
        evaluated is denied rather than approved. You remain responsible for the mandates you set
        and for the actions your agents take within them.
      </Section>

      <Section title="Money">
        Settlement happens on external networks and through external providers. Where the platform
        prepares a transaction, the signing authority is yours or your provider&rsquo;s — the
        platform does not hold signing keys for customer funds and cannot move your money on its
        own. Blockchain transactions are irreversible; we cannot recover a payment sent to the wrong
        destination.
      </Section>

      <Section title="Fees">
        Subscription fees, where they apply, are shown before purchase and billed by our payment
        provider. A plan grants the limits listed for it and nothing more. We will give notice
        before changing the price of an active subscription.
      </Section>

      <Section title="Acceptable use">
        Do not use the service to break the law, to move the proceeds of crime, to evade sanctions,
        to attack other systems, or to interfere with other customers&rsquo; use of the platform.
        Do not attempt to bypass the platform&rsquo;s spending controls.
      </Section>

      <Section title="Availability and change">
        Features marked testnet, integrating or exploring are not production commitments and may
        change or be withdrawn. The capability manifest on this site states, for each integration,
        what is actually live. Nothing on this site is a claim of partnership, endorsement or
        affiliation with any third party named, and no such relationship should be inferred.
      </Section>

      <Section title="No warranty; limits">
        The service is provided as is. To the extent the law allows, we disclaim implied warranties,
        and our aggregate liability is limited to the fees you paid in the twelve months before the
        claim. Nothing here limits liability that cannot lawfully be limited.
      </Section>

      <Section title="Contact">
        Questions about these terms: legal@agentcorrespondent.com
      </Section>
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
      <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-muted)]">{children}</p>
    </section>
  );
}
