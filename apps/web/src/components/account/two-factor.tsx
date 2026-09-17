"use client";

/**
 * TOTP enrolment.
 *
 * Enabling and disabling both require the account password. A stolen session
 * cookie must not be enough to add a second factor the real owner does not
 * control, nor to remove the one they do.
 *
 * Backup codes are shown exactly once, at generation. They are stored hashed,
 * so there is no second chance to display them — and saying so at the moment
 * they appear is the only warning that helps.
 */

import { useState } from "react";

import { Button, Input, Label } from "@/components/ui/primitives";
import { authClient, authErrorMessage } from "@/lib/auth/client";

type Stage = "idle" | "password" | "confirm" | "codes";

export function TwoFactor({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [stage, setStage] = useState<Stage>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [isEnabled, setIsEnabled] = useState(enabled);

  async function begin(password: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.twoFactor.enable({ password });
      if (result.error) {
        setError(authErrorMessage(result.error, "That password was not accepted."));
        return;
      }
      const data = result.data as { totpURI?: string; backupCodes?: string[] } | null;
      setTotpUri(data?.totpURI ?? null);
      setBackupCodes(data?.backupCodes ?? []);
      setStage("confirm");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(code: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.twoFactor.verifyTotp({ code });
      if (result.error) {
        setError(authErrorMessage(result.error, "That code was not accepted."));
        return;
      }
      setIsEnabled(true);
      setStage(backupCodes.length > 0 ? "codes" : "idle");
    } finally {
      setBusy(false);
    }
  }

  async function disable(password: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.twoFactor.disable({ password });
      if (result.error) {
        setError(authErrorMessage(result.error, "That password was not accepted."));
        return;
      }
      setIsEnabled(false);
      setStage("idle");
      setTotpUri(null);
      setBackupCodes([]);
    } finally {
      setBusy(false);
    }
  }

  if (stage === "codes") {
    return (
      <div className="space-y-3 px-5 py-4">
        <p className="text-[13px] leading-relaxed text-[var(--color-warning)]">
          Save these backup codes now. They are stored hashed, so this is the only time they can be
          shown. Each works once, and they are the way back in if the authenticator is lost.
        </p>
        <ul className="tabular grid grid-cols-2 gap-1.5 rounded-lg border border-[var(--color-border)] p-3 text-[13px] sm:grid-cols-3">
          {backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <Button type="button" variant="secondary" size="sm" onClick={() => setStage("idle")}>
          I have saved them
        </Button>
      </div>
    );
  }

  if (stage === "confirm") {
    return (
      <form
        className="space-y-3 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm(String(new FormData(event.currentTarget).get("code") ?? "").trim());
        }}
      >
        <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
          Add this to your authenticator app, then enter the six-digit code it shows.
        </p>
        {totpUri ? (
          <code className="block overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3 font-mono text-[11px] text-[var(--color-muted)]">
            {totpUri}
          </code>
        ) : null}
        <div>
          <Label htmlFor="totp-code">Code</Label>
          <Input
            id="totp-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            required
            className="max-w-[10rem]"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? "Verifying…" : "Turn on"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setStage("idle")}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p className="text-[12px] text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  if (stage === "password") {
    return (
      <form
        className="space-y-3 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          const password = String(new FormData(event.currentTarget).get("password") ?? "");
          void (isEnabled ? disable(password) : begin(password));
        }}
      >
        <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
          Confirm your password. A stolen session cookie must not be enough to change how this
          account is protected.
        </p>
        <div>
          <Label htmlFor="tf-password">Password</Label>
          <Input
            id="tf-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="max-w-[20rem]"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? "Checking…" : isEnabled ? "Turn off" : "Continue"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setStage("idle")}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p className="text-[12px] text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <div className="space-y-3 px-5 py-4">
      <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
        {isEnabled
          ? "A code from your authenticator app is required at every sign-in."
          : "A time-based code from an authenticator app, required in addition to your password."}
      </p>
      <Button type="button" variant="secondary" size="sm" onClick={() => setStage("password")}>
        {isEnabled ? "Turn off two-factor" : "Turn on two-factor"}
      </Button>
      {error ? (
        <p className="text-[12px] text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
