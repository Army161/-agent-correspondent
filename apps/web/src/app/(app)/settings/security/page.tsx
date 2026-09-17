import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Passkeys } from "@/components/account/passkeys";
import { Sessions } from "@/components/account/sessions";
import { TwoFactor } from "@/components/account/two-factor";
import { PageHeader } from "@/components/shell/page-header";
import { Badge, Panel, PanelHeader } from "@/components/ui/primitives";
import { currentUser, getAuth, STEP_UP_WINDOW_SECONDS } from "@/lib/auth";
import { requireVerification, verificationProvider } from "@/lib/identity";
import { emailConfigured } from "@/lib/email";
import { headers } from "next/headers";

export const metadata: Metadata = {
  title: "Account security",
  description: "Passkeys, two-factor authentication and active sessions.",
};

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage(): Promise<React.JSX.Element> {
  const user = await currentUser();
  if (!user) redirect("/login?next=%2Fsettings%2Fsecurity");

  // Read on the server so the lists are correct on first paint, and so a
  // browser that never runs the client code still sees the truth.
  const verification = await requireVerification(user.organizationId, "LIVE_SETTLEMENT");
  const provider = verificationProvider();

  const auth = getAuth();
  const requestHeaders = await headers();
  const [passkeys, sessions] = await Promise.all([
    auth
      ? auth.api.listPasskeys({ headers: requestHeaders }).catch(() => [])
      : Promise.resolve([]),
    auth
      ? auth.api.listSessions({ headers: requestHeaders }).catch(() => [])
      : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Account security"
        description="How this account proves it is you. These controls protect the account itself; what an agent may spend is a mandate, and lives with the agent."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="lg:col-span-2">
          <PanelHeader title="This account" />
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <span className="text-[14px]">{user.email}</span>
            <Badge tone={user.emailVerified ? "success" : "warning"}>
              {user.emailVerified ? "CONFIRMED" : "UNCONFIRMED"}
            </Badge>
            <Badge tone={user.twoFactorEnabled ? "success" : "neutral"}>
              {user.twoFactorEnabled ? "TWO-FACTOR ON" : "TWO-FACTOR OFF"}
            </Badge>
            {user.emailVerified ? null : (
              <Link href="/onboarding" className="text-[13px] text-[var(--color-cyan)] hover:underline">
                {emailConfigured()
                  ? "Send a confirmation link"
                  : "Why this cannot be confirmed here"}
              </Link>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Passkeys"
            description="Bound by the browser to this site, so a convincing copy of this page cannot collect one."
          />
          <Passkeys
            initial={passkeys.map((row) => ({
              id: row.id,
              name: row.name ?? null,
              createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
            }))}
          />
        </Panel>

        <Panel>
          <PanelHeader
            title="Two-factor authentication"
            description="A time-based code, in addition to your password."
          />
          <TwoFactor enabled={user.twoFactorEnabled} />
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Active sessions"
            description="Every device signed in to this account. Ending a session revokes it on the server, not just in that browser."
          />
          <Sessions
            currentSessionId={user.sessionId}
            initial={sessions.map((row) => ({
              id: row.id,
              token: row.token,
              createdAt: new Date(row.createdAt).toISOString(),
              ipAddress: row.ipAddress ?? null,
              userAgent: row.userAgent ?? null,
            }))}
          />
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Identity verification"
            description="Required before this organization can authorize a payment on a network where value actually moves. The μLedger and testnets do not need it."
          />
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <Badge tone={verification.allowed ? "success" : "warning"}>
              {verification.status}
            </Badge>
            <span className="text-[13px] text-[var(--color-muted)]">
              {verification.allowed
                ? `Verified to ${verification.effectiveLevel.toLowerCase()} level.`
                : verification.remedy}
            </span>
          </div>
          {provider.configured ? null : (
            <p className="px-5 pb-4 text-[11px] leading-relaxed text-[var(--color-subtle)]">
              No verification provider is configured on this deployment
              ({provider.requires.join(", ")}). There is deliberately no manual approval path: a
              manual approval path is the first thing an attacker with a database connection
              reaches for.
            </p>
          )}
        </Panel>

        <Panel className="lg:col-span-2 p-5">
          <h2 className="text-[14px] font-semibold tracking-tight">Sensitive actions</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
            Some actions need a sign-in from the last{" "}
            {Math.round(STEP_UP_WINDOW_SECONDS / 60)} minutes, not merely a valid cookie: replacing
            a payout wallet, raising a mandate limit, enabling live settlement, revealing an API
            secret, or turning off a control. A stolen session should not be enough to move where
            money goes.
          </p>
        </Panel>
      </div>
    </>
  );
}
