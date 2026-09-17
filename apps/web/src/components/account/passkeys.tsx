"use client";

/**
 * Passkey enrolment.
 *
 * A passkey is the one credential on this account that cannot be phished: the
 * browser binds it to this origin, so a convincing copy of this site cannot
 * collect one. That is worth more than any amount of advice about checking the
 * address bar.
 *
 * What is stored is a public key. A database disclosure reveals nothing usable.
 */

import { useCallback, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";

import { Button, Input } from "@/components/ui/primitives";
import { authClient, authErrorMessage } from "@/lib/auth/client";

interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
  deviceType?: string | null;
}

export function Passkeys({ initial }: { initial: readonly PasskeyRow[] }): React.JSX.Element {
  // Rendered from a server-side read, so the list is correct on first paint.
  // It is re-read only after this component changes it.
  const [rows, setRows] = useState<readonly PasskeyRow[]>(initial);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await authClient.passkey.listUserPasskeys();
    if (result.error) {
      setError(authErrorMessage(result.error, "Could not list passkeys."));
      return;
    }
    setRows((result.data ?? []) as PasskeyRow[]);
  }, []);

  async function add(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.passkey.addPasskey({
        name: name.trim().length > 0 ? name.trim() : undefined,
      });
      if (result?.error) {
        setError(authErrorMessage(result.error, "Could not add that passkey."));
        return;
      }
      setName("");
      await load();
    } catch (cause) {
      // A dismissed WebAuthn prompt throws. That is a choice, not a failure.
      setError(authErrorMessage(cause, "The passkey prompt was dismissed."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await authClient.passkey.deletePasskey({ id });
    if (result.error) {
      setError(authErrorMessage(result.error, "Could not remove that passkey."));
    }
    await load();
    setBusy(false);
  }

  return (
    <div className="space-y-4 px-5 py-4">
      {rows.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
          No passkeys yet. A passkey cannot be phished: the browser binds it to this site, so a
          convincing copy of this page cannot collect one.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <KeyRound className="size-4 shrink-0 text-[var(--color-cyan)]" strokeWidth={1.8} />
                <div className="min-w-0">
                  <div className="truncate text-[13px]">{row.name || "Unnamed passkey"}</div>
                  {row.createdAt ? (
                    <div className="text-[11px] text-[var(--color-subtle)]">
                      Added {new Date(row.createdAt).toISOString().slice(0, 10)}
                    </div>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void remove(row.id)}
                disabled={busy}
                aria-label={`Remove ${row.name || "passkey"}`}
                className="rounded-md p-1.5 text-[var(--color-subtle)] hover:text-[var(--color-danger)] disabled:opacity-50"
              >
                <Trash2 className="size-4" strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name this passkey (optional)"
          maxLength={60}
          className="max-w-[16rem]"
        />
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void add()}>
          Add a passkey
        </Button>
      </div>

      {error ? (
        <p className="text-[12px] text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
