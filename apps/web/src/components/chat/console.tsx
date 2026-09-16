"use client";

import { ArrowUp, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ActionCardView, type ActionCard } from "@/components/chat/cards";
import { LogoMark } from "@/components/brand/logo";
import { Badge, Panel, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

interface Turn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly cards?: readonly ActionCard[];
  readonly failed?: boolean;
}

const SUGGESTIONS = [
  "Find an agent that can analyze this dataset for under $1.",
  "Show me what my agents spent today.",
  "Which rail would a $0.0004 recurring payment use?",
  "Check whether my buyer agent can spend $0.05 on Arc.",
] as const;

export function ChatConsole({
  signedIn,
  providerConfigured,
  providerLabel,
}: {
  signedIn: boolean;
  providerConfigured: boolean;
  providerLabel: string | null;
}): React.JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;

      const history: Turn[] = [...turns, { role: "user", content: message }];
      setTurns(history);
      setDraft("");
      setBusy(true);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
          }),
        });
        const payload = (await response.json()) as {
          text?: string;
          cards?: ActionCard[];
          message?: string;
        };

        if (!response.ok) {
          setTurns([
            ...history,
            {
              role: "assistant",
              content: payload.message ?? "The request could not be completed.",
              failed: true,
            },
          ]);
          return;
        }

        setTurns([
          ...history,
          {
            role: "assistant",
            content: payload.text ?? "",
            cards: payload.cards ?? [],
          },
        ]);
      } catch {
        setTurns([
          ...history,
          {
            role: "assistant",
            content: "The chat service is unreachable from this browser.",
            failed: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, turns],
  );

  const disabled = !signedIn || !providerConfigured;

  return (
    <div className="flex min-h-[70dvh] flex-col">
      <div className="flex-1 space-y-6">
        {turns.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-center">
            <LogoMark size={52} />
            <h2 className="mt-5 text-[20px] font-semibold tracking-tight">
              State an economic intent.
            </h2>
            <p className="mt-2 max-w-md text-[14px] leading-relaxed text-[var(--color-muted)]">
              Describe the work and the bounds. Discovery, ranking, mandate checks and routing run
              as deterministic services, and their decisions appear as cards below the reply.
            </p>

            <div className="mt-8 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={disabled}
                  onClick={() => void send(suggestion)}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3 text-left text-[13px] text-[var(--color-muted)] transition-colors hover:border-[rgba(0,229,255,0.3)] hover:text-[var(--color-bright)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn, index) => (
          <div key={index} className={cn(turn.role === "user" && "flex justify-end")}>
            {turn.role === "user" ? (
              <div className="max-w-xl rounded-2xl rounded-br-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-4 py-3 text-[14px] leading-relaxed">
                {turn.content}
              </div>
            ) : (
              <div className="max-w-3xl space-y-3">
                {turn.content ? (
                  <p
                    className={cn(
                      "whitespace-pre-wrap text-[14px] leading-relaxed",
                      turn.failed ? "text-[var(--color-warning)]" : "text-[var(--color-bright)]",
                    )}
                  >
                    {turn.content}
                  </p>
                ) : null}
                {turn.cards?.map((card, cardIndex) => (
                  <ActionCardView key={`${card.tool}-${cardIndex}`} card={card} />
                ))}
              </div>
            )}
          </div>
        ))}

        {busy ? (
          <div className="flex items-center gap-2 text-[13px] text-[var(--color-muted)]">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Running the economic kernel…
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      <div className="sticky bottom-0 mt-8 bg-[var(--color-background)] pt-4">
        {disabled ? (
          <Panel className="mb-3 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="warning">
                {!signedIn ? "Not signed in" : "AI provider not configured"}
              </Badge>
              <span className="text-[13px] text-[var(--color-muted)]">
                {!signedIn
                  ? "Sign in to run the Agent Chat OS. Authentication requires DATABASE_URL."
                  : "Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable chat."}
              </span>
            </div>
          </Panel>
        ) : null}

        <Panel className="flex items-end gap-2 p-2">
          <Textarea
            rows={2}
            value={draft}
            disabled={disabled || busy}
            placeholder={
              disabled ? "Chat is unavailable until the platform is configured." : "Describe the work and its bounds…"
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            className="border-0 bg-transparent focus:border-0"
            aria-label="Message the Agent Chat OS"
          />
          <button
            type="button"
            disabled={disabled || busy || draft.trim().length === 0}
            onClick={() => void send(draft)}
            aria-label="Send"
            className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-cyan)] text-[#03070B] transition-opacity disabled:opacity-35"
          >
            <ArrowUp className="size-4" strokeWidth={2.4} aria-hidden />
          </button>
        </Panel>

        <p className="mt-2 px-1 text-[11px] leading-relaxed text-[var(--color-subtle)]">
          The model proposes; the mandate engine decides. No reply from this surface can authorize a
          payment{providerLabel ? ` · model provider: ${providerLabel}` : ""}.
        </p>
      </div>
    </div>
  );
}
