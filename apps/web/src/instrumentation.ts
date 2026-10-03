/**
 * Next.js instrumentation hook.
 *
 * `onRequestError` is called for every error the server captures while
 * rendering a Server Component, running a Route Handler, a Server Action, or
 * the proxy. It is the one place an unhandled error is guaranteed to pass
 * through, so it is where error reporting is wired -- see
 * lib/observability/sentry.ts and docs/OBSERVABILITY.md.
 */

import type { Instrumentation } from "next";

export function register(): void {}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  // The reporter uses node:crypto; the edge runtime would never load it.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureException } = await import("./lib/observability/sentry");

  // Errors raised during Server Component rendering may be replaced by React
  // before they reach here; the digest is what ties this report to the line
  // Next itself logged.
  const digest =
    typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined;

  // Awaited: Next documents that async work here must be, or delivery can be
  // cut off when the request ends.
  await captureException(error, {
    route: context.routePath,
    routeType: context.routeType,
    method: request.method,
    // The path, never the query string: query strings carry tokens (password
    // reset links, OAuth callbacks) that must not end up in an error tracker.
    path: request.path.split("?")[0],
    ...(digest ? { digest } : {}),
  });
};
