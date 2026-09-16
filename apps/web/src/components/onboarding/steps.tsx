"use client";

/**
 * The onboarding checklist's interactive parts.
 *
 * Each step is its own small form so a failure in one does not discard what was
 * typed in another, and so the page stays usable when a step is blocked by
 * missing deployment configuration rather than by the user.
 */

import { useActionState, useState } from "react";

import { Button, Input, Label, Textarea } from "@/components/ui/primitives";
import { authClient, authErrorMessage } from "@/lib/auth/client";
import { IDLE, type ActionState } from "@/app/onboarding/action-state";
import {
  choosePlanAction,
  recordPurposeAction,
  renameOrganizationAction,
} from "@/app/onboarding/actions";

function Error({ state }: { state: ActionState }): React.JSX.Element | null {
  if (!state.error) return null;
  return (
    <p className="mt-2 text-[12px] text-[var(--color-danger)]" role="alert">
      {state.error}
    </p>
  );
}

export function VerifyEmailStep({
  email,
  verified,
  deliverable,
}: {
  email: string;
  verified: boolean;
  deliverable: boolean;
}): React.JSX.Element {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  if (verified) {
    return (
      <p className="text-[13px] text-[var(--color-muted)]">
        <span className="text-[var(--color-bright)]">{email}</span> is confirmed.
      </p>
    );
  }

  if (!deliverable) {
    return (
      <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
        <span className="text-[var(--color-bright)]">{email}</span> is not confirmed, and this
        deployment cannot send mail, so it cannot be confirmed here. Set{" "}
        <code className="font-mono text-[12px] text-[var(--color-bright)]">RESEND_API_KEY</code> and{" "}
        <code className="font-mono text-[12px] text-[var(--color-bright)]">EMAIL_FROM</code>, or
        confirm the address out of band.
      </p>
    );
  }

  async function resend(): Promise<void> {
    setStatus("sending");
    setError(null);
    const result = await authClient.sendVerificationEmail({
      email,
      callbackURL: "/onboarding",
    });
    if (result.error) {
      setError(authErrorMessage(result.error, "Could not send the link."));
      setStatus("failed");
      return;
    }
    setStatus("sent");
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
        A confirmation link was sent to{" "}
        <span className="text-[var(--color-bright)]">{email}</span>. It expires in an hour.
      </p>
      {status === "sent" ? (
        <p className="text-[12px] text-[var(--color-cyan)]">Another link is on its way.</p>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={status === "sending"}
          onClick={() => void resend()}
        >
          {status === "sending" ? "Sending…" : "Send it again"}
        </Button>
      )}
      {error ? (
        <p className="text-[12px] text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function OrganizationStep({
  currentName,
  named,
}: {
  currentName: string;
  named: boolean;
}): React.JSX.Element {
  const [state, action, pending] = useActionState(renameOrganizationAction, IDLE);

  return (
    <form action={action} className="space-y-3">
      <div>
        <Label htmlFor="organization-name">Organization name</Label>
        <Input
          id="organization-name"
          name="name"
          defaultValue={named ? currentName : ""}
          placeholder="Acme Research"
          maxLength={120}
          required
        />
      </div>
      <Button type="submit" variant="primary" size="sm" disabled={pending}>
        {pending ? "Saving…" : named ? "Rename" : "Save name"}
      </Button>
      <Error state={state} />
    </form>
  );
}

export function PurposeStep({ purpose }: { purpose: string | null }): React.JSX.Element {
  const [state, action, pending] = useActionState(recordPurposeAction, IDLE);

  return (
    <form action={action} className="space-y-3">
      <div>
        <Label htmlFor="purpose">What are you building?</Label>
        <Textarea
          id="purpose"
          name="purpose"
          rows={3}
          maxLength={500}
          defaultValue={purpose ?? ""}
          placeholder="A research agent that buys document summaries from other agents."
        />
      </div>
      <Button type="submit" variant="primary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Error state={state} />
    </form>
  );
}

export interface PlanChoice {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly monthlyUsd: number | null;
  /** False when this plan cannot be purchased on this deployment. */
  readonly purchasable: boolean;
  readonly unavailableReason: string | null;
}

export function PlanStep({
  choices,
  selected,
}: {
  choices: readonly PlanChoice[];
  selected: string | null;
}): React.JSX.Element {
  const [state, action, pending] = useActionState(choosePlanAction, IDLE);
  const [choice, setChoice] = useState<string>(selected ?? choices[0]?.id ?? "");

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="planId" value={choice} />
      <div className="grid gap-2 sm:grid-cols-2">
        {choices.map((plan) => {
          const active = plan.id === choice;
          return (
            <button
              key={plan.id}
              type="button"
              onClick={() => setChoice(plan.id)}
              aria-pressed={active}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active
                  ? "border-[rgba(0,229,255,0.5)] bg-[rgba(0,229,255,0.06)]"
                  : "border-[var(--color-border)] hover:border-[rgba(0,229,255,0.3)]"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold">{plan.name}</span>
                <span className="text-[12px] text-[var(--color-muted)]">
                  {plan.monthlyUsd === null
                    ? "Contact us"
                    : plan.monthlyUsd === 0
                      ? "Free"
                      : `$${plan.monthlyUsd}/mo`}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
                {plan.tagline}
              </p>
              {plan.unavailableReason ? (
                <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-subtle)]">
                  {plan.unavailableReason}
                </p>
              ) : null}
            </button>
          );
        })}
      </div>
      <Button type="submit" variant="primary" size="sm" disabled={pending || choice.length === 0}>
        {pending ? "Saving…" : "Choose this plan"}
      </Button>
      <p className="text-[11px] leading-relaxed text-[var(--color-subtle)]">
        Recording a choice is not a purchase. A paid plan is granted only after checkout completes
        and the provider&rsquo;s signed webhook arrives.
      </p>
      <Error state={state} />
    </form>
  );
}
