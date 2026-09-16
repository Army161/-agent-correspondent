import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthForm, type ProviderOption } from "@/components/auth/auth-form";
import { LogoMark } from "@/components/brand/logo";
import { Panel } from "@/components/ui/primitives";
import { authUnavailableReason, currentUser, socialProviderAvailability } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/policy";
import { safeInternalPath } from "@/lib/redirects";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; next?: string; error?: string }>;
}): Promise<React.JSX.Element> {
  const { mode, next, error } = await searchParams;
  const user = await currentUser();

  // An open redirect in an auth flow hands an attacker a valid session, so the
  // post-sign-in destination is validated as a same-origin path or dropped.
  const redirectTo = safeInternalPath(next, "/onboarding");
  if (user) redirect(redirectTo);

  const registering = mode === "register";
  const unavailableReason = authUnavailableReason();
  const providers: readonly ProviderOption[] = socialProviderAvailability().map((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: provider.configured,
  }));

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex flex-col items-center gap-3">
          <LogoMark size={48} />
          <span className="text-[13px] font-semibold tracking-[0.2em] text-[var(--color-muted)]">
            AGENT CORRESPONDENT
          </span>
        </Link>

        <Panel className="p-6">
          <h1 className="text-[19px] font-semibold tracking-tight">
            {registering ? "Create an account" : "Sign in"}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
            {unavailableReason
              ? `Accounts are unavailable on this deployment. ${unavailableReason}`
              : "Access the Agent Chat OS and your organization's agents."}
          </p>

          {error ? (
            <div className="mt-4 rounded-lg border border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] px-3 py-2.5 text-[13px] text-[var(--color-danger)]">
              {error}
            </div>
          ) : null}

          <AuthForm
            mode={registering ? "register" : "sign-in"}
            providers={providers}
            redirectTo={redirectTo}
            unavailableReason={unavailableReason}
            minPasswordLength={MIN_PASSWORD_LENGTH}
          />

          <p className="mt-5 text-center text-[13px] text-[var(--color-muted)]">
            {registering ? (
              <Link href="/login" className="text-[var(--color-cyan)] hover:underline">
                Already have an account? Sign in
              </Link>
            ) : (
              <Link href="/login?mode=register" className="text-[var(--color-cyan)] hover:underline">
                Create an account
              </Link>
            )}
          </p>
        </Panel>
      </div>
    </main>
  );
}
