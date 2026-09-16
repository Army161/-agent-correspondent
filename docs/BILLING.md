# Billing

Paddle, as Merchant of Record. Card details never reach this service, and this
service never becomes the seller of record for tax purposes.

## The rule

**Reaching a checkout success page proves that a browser reached a success
page.** Nothing else. A plan is granted when, and only when, a notification
arrives whose HMAC signature verifies against this deployment's webhook secret.

Everything below follows from that.

## Shape

```
apps/web/src/lib/plans.ts                     Plans, limits, price-id mapping
apps/web/src/lib/billing/paddle-signature.ts  Signature verification (pure)
apps/web/src/lib/billing/webhook-events.ts    Event interpretation (pure)
apps/web/src/lib/billing/paddle.ts            The Paddle API, server-only
apps/web/src/lib/billing/entitlements.ts      What an organization may do
apps/web/src/lib/billing/limits.ts            Enforcement
apps/web/src/app/api/billing/checkout/route.ts
apps/web/src/app/api/billing/webhook/route.ts
```

The two pure modules are separate on purpose: "is this really from Paddle" and
"what does this event mean" are the whole security boundary, and they should be
readable and testable without a database or a network.

## Price identifiers

Never hard-coded. A Paddle identifier generated in one account is meaningless in
another, and baking one into source guarantees a sandbox id reaches production
eventually. `PADDLE_PRICE_<PLAN>_<PERIOD>` is the only mapping.

A price id in an event that maps to no configured plan is **not guessed at**.
The event is recorded with a rejection reason and left unapplied, so a mis-keyed
environment variable produces a visible unapplied event rather than a silently
wrong entitlement.

## Checkout

The transaction is created **server-side** (`POST /api/billing/checkout`) so
that `custom_data.organizationId` is ours. If the browser supplied it, an
attacker could have their own payment credit an organization they do not own,
or buy a subscription for someone else and then dispute the charge.

The response is a transaction id. It grants nothing.

## Webhook

`POST /api/billing/webhook`, public, and written assuming the caller is hostile:

1. **Raw body.** Re-serialising parsed JSON changes bytes and breaks the
   signature, so the handler reads text and parses afterwards.
2. **Constant-time HMAC.** Paddle signs `${timestamp}:${rawBody}`. A
   byte-by-byte comparison leaks the expected digest one character at a time.
   Several `h1` values are accepted so an endpoint secret can be rotated.
3. **Age.** Older than five minutes — in either direction — is refused, so a
   captured delivery cannot be replayed later.
4. **Record, then decide.** The row goes in first; the unique index on
   `(provider, provider_event_id)` makes a duplicate delivery a no-op rather
   than a second application. `billing_events` is append-only by trigger:
   payload, type and timestamps cannot be rewritten, the row cannot be deleted,
   and an applied event cannot be re-applied.
5. **Apply, or say why not.** An unmapped price, a missing `custom_data`, or an
   organization this deployment does not have each produce an unapplied event
   with a stored reason.

Status codes matter here. A verification failure is 401 with no explanation —
telling a forger *why* their attempt failed is free tuning feedback. A database
problem is 503, so Paddle retries; dropping an event means a customer who paid
and got nothing. An event that was understood but not applicable is 200,
because retrying would not change the outcome.

## Entitlements

`entitlementsFor(organizationId)` reads the `subscriptions` row, which only the
verified webhook handler writes. It consults no header, no body field, and no
client storage.

Fail-closed. Each of these resolves to the default plan, which grants nothing
paid:

- no subscription row
- an unreadable database
- a `plan_id` that no longer exists in configuration
- a status outside `ACTIVE`, `TRIALING`, `PAST_DUE`
- a `current_period_end` already in the past

`PAST_DUE` keeps access through the provider's dunning window. Cutting a
customer off on the first failed charge loses more than it protects, and the
provider sends `canceled` when it gives up.

A `current_period_end` in the past overrides an `ACTIVE` status: the cancellation
webhook should have arrived, but if it did not, time still passed.

## Limits

Enforced server-side at the point of action. `POST /api/v1/agents` calls
`canCreateAgent()` and returns **402** with the plan, the limit and the current
count when the plan is full. A limit the browser enforces is a suggestion.

An unreadable agent count denies rather than allows: an unknown count is not a
low count.

## What is not implemented

Proration, seat-based billing, usage metering and invoice history are not built.
The `/billing` page shows the plan, its limits, and the period end.

## Verification

`apps/web/src/lib/billing/billing.test.ts` covers the signature scheme —
forgery, tampering, replay, clock skew, secret rotation, and the specific
mistake of signing the body without the timestamp — and the event decisions.

The end-to-end path was exercised against live Postgres with locally-signed
payloads: unsigned, wrongly-signed, tampered and stale deliveries all refused;
an unmapped price and an unknown organization recorded unapplied; a valid event
applied once and its duplicate ignored; the resulting entitlement visible on
`/billing`; and the append-only trigger refusing an UPDATE, a DELETE and a
re-apply.

Live Paddle calls — creating a transaction, opening the overlay, reading the
customer portal — have **not** been exercised, because no Paddle account is
configured in this environment. Those paths report themselves unconfigured
rather than failing obscurely.
