/**
 * A minimal, dependency-free Sentry error reporter.
 *
 * Not the `@sentry/nextjs` SDK: at the time this was written it had no
 * verified compatibility with this app's Next.js version, and pulling in an
 * unverified dependency to satisfy an "observability" checklist item is
 * exactly the kind of fabrication this codebase refuses elsewhere. Sentry's
 * ingestion endpoint is a small, stable, documented HTTP API (the envelope
 * format), so this talks to it directly with `fetch` — genuinely functional,
 * not a placeholder, and testable without a live Sentry project.
 *
 * Pure construction (`parseDsn`, `buildEnvelope`) is separated from the
 * network call (`sendEnvelope`) so the format can be tested exhaustively
 * without a network — same convention as `lib/billing/paddle-signature.ts`.
 */

import { randomUUID } from "node:crypto";

export interface ParsedDsn {
  /** "https:" for sentry.io; self-hosted Sentry on an internal network may be "http:". */
  readonly protocol: string;
  readonly publicKey: string;
  readonly host: string;
  readonly projectId: string;
}

/** `https://<publicKey>@<host>/<projectId>` -- Sentry's DSN format. */
export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\/+/, "");
    if (!publicKey || !url.host || !projectId) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return { protocol: url.protocol, publicKey, host: url.host, projectId };
  } catch {
    return null;
  }
}

export interface CaptureContext {
  readonly organizationId?: string;
  readonly route?: string;
  readonly [key: string]: unknown;
}

export interface SentryEnvelope {
  readonly url: string;
  readonly authHeader: string;
  readonly body: string;
}

/** A Sentry event id: 32 lowercase hex characters, no dashes. */
function eventId(): string {
  return randomUUID().replace(/-/g, "");
}

function errorToEvent(
  error: Error,
  level: "error" | "warning" | "info",
  context: CaptureContext | undefined,
  environment: string,
): Record<string, unknown> {
  const frames = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => ({ function: line.trim() }))
    .reverse();
  return {
    event_id: eventId(),
    timestamp: Date.now() / 1000,
    platform: "node",
    level,
    logger: "acor",
    environment,
    exception: {
      values: [
        {
          type: error.name || "Error",
          value: error.message,
          stacktrace: frames.length > 0 ? { frames } : undefined,
        },
      ],
    },
    extra: context,
  };
}

function messageToEvent(
  message: string,
  level: "error" | "warning" | "info",
  context: CaptureContext | undefined,
  environment: string,
): Record<string, unknown> {
  return {
    event_id: eventId(),
    timestamp: Date.now() / 1000,
    platform: "node",
    level,
    logger: "acor",
    environment,
    message: { formatted: message },
    extra: context,
  };
}

/** Build the envelope (URL, auth header, and NDJSON body) for one event. Pure. */
export function buildEnvelope(
  dsn: ParsedDsn,
  event: Record<string, unknown>,
): SentryEnvelope {
  const envelopeHeader = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
  });
  const itemHeader = JSON.stringify({ type: "event" });
  const body = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}\n`;

  return {
    url: `${dsn.protocol}//${dsn.host}/api/${dsn.projectId}/envelope/`,
    authHeader: `Sentry sentry_version=7, sentry_client=acor-observability/1.0, sentry_key=${dsn.publicKey}`,
    body,
  };
}

async function sendEnvelope(envelope: SentryEnvelope): Promise<void> {
  try {
    await fetch(envelope.url, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": envelope.authHeader },
      body: envelope.body,
      signal: AbortSignal.timeout(5000),
    });
  } catch (cause) {
    // An error reporter that can itself throw and crash the request it was
    // reporting from is worse than useless.
    console.error("[observability] could not deliver an event to Sentry:", cause);
  }
}

function dsnFromEnv(): ParsedDsn | null {
  const raw = process.env.SENTRY_DSN?.trim();
  if (!raw) return null;
  return parseDsn(raw);
}

function environment(): string {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/**
 * Report an exception. Always logs structurally to stderr; additionally
 * forwards to Sentry when `SENTRY_DSN` is configured. Never throws.
 */
export function captureException(error: unknown, context?: CaptureContext): void {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(
    JSON.stringify({
      level: "error",
      message: err.message,
      name: err.name,
      stack: err.stack,
      ...context,
      loggedAt: new Date().toISOString(),
    }),
  );

  const dsn = dsnFromEnv();
  if (!dsn) return;
  void sendEnvelope(buildEnvelope(dsn, errorToEvent(err, "error", context, environment())));
}

export function captureMessage(
  message: string,
  level: "error" | "warning" | "info" = "info",
  context?: CaptureContext,
): void {
  console.log(JSON.stringify({ level, message, ...context, loggedAt: new Date().toISOString() }));

  const dsn = dsnFromEnv();
  if (!dsn) return;
  void sendEnvelope(buildEnvelope(dsn, messageToEvent(message, level, context, environment())));
}

export function errorReportingConfigured(): boolean {
  return dsnFromEnv() !== null;
}
