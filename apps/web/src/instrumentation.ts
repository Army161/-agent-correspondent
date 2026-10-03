/**
 * Next.js instrumentation hook.
 *
 * `onRequestError` is called for every error thrown while rendering a server
 * component, running a route handler, a server action or middleware. It is the
 * one place an unhandled error is guaranteed to pass through, so it is where
 * error reporting is wired -- see lib/observability/sentry.ts.
 */

export function register(): void {}

export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  // The reporter uses node:crypto; the edge runtime would never load it.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureException } = await import("./lib/observability/sentry");
  captureException(error, {
    route: context.routePath,
    routeType: context.routeType,
    method: request.method,
    // The path, never the query string: query strings carry tokens (password
    // reset links, OAuth callbacks) that must not end up in an error tracker.
    path: request.path.split("?")[0],
  });
}
