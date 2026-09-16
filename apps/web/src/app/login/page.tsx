import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LogoMark } from "@/components/brand/logo";
import { Button, Input, Label, Panel } from "@/components/ui/primitives";
import { authenticate, createSession, currentUser, registerUser } from "@/lib/auth";
import { isDatabaseConfigured } from "@acor/db";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

async function signIn(formData: FormData): Promise<void> {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const result = await authenticate(email, password);
  if (!result.ok || !result.userId) {
    redirect(`/login?error=${encodeURIComponent(result.error ?? "Sign in failed.")}`);
  }
  await createSession(result.userId);
  redirect("/chat");
}

async function signUp(formData: FormData): Promise<void> {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const organization = String(formData.get("organization") ?? "").trim() || "My organization";
  const result = await registerUser(email, password, organization);
  if (!result.ok || !result.userId) {
    redirect(`/login?error=${encodeURIComponent(result.error ?? "Registration failed.")}`);
  }
  await createSession(result.userId);
  redirect("/chat");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string }>;
}): Promise<React.JSX.Element> {
  const { error, mode } = await searchParams;
  const user = await currentUser();
  if (user) redirect("/chat");

  const configured = isDatabaseConfigured();
  const registering = mode === "register";

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
            {configured
              ? "Access the Agent Chat OS and your organization's agents."
              : "This deployment has no database configured, so accounts cannot be created or used. Set DATABASE_URL and run the migrations in packages/db."}
          </p>

          {error ? (
            <div className="mt-4 rounded-lg border border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] px-3 py-2.5 text-[13px] text-[var(--color-danger)]">
              {error}
            </div>
          ) : null}

          <form action={registering ? signUp : signIn} className="mt-5 space-y-4">
            {registering ? (
              <div>
                <Label htmlFor="organization">Organization</Label>
                <Input
                  id="organization"
                  name="organization"
                  autoComplete="organization"
                  disabled={!configured}
                  placeholder="Acme Research"
                />
              </div>
            ) : null}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                disabled={!configured}
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={registering ? 12 : 1}
                autoComplete={registering ? "new-password" : "current-password"}
                disabled={!configured}
              />
              {registering ? (
                <p className="mt-1.5 text-[11px] text-[var(--color-subtle)]">
                  At least 12 characters. Hashed with scrypt; never stored in the clear.
                </p>
              ) : null}
            </div>
            <Button type="submit" variant="primary" className="w-full" disabled={!configured}>
              {registering ? "Create account" : "Sign in"}
            </Button>
          </form>

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
