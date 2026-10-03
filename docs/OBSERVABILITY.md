# Observability

## What is in place

**Structured logs, always.** Every captured error and message is written to
stdout/stderr as a single JSON line (`level`, `message`, `name`, `stack`, and
context such as `organizationId`, `operation`, `route`). Any log drain that
reads container output — Vercel, Fly, a Docker log driver, CloudWatch — can
index it without configuration.

**Error reporting to Sentry, when `SENTRY_DSN` is set.** The same events are
forwarded to Sentry's envelope ingestion endpoint. Without a DSN, nothing is
sent anywhere and `/api/health` reports `errorReporting: configured: false`,
the same way it reports every other optional integration.

**Unhandled errors are captured centrally.** `apps/web/src/instrumentation.ts`
implements Next.js's `onRequestError` hook, which Next calls for every error
thrown while rendering a server component or running a route handler, server
action or middleware. Money-path failures that are caught and turned into an
error response (job creation and transitions, webhook delivery bookkeeping)
are reported explicitly via `captureException` with the job, organization and
transition attached.

## Why not `@sentry/nextjs`

At the time of writing the official SDK had no verified compatibility with
this app's Next.js version (16.x). Adding an unverified dependency that wraps
the Next config, instruments the bundler and patches the runtime — to satisfy
an observability checklist item — risks breaking the build for a feature
nobody could test. Sentry's ingestion API is small, stable and documented, so
`apps/web/src/lib/observability/sentry.ts` talks to it directly with `fetch`.

What this gives up, honestly: no performance tracing, no session replay, no
breadcrumbs, no client-side (browser) error capture, and stack traces arrive
as raw strings rather than symbolicated frames with source context. Moving to
the SDK later is a contained change — `captureException`/`captureMessage` are
the only call sites.

## Privacy

Errors are reported with the request **path only, never the query string**:
password-reset links and OAuth callbacks carry tokens in the query, and an
error tracker is not a place for credentials. `apps/web/src/instrumentation.test.ts`
asserts this. Context objects passed to `captureException` carry ids
(`organizationId`, `jobId`), never secrets, signatures, or request bodies.

## Verified

- Unit tests: DSN parsing (including self-hosted `http:` DSNs), envelope
  format, no network call without a DSN, delivery failures swallowed rather
  than thrown, and query-string stripping in `onRequestError`.
- End to end against a local Sentry-compatible receiver: an error passed
  through `onRequestError` arrived at `/api/<project>/envelope/` with a valid
  `X-Sentry-Auth` header, the exception type and message intact, and a
  `?token=…` query string absent from the payload.
- Not verified: delivery to a real sentry.io project (no DSN is available to
  this deployment). The envelope format follows Sentry's published
  specification; the first real deployment should confirm an event appears.

A side finding while trying to provoke an unhandled error: with the database
pointed at a dead port, every route tried — public credential endpoints,
sign-in, the app pages, health — degraded to an honest 503/NOT CONNECTED
response rather than throwing.

## Configuration

| Variable | Effect |
| --- | --- |
| `SENTRY_DSN` | Enables forwarding. `https://<key>@<host>/<project>`; a self-hosted `http://` DSN keeps its scheme. |
| `NODE_ENV` | Sets the event's `environment` (`production` or `development`). |
