/**
 * The chat endpoint.
 *
 * The model runs with the deterministic tool surface from `lib/ai/tools.ts`,
 * which is read-only and compile-only. Its replies, and every tool result it
 * used, are returned together so the UI can render the action cards that show
 * what the kernel actually decided — the user sees the engine's output, not
 * just the model's description of it.
 */

import { generateText, stepCountIs } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { buildTools } from "@/lib/ai/tools";
import { resolveModel, SYSTEM_PROMPT } from "@/lib/ai/provider";
import { currentUser } from "@/lib/auth";
import { recordAudit } from "@/lib/platform";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(20_000),
      }),
    )
    .min(1)
    .max(60),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export interface ChatActionCard {
  readonly tool: string;
  readonly input: unknown;
  readonly output: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      {
        error: "UNAUTHENTICATED",
        message:
          "Sign in to use the Agent Chat OS. If this deployment has no database configured, authentication is unavailable until DATABASE_URL is set.",
      },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST", message: "Body must be JSON." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const resolved = resolveModel(parsed.data.provider, parsed.data.model);
  if (!resolved.ok) {
    return NextResponse.json({ error: "PROVIDER_NOT_CONFIGURED", message: resolved.reason }, { status: 503 });
  }

  try {
    const result = await generateText({
      model: resolved.value.model,
      system: SYSTEM_PROMPT,
      messages: parsed.data.messages,
      tools: buildTools({ organizationId: user.organizationId, userId: user.id }),
      // Bounded: a runaway loop of tool calls is a cost incident, not a feature.
      stopWhen: stepCountIs(6),
    });

    const cards: ChatActionCard[] = [];
    for (const step of result.steps) {
      for (const call of step.toolCalls) {
        const output = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
        cards.push({
          tool: call.toolName,
          input: call.input,
          output: output && "output" in output ? output.output : null,
        });
      }
    }

    await recordAudit({
      organizationId: user.organizationId,
      actor: `user:${user.id}`,
      action: "chat.turn",
      outcome: "ALLOW",
      detail: {
        provider: resolved.value.providerId,
        model: resolved.value.modelId,
        tools: cards.map((card) => card.tool),
      },
    });

    return NextResponse.json({
      text: result.text,
      cards,
      provider: resolved.value.providerId,
      model: resolved.value.modelId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The model provider request failed.";
    return NextResponse.json({ error: "PROVIDER_ERROR", message }, { status: 502 });
  }
}
