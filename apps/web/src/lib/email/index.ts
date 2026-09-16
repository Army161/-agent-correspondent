/**
 * Transactional email.
 *
 * Verification links and password resets are security messages, so this module
 * has two rules:
 *
 *  1. It never pretends. If no provider is configured, `send` returns a failure
 *     and says why. Callers still respond to the user generically — a reset
 *     endpoint that distinguished "sent" from "no such account" would enumerate
 *     users — but the operator sees the truth in the logs and in /api/health.
 *  2. It never logs the link in production. A verification URL is a bearer
 *     credential; printing it to a shared log is handing it out.
 */

import "server-only";

import { SITE_URL } from "../env";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** A short machine-readable label for logs and metrics. Never the body. */
  readonly kind: "verify-email" | "reset-password" | "sign-in-otp" | "security-alert";
}

export type EmailResult =
  | { readonly ok: true; readonly provider: string; readonly id: string | null }
  | { readonly ok: false; readonly provider: string; readonly error: string };

export interface EmailProviderState {
  readonly id: string;
  readonly configured: boolean;
  readonly requires: readonly string[];
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

/** The address transactional mail is sent from. */
export function emailSender(): string | null {
  return env("EMAIL_FROM");
}

export function emailProviderState(): EmailProviderState {
  return {
    id: "resend",
    configured: env("RESEND_API_KEY") !== null && emailSender() !== null,
    requires: ["RESEND_API_KEY", "EMAIL_FROM"],
  };
}

export function emailConfigured(): boolean {
  return emailProviderState().configured;
}

/**
 * Send one message.
 *
 * Failures are returned, not thrown: a mail outage must not turn a successful
 * sign-up into a 500 and lose the account that was just created.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const apiKey = env("RESEND_API_KEY");
  const from = emailSender();

  if (!apiKey || !from) {
    const missing = [!apiKey ? "RESEND_API_KEY" : null, !from ? "EMAIL_FROM" : null]
      .filter((name): name is string => name !== null)
      .join(", ");
    if (process.env.NODE_ENV !== "production") {
      // Development only, and deliberately so: in production this would put a
      // bearer credential into the log stream.
      console.warn(`[email:${message.kind}] not sent (${missing} unset). Body:\n${message.text}`);
    }
    return { ok: false, provider: "resend", error: `email is not configured (${missing})` };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        provider: "resend",
        error: `provider returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      };
    }

    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return { ok: true, provider: "resend", id: typeof body.id === "string" ? body.id : null };
  } catch (cause) {
    return {
      ok: false,
      provider: "resend",
      error: cause instanceof Error ? cause.message : "email delivery failed",
    };
  }
}

const PRODUCT = "Agent Correspondent";

export function verificationEmail(to: string, url: string): EmailMessage {
  return {
    to,
    kind: "verify-email",
    subject: `Verify your ${PRODUCT} email`,
    text: [
      `Confirm this address to finish setting up your ${PRODUCT} account.`,
      "",
      url,
      "",
      "The link expires in one hour and can be used once.",
      "If you did not create an account, ignore this message — nothing happens until the link is used.",
      "",
      SITE_URL,
    ].join("\n"),
  };
}

export function passwordResetEmail(to: string, url: string): EmailMessage {
  return {
    to,
    kind: "reset-password",
    subject: `Reset your ${PRODUCT} password`,
    text: [
      `Someone asked to reset the password for this address at ${PRODUCT}.`,
      "",
      url,
      "",
      "The link expires in one hour and can be used once.",
      "If this was not you, ignore this message. Your password has not changed,",
      "and no one can sign in without this link.",
      "",
      SITE_URL,
    ].join("\n"),
  };
}
