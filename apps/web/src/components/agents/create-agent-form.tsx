"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button, Input, Label, Select, Textarea } from "@/components/ui/primitives";

type Provider = "anthropic" | "openai" | "local";

const MODELS: Record<Provider, readonly string[]> = {
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
  openai: ["gpt-5", "gpt-5-mini"],
  local: ["local"],
};

function responseMessage(body: unknown): string {
  if (typeof body === "object" && body !== null && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "The agent could not be created. Please try again.";
}

/**
 * The first-agent flow deliberately accepts only identity and model choices.
 * The server creates the agent and its conservative DEFAULT_MANDATE in one
 * transaction, so there is never a spend-capable agent without a policy.
 */
export function CreateAgentForm(): React.JSX.Element {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [model, setModel] = useState<string>(MODELS.anthropic[0]!);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function chooseProvider(next: Provider): void {
    setProvider(next);
    setModel(MODELS[next][0]!);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();

    try {
      const response = await fetch("/api/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || undefined,
          provider,
          model,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || typeof body !== "object" || body === null || !("agentId" in body)) {
        setError(responseMessage(body));
        return;
      }

      const agentId = (body as { agentId: unknown }).agentId;
      if (typeof agentId !== "string" || !agentId) {
        setError("The server did not return an agent identifier.");
        return;
      }
      router.replace(`/agents/${agentId}`);
      router.refresh();
    } catch {
      setError("The request could not be completed. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5">
      {error ? (
        <p className="rounded-lg border border-[rgba(255,92,112,0.35)] bg-[rgba(255,92,112,0.07)] px-3 py-2.5 text-[13px] text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}

      <div>
        <Label htmlFor="name">Agent name</Label>
        <Input id="name" name="name" required maxLength={120} autoComplete="off" placeholder="Research Desk" disabled={pending} />
      </div>

      <div>
        <Label htmlFor="description">What will this agent do? <span className="text-[var(--color-subtle)]">Optional</span></Label>
        <Textarea id="description" name="description" maxLength={1000} rows={3} placeholder="Summarizes documents for my team." disabled={pending} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="provider">Model provider</Label>
          <Select
            id="provider"
            name="provider"
            value={provider}
            onChange={(event) => chooseProvider(event.target.value as Provider)}
            disabled={pending}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="local">Local</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="model">Model</Label>
          <Select id="model" name="model" value={model} onChange={(event) => setModel(event.target.value)} disabled={pending}>
            {MODELS[provider].map((option) => <option key={option} value={option}>{option}</option>)}
          </Select>
        </div>
      </div>

      <p className="rounded-lg border border-[rgba(0,229,255,0.2)] bg-[rgba(0,229,255,0.04)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
        A conservative mandate is created with this agent in the same transaction. It denies credit and token trading, and requires approval above the default limit. Model execution remains unavailable until its provider is configured.
      </p>

      <div className="flex flex-wrap justify-end gap-3">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating agent…" : "Create agent"}</Button>
      </div>
    </form>
  );
}
