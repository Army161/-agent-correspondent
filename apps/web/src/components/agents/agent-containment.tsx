"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Input, Label } from "@/components/ui/primitives";

export interface ContainmentState {
  readonly engaged: boolean;
  readonly reason: string | null;
  readonly since: string | null;
}

/**
 * Self-service freeze for one agent: an AGENT-scope kill switch. Frozen, every
 * intent this agent submits is refused before the relay is touched. Reversible
 * by construction (the switch is a log), and both directions need a fresh
 * sign-in, so a stolen cookie can neither lift containment nor use it to
 * disrupt a working agent. See docs/SENTINEL_5.md.
 */
export function AgentContainment({
  agentId,
  state,
}: {
  agentId: string;
  state: ContainmentState;
}): React.JSX.Element {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError(null);
    setPending(true);
    const reason = String(new FormData(formElement).get("reason") ?? "").trim();
    try {
      const response = await fetch("/api/v1/security/kill-switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "AGENT",
          target: agentId,
          action: state.engaged ? "DISENGAGE" : "ENGAGE",
          reason,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "The request was refused.");
        return;
      }
      formElement.reset();
      router.refresh();
    } catch {
      setError("The request could not be completed. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 px-5 pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={state.engaged ? "danger" : "success"}>{state.engaged ? "FROZEN" : "NOT FROZEN"}</Badge>
        {state.engaged ? (
          <span className="text-[12px] text-[var(--color-muted)]">
            {state.reason ?? "no reason recorded"}
            {state.since ? ` · since ${state.since.slice(0, 16).replace("T", " ")} UTC` : ""}
          </span>
        ) : (
          <span className="text-[12px] text-[var(--color-muted)]">This agent can submit intents within its mandate.</span>
        )}
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] px-3 py-2.5 text-[13px] text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Label htmlFor="containment-reason">Reason</Label>
          <Input
            id="containment-reason"
            name="reason"
            required
            minLength={3}
            maxLength={500}
            placeholder={state.engaged ? "Investigated; credentials rotated" : "Suspected compromise"}
            disabled={pending}
          />
        </div>
        <Button type="submit" variant={state.engaged ? "secondary" : "danger"} disabled={pending}>
          {state.engaged ? "Unfreeze agent" : "Freeze agent"}
        </Button>
      </form>
    </div>
  );
}
