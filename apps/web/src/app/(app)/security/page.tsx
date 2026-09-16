import type { Metadata } from "next";

import { PageHeader } from "@/components/shell/page-header";
import { Badge, Panel, PanelHeader } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Security",
  description: "The controls that stand between an autonomous agent and your money.",
};

const ATTACKS = [
  ["Overspend", "Mandate engine enforces per-transaction, daily and reserve limits before any rail is touched."],
  ["Replay", "Nonces are burned per (signer, chain, contract). A burned nonce is never released, even on cancellation."],
  ["Cross-chain replay", "The chain id and verifying contract are inside the EIP-712 domain, so a signature is worthless elsewhere."],
  ["Forged provider", "A provider that rotated its payout address after signing is rejected; the buyer must re-sign."],
  ["Duplicate settlement", "One settlement reference produces one receipt, enforced by a unique index and an idempotency key."],
  ["Amount mutation", "Execution bounds compare the plan to the signed authorization and refuse on any difference."],
  ["Asset substitution", "The settlement asset is part of the authorization; a different asset fails closed."],
  ["Destination substitution", "The payout destination is exact; only address checksum casing is tolerated."],
  ["Network substitution", "The network is part of the authorization and is re-checked at execution."],
  ["Stale quotes", "Quotes older than the configured window are refused rather than re-priced."],
  ["FX slippage", "Drift beyond the authorized basis points fails the execution."],
  ["Prompt injection", "No tool exposed to the model can move money, sign, or alter a mandate."],
  ["μLedger double credit", "Each economic event carries an idempotency key; a second entry for it is refused."],
  ["Wallet-policy bypass", "Every adapter re-runs the bounds check immediately before submission."],
] as const;

const PRACTICES = [
  ["No seed phrases, ever", "This platform stores no seed phrases and no private keys. Signing happens in a user-controlled wallet or a custody provider's infrastructure."],
  ["No keys through chat", "The chat surface will never ask for a private key or secret, and is instructed to tell you to rotate one if you paste it."],
  ["Append-only financial tables", "Receipts, ledger entries, reputation events, job events, burned nonces and audit logs are protected by database triggers, not just by convention."],
  ["Fail-closed everywhere", "An unknown balance, an unknown spend history or an unverified network primitive is a denial, never an assumption."],
  ["Deterministic authorization", "Every financial execution path is decided by pure functions that a model cannot reach."],
] as const;

export default function SecurityPage(): React.JSX.Element {
  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Security"
        description="An autonomous agent with a wallet is a new kind of attack surface. These are the controls, and the attacks each one is tested against."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Practices"
            description="Properties of the system, not promises about behaviour."
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {PRACTICES.map(([title, body]) => (
              <li key={title} className="px-5 py-4">
                <div className="text-[14px] font-medium">{title}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-muted)]">{body}</p>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader
            title="Attacks under test"
            description="Each of these is a test in the suite. The test passes when the attack fails."
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {ATTACKS.map(([title, body]) => (
              <li key={title} className="flex gap-3 px-5 py-3">
                <Badge tone="success" className="mt-0.5 shrink-0">
                  Blocked
                </Badge>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{title}</div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
                    {body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader title="Reporting a vulnerability" />
          <div className="px-5 pb-5 text-[13px] leading-relaxed text-[var(--color-muted)]">
            <p>
              Report security issues privately to the maintainers before disclosing them publicly.
              Include the affected route or package, the conditions required, and the economic
              impact. Please do not test against other people&apos;s agents or wallets.
            </p>
          </div>
        </Panel>
      </div>
    </>
  );
}
