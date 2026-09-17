# Webhooks

Outbound HTTP notifications for economic events, so an integrator does not
have to poll `GET /api/v1/jobs/:id` to find out a job settled.

## Subscribing

```
POST /api/v1/webhooks
{ "url": "https://example.com/hook", "events": ["job.funded", "job.settled"] }

201
{ "webhookId": "hook_...", "secret": "7e1a9c3f..." }
```

`secret` is a 32-byte, hex-encoded HMAC key. **It is returned exactly once, at
creation, and never again** — `GET /api/v1/webhooks` lists a subscription's
id, url, events and active state, never its secret. If it is lost, revoke the
subscription and create a new one; this is the same posture as an API key.

```
GET  /api/v1/webhooks          # list this organization's subscriptions
DELETE /api/v1/webhooks/:id    # revoke — stops deliveries, keeps history
```

## Events

| Event | Fires when |
| --- | --- |
| `job.funded` | a job's `FUND` transition succeeds |
| `job.settled` | a job's `SETTLE` transition succeeds (`data.to` is always `SETTLED`; check the job's evaluation result via `GET /api/v1/jobs/:id` for pass/fail) |

This is every event the platform fires today. Adding one is a one-line
addition to `WEBHOOK_EVENTS` in `apps/web/src/lib/webhooks/index.ts` plus a
`dispatchWebhookEvent` call at the point the event actually happens — Sentinel
incidents and intent submission are natural next additions, not yet wired.

## Delivery

```
POST <your url>
content-type: application/json
x-acor-event: job.settled
x-acor-signature: <hex HMAC-SHA256 of the exact request body, using your secret>

{"event":"job.settled","deliveredAt":"2026-...","data":{"jobId":"job_...","from":"COMPLETE","to":"SETTLED"}}
```

Verify it by recomputing the HMAC over the **raw bytes received** — not a
re-serialization of the parsed JSON, which is not guaranteed to produce the
same bytes — and comparing in constant time:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, rawBody: string, signatureHeader: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHeader, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

The TypeScript SDK (`packages/sdk`) ships this as `verifyWebhookSignature`.

## What this is not

**There is no delivery queue and no retry worker.** This application has no
background job runner. A delivery is attempted exactly once, inline, with a
5-second timeout, at the moment the transaction that produced the event
commits. If your endpoint is down, slow, or returns a non-2xx status at that
exact moment, the delivery is lost — recorded as a failed attempt in
`webhook_delivery_attempts` for you to notice, but not retried. An integrator
that needs delivery guarantees should poll the corresponding read endpoint
(`GET /api/v1/jobs/:id`) as the source of truth and treat webhooks as a
latency optimization, not a substitute for it.

Delivery is also **not part of the database transaction that produced the
event.** A webhook firing can never roll back a settlement, and a settlement
that rolled back never fires a webhook — but there is a real window, between
the commit and the delivery attempt, in which a process crash would lose the
notification silently. This is the same trade-off most webhook systems make
without saying so; this one says so.

## Secret storage

A webhook secret has to be used later, to sign each delivery — unlike an API
key (verified by comparing a presented value's hash to a stored hash), a
webhook secret cannot be stored as a one-way hash, because a hash cannot be
turned back into the value HMAC needs. It is encrypted at rest with
AES-256-GCM under `WEBHOOK_ENCRYPTION_KEY` (a 32-byte hex string; see
`apps/web/src/lib/webhooks/crypto.ts`). Without that variable configured,
`POST /api/v1/webhooks` refuses with `503 CAPABILITY_UNAVAILABLE` rather than
storing a secret in the clear.
