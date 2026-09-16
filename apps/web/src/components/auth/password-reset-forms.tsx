"use client";

/**
 * Password recovery, both halves.
 *
 * The request half never reveals whether an account exists: the same message is
 * shown either way. Telling an attacker which addresses are registered is a
 * free gift, and the only person inconvenienced by the ambiguity is the one who
 * mistyped their own address.
 */

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button, Input, Label } from "@/components/ui/primitives";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/policy";
import { authClient, authErrorMessage } from "@/lib/auth/client";

export function ForgotPasswordForm({ disabled }: { disabled: boolean }): React.JSX.Element {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });
      // A transport failure is worth reporting; "no such account" is not,
      // and the server does not distinguish the two in its response.
      if (result.error && result.error.status !== 200) {
        setError(authErrorMessage(result.error, "Could not send the reset link."));
        return;
      }
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="mt-5 space-y-4">
        <p className="rounded-lg border border-[rgba(0,229,255,0.3)] bg-[rgba(0,229,255,0.06)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--color-cyan)]">
          If that address has an account, a reset link is on its way. The link expires in one hour
          and can be used once.
        </p>
        <p className="text-center text-[13px]">
          <Link href="/login" className="text-[var(--color-muted)] hover:text-[var(--color-bright)]">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-4">
      {error ? (
        <div className="rounded-lg border border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] px-3 py-2.5 text-[13px] text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="email" disabled={disabled} />
      </div>
      <Button type="submit" variant="primary" className="w-full" disabled={disabled || busy}>
        {busy ? "Sending…" : "Send reset link"}
      </Button>
      <p className="text-center text-[13px]">
        <Link href="/login" className="text-[var(--color-muted)] hover:text-[var(--color-bright)]">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string | null }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <div className="mt-5 space-y-4">
        <p className="rounded-lg border border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--color-danger)]">
          This reset link is missing its token, or has already been used. Request a new one.
        </p>
        <Link
          href="/forgot-password"
          className="block text-center text-[13px] text-[var(--color-cyan)] hover:underline"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password !== confirm) {
      setError("Those two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token: token! });
      if (result.error) {
        setError(authErrorMessage(result.error, "That reset link is no longer valid."));
        return;
      }
      router.push("/login?error=" + encodeURIComponent("Password changed. Sign in again."));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-4">
      {error ? (
        <div className="rounded-lg border border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] px-3 py-2.5 text-[13px] text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}
      <div>
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
        />
        <p className="mt-1.5 text-[11px] text-[var(--color-subtle)]">
          At least {MIN_PASSWORD_LENGTH} characters. Every other session is signed out when this
          changes.
        </p>
      </div>
      <div>
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
        />
      </div>
      <Button type="submit" variant="primary" className="w-full" disabled={busy}>
        {busy ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
