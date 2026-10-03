"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Input, Label } from "@/components/ui/primitives";

export interface ApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

function messageFrom(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

/**
 * Issue and revoke organization API keys. A new key is displayed exactly once,
 * in this component's state; reloading the page loses it, by design -- only
 * its hash was ever stored.
 */
export function ApiKeysPanel({ keys }: { keys: readonly ApiKeyRow[] }): React.JSX.Element {
  const router = useRouter();
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError(null);
    setIssued(null);
    setPending(true);
    const name = String(new FormData(formElement).get("keyName") ?? "").trim();
    try {
      const response = await fetch("/api/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body: unknown = await response.json().catch(() => null);
      const key = (body as { key?: unknown } | null)?.key;
      if (!response.ok || typeof key !== "string") {
        setError(messageFrom(body, "The key could not be issued."));
        return;
      }
      setIssued(key);
      formElement.reset();
      router.refresh();
    } catch {
      setError("The request could not be completed. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setError(messageFrom(await response.json().catch(() => null), "The key could not be revoked."));
        return;
      }
      router.refresh();
    } catch {
      setError("The request could not be completed. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4 px-5 pb-5">
      {error ? (
        <p role="alert" className="rounded-lg border border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] px-3 py-2.5 text-[13px] text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      {issued ? (
        <div className="rounded-lg border border-[rgba(0,229,255,0.35)] bg-[rgba(0,229,255,0.05)] px-3 py-3">
          <p className="text-[12px] text-[var(--color-muted)]">
            Copy this key now. It will not be shown again — only its hash is stored.
          </p>
          <code data-testid="issued-api-key" className="tabular mt-2 block break-all text-[12.5px] text-[var(--color-bright)]">
            {issued}
          </code>
        </div>
      ) : null}

      <form onSubmit={(event) => void create(event)} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Label htmlFor="keyName">Key name</Label>
          <Input id="keyName" name="keyName" required maxLength={80} placeholder="CI pipeline" disabled={pending} />
        </div>
        <Button type="submit" variant="primary" disabled={pending}>
          Issue key
        </Button>
      </form>

      {keys.length === 0 ? (
        <p className="text-[12px] text-[var(--color-subtle)]">No keys issued yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-[13px]">{key.name}</div>
                <div className="tabular truncate text-[11px] text-[var(--color-subtle)]">
                  {key.prefix}… · {key.lastUsedAt ? `last used ${key.lastUsedAt.slice(0, 10)}` : "never used"}
                </div>
              </div>
              {key.revokedAt ? (
                <Badge tone="neutral">REVOKED</Badge>
              ) : (
                <Button size="sm" variant="danger" disabled={pending} onClick={() => void revoke(key.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
