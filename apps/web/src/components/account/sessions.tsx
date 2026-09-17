"use client";

/**
 * Active sessions.
 *
 * The point of showing these is that a person can recognise one they do not
 * recognise — an unfamiliar IP or a device they never used — and end it. That
 * is the fastest remedy available to someone who suspects a compromise, and it
 * works without waiting for support.
 *
 * Revoking ends the session server-side, not just in this browser.
 */

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { authClient, authErrorMessage } from "@/lib/auth/client";

interface SessionRow {
  id: string;
  token: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  expiresAt?: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** A short, honest description of a user-agent string. Never a guess at a person. */
function describe(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown client";
  const ua = userAgent.toLowerCase();
  const browser = ua.includes("firefox")
    ? "Firefox"
    : ua.includes("edg/")
      ? "Edge"
      : ua.includes("chrome")
        ? "Chrome"
        : ua.includes("safari")
          ? "Safari"
          : "Unknown browser";
  const platform = ua.includes("android")
    ? "Android"
    : ua.includes("iphone") || ua.includes("ipad")
      ? "iOS"
      : ua.includes("mac os")
        ? "macOS"
        : ua.includes("windows")
          ? "Windows"
          : ua.includes("linux")
            ? "Linux"
            : "Unknown platform";
  return `${browser} on ${platform}`;
}

export function Sessions({
  initial,
  currentSessionId,
}: {
  initial: readonly SessionRow[];
  currentSessionId: string;
}): React.JSX.Element {
  // Rendered from a server-side read, then re-read only after a revocation.
  const [rows, setRows] = useState<readonly SessionRow[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await authClient.listSessions();
    if (result.error) {
      setError(authErrorMessage(result.error, "Could not list sessions."));
      return;
    }
    setRows((result.data ?? []) as SessionRow[]);
  }, []);

  async function revoke(token: string): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await authClient.revokeSession({ token });
    if (result.error) setError(authErrorMessage(result.error, "Could not end that session."));
    await load();
    setBusy(false);
  }

  async function revokeOthers(): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await authClient.revokeOtherSessions();
    if (result.error) setError(authErrorMessage(result.error, "Could not end the other sessions."));
    await load();
    setBusy(false);
  }

  return (
    <div className="space-y-4 px-5 py-4">
      {rows.length === 0 ? (
        <p className="text-[13px] text-[var(--color-subtle)]">No sessions are recorded.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {rows.map((row) => {
            const isCurrent = currentSessionId.length > 0 && row.id === currentSessionId;
            return (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px]">
                    {describe(row.userAgent)}
                    {isCurrent ? (
                      <span className="ml-2 text-[11px] text-[var(--color-cyan)]">this device</span>
                    ) : null}
                  </div>
                  <div className="tabular mt-0.5 text-[11px] text-[var(--color-subtle)]">
                    {row.ipAddress || "IP not recorded"}
                    {row.createdAt
                      ? ` · signed in ${new Date(row.createdAt).toISOString().slice(0, 16).replace("T", " ")}Z`
                      : ""}
                  </div>
                </div>
                {isCurrent ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void revoke(row.token)}
                  >
                    End session
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={busy || rows.length < 2}
        onClick={() => void revokeOthers()}
      >
        End every other session
      </Button>

      {error ? (
        <p className="text-[12px] text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
