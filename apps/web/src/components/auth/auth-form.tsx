"use client";

/**
 * The sign-in / sign-up form.
 *
 * One component renders both modes. Two copies of an auth form is two places to
 * get password rules, provider availability and the terms acknowledgement
 * wrong.
 *
 * What this component is *not*: an authorization boundary. Every branch here is
 * presentation. The server decides whether a sign-in succeeds, whether an email
 * is verified, and what the resulting session may do.
 */

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button, Divider, Input, Label } from "@/components/ui/primitives";
import { authClient, authErrorMessage } from "@/lib/auth/client";

export interface ProviderOption {
  readonly id: "google" | "github" | "apple";
  readonly label: string;
  readonly configured: boolean;
}

interface AuthFormProps {
  readonly mode: "sign-in" | "register";
  readonly providers: readonly ProviderOption[];
  readonly redirectTo: string;
  readonly unavailableReason: string | null;
  readonly minPasswordLength: number;
}

type Stage = "credentials" | "totp";

export function AuthForm({
  mode,
  providers,
  redirectTo,
  unavailableReason,
  minPasswordLength,
}: AuthFormProps): React.JSX.Element {
  const router = useRouter();
  const registering = mode === "register";
  const available = unavailableReason === null;

  const [stage, setStage] = useState<Stage>("credentials");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const disabled = !available || pending || busy;

  function finish(): void {
    // A full navigation, not a client-side push: the session cookie was just
    // set and every server component needs to re-render against it.
    startTransition(() => {
      router.push(redirectTo);
      router.refresh();
    });
  }

  async function onSocial(provider: ProviderOption["id"]): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await authClient.signIn.social({ provider, callbackURL: redirectTo });
    if (result.error) {
      setError(authErrorMessage(result.error, `Could not start ${provider} sign-in.`));
      setBusy(false);
    }
    // On success the browser is redirected by the provider; leave `busy` set.
  }

  async function onPasskey(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError(authErrorMessage(result.error, "Passkey sign-in did not complete."));
        return;
      }
      finish();
    } catch (cause) {
      // A cancelled WebAuthn prompt throws. That is a choice, not a failure.
      setError(authErrorMessage(cause, "Passkey sign-in was cancelled."));
    } finally {
      setBusy(false);
    }
  }

  async function onCredentials(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    try {
      if (registering) {
        const name = String(form.get("name") ?? "").trim();
        const result = await authClient.signUp.email({
          email,
          password,
          name: name.length > 0 ? name : email.split("@")[0] || email,
        });
        if (result.error) {
          setError(authErrorMessage(result.error, "Could not create the account."));
          return;
        }
        finish();
        return;
      }

      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(authErrorMessage(result.error, "Incorrect email or password."));
        return;
      }
      // Two-factor is enforced server-side: the sign-in call returns without a
      // session and asks for a second factor.
      if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true) {
        setStage("totp");
        setNotice("Enter the six-digit code from your authenticator app.");
        return;
      }
      finish();
    } finally {
      setBusy(false);
    }
  }

  async function onTotp(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const code = String(form.get("code") ?? "").trim();
    const trustDevice = form.get("trustDevice") === "on";
    try {
      const result = await authClient.twoFactor.verifyTotp({ code, trustDevice });
      if (result.error) {
        setError(authErrorMessage(result.error, "That code was not accepted."));
        return;
      }
      finish();
    } finally {
      setBusy(false);
    }
  }

  if (stage === "totp") {
    return (
      <form onSubmit={onTotp} className="mt-5 space-y-4">
        {notice ? <Notice tone="info">{notice}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div>
          <Label htmlFor="code">Authentication code</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={8}
            required
            autoFocus
            placeholder="000000"
          />
        </div>
        <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
          <input
            type="checkbox"
            name="trustDevice"
            className="mt-0.5 size-3.5 accent-[var(--color-cyan)]"
          />
          <span>Trust this browser for 60 days.</span>
        </label>
        <Button type="submit" variant="primary" className="w-full" disabled={busy || pending}>
          {busy ? "Verifying…" : "Verify"}
        </Button>
        <button
          type="button"
          onClick={() => {
            setStage("credentials");
            setError(null);
            setNotice(null);
          }}
          className="w-full text-center text-[13px] text-[var(--color-muted)] hover:text-[var(--color-bright)]"
        >
          Use a different account
        </button>
      </form>
    );
  }

  const configured = providers.filter((provider) => provider.configured);
  const unconfigured = providers.filter((provider) => !provider.configured);

  return (
    <div className="mt-5">
      {error ? <Notice tone="error">{error}</Notice> : null}

      {configured.length > 0 ? (
        <div className="space-y-2.5">
          {configured.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              variant="secondary"
              className="w-full"
              disabled={disabled}
              onClick={() => void onSocial(provider.id)}
            >
              Continue with {provider.label}
            </Button>
          ))}
        </div>
      ) : null}

      {unconfigured.length > 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-subtle)]">
          {unconfigured.map((provider) => provider.label).join(", ")}{" "}
          {unconfigured.length === 1 ? "sign-in is" : "sign-in is"} not available on this deployment:
          no OAuth credentials are configured for {unconfigured.length === 1 ? "it" : "them"}.
        </p>
      ) : null}

      {configured.length > 0 ? (
        <div className="my-5 flex items-center gap-3">
          <Divider className="flex-1" />
          <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-subtle)]">
            or
          </span>
          <Divider className="flex-1" />
        </div>
      ) : null}

      <form onSubmit={onCredentials} className="space-y-4">
        {registering ? (
          <div>
            <Label htmlFor="name">Your name</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              disabled={disabled}
              placeholder="Ada Lovelace"
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
            disabled={disabled}
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={registering ? minPasswordLength : 1}
            autoComplete={registering ? "new-password" : "current-password"}
            disabled={disabled}
          />
          {registering ? (
            <p className="mt-1.5 text-[11px] text-[var(--color-subtle)]">
              At least {minPasswordLength} characters. There are no composition rules and no
              maximum short enough to break a password manager.
            </p>
          ) : (
            <p className="mt-1.5 text-right text-[12px]">
              <Link href="/forgot-password" className="text-[var(--color-muted)] hover:text-[var(--color-cyan)]">
                Forgot your password?
              </Link>
            </p>
          )}
        </div>

        {registering ? (
          <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
            <input
              type="checkbox"
              name="terms"
              required
              disabled={disabled}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-cyan)]"
            />
            <span>
              I agree to the{" "}
              <Link href="/legal/terms" className="text-[var(--color-cyan)] hover:underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/legal/privacy" className="text-[var(--color-cyan)] hover:underline">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
        ) : null}

        <Button type="submit" variant="primary" className="w-full" disabled={disabled}>
          {busy || pending
            ? registering
              ? "Creating account…"
              : "Signing in…"
            : registering
              ? "Create account"
              : "Sign in"}
        </Button>
      </form>

      {registering ? null : (
        <button
          type="button"
          onClick={() => void onPasskey()}
          disabled={disabled}
          className="mt-3 w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-[13px] text-[var(--color-muted)] hover:border-[rgba(0,229,255,0.4)] hover:text-[var(--color-bright)] disabled:opacity-50"
        >
          Sign in with a passkey
        </button>
      )}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "error" | "info";
  children: React.ReactNode;
}): React.JSX.Element {
  const styles =
    tone === "error"
      ? "border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] text-[var(--color-danger)]"
      : "border-[rgba(0,229,255,0.3)] bg-[rgba(0,229,255,0.06)] text-[var(--color-cyan)]";
  return (
    <div className={`mb-4 rounded-lg border px-3 py-2.5 text-[13px] ${styles}`} role="status">
      {children}
    </div>
  );
}
