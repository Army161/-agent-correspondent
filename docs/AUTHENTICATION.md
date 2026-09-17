# Authentication

Identity is handled by [Better Auth](https://better-auth.com), configured in
`apps/web/src/lib/auth/server.ts`. It replaced a hand-rolled session layer for
one reason: the hand-rolled one worked, and "works" is a much lower bar than
"has been attacked by people who do this for a living."

Membership — which organization an identity belongs to — is *not* Better Auth's.
That lives in `apps/web/src/lib/auth/session.ts`, because it is an
authorization concept and this codebase keeps authorization in one place.

## Shape

```
apps/web/src/lib/auth/
  server.ts    Better Auth configuration.  "server-only".  Holds secrets.
  session.ts   Identity → organization.    "server-only".  Holds authorization.
  client.ts    The browser client.         "use client".   Holds neither.
  policy.ts    Credential rules shared by both sides.
  index.ts     The seam the rest of the app imports.
```

Nothing outside `lib/auth` imports `better-auth` directly. Swapping the identity
provider should not require touching a page.

## What is available, and when

Every method is enabled only when it can actually complete:

| Method | Requires | When unconfigured |
| --- | --- | --- |
| Email + password | `DATABASE_URL`, `AUTH_SECRET` | Sign-in page explains what is missing; the button is disabled |
| Google / GitHub / Apple | `<PROVIDER>_CLIENT_ID` and `_CLIENT_SECRET` | Listed on the page as unavailable — never rendered as a button that fails after the redirect |
| Passkeys | Nothing beyond the above | Always offered |
| TOTP | Nothing beyond the above | Always available to enrol |
| Email verification, password reset | `RESEND_API_KEY`, `EMAIL_FROM` | The page says mail cannot be delivered; the endpoint still answers generically |

`socialProviderAvailability()` is what the sign-in page reads. A provider button
that cannot complete is worse than an absent one.

## Credentials

Passwords are at least 12 characters, at most 256. No composition rules — they
push people toward predictable substitutions — and no maximum short enough to
break a password manager's generated secret. The rule lives in
`lib/auth/policy.ts` so the browser shows exactly what the server enforces.

Hashing is Better Auth's default (scrypt), and `users.password_hash` from the
previous scheme is retained, nullable and deprecated; nothing reads it.

## Sessions

- Opaque tokens, `httpOnly`, `SameSite=Lax`, `Secure` in production, prefixed
  `acor`.
- Fourteen days, refreshed at most once a day.
- **Freshness.** `requireFreshSession()` requires an authentication within the
  last ten minutes. Used where a stolen cookie must not be enough: replacing a
  payout wallet, raising a mandate limit, enabling live settlement, revealing an
  API secret, disabling a control.
- Sign-out revokes server-side. A cookie the browser forgets is a cookie an
  attacker may still hold.

## Account linking

`trustedProviders: []`. An OAuth identity is never linked to an existing account
by email alone. An attacker who controls an unverified address at some provider
could otherwise take over an account by signing in with it.

## Rate limiting

Counters live in Postgres (`auth_rate_limits`), not in process memory. A
per-process counter limits nothing behind more than one instance: the attempts
simply spread out.

Defaults, per 60-second window per client:

| Path | Max |
| --- | --- |
| everything | 100 |
| `/sign-in/email`, `/two-factor/verify-*` | 5 |
| `/sign-up/email` | 5 |
| `/request-password-reset`, `/reset-password`, `/send-verification-email` | 3 |

The thresholds are configuration (`AUTH_RATE_LIMIT_*`) because the right number
depends on where the deployment sits — behind a NAT or a shared egress IP,
everyone looks like one client. An unparseable or out-of-range value falls back
to the default: a typo must not silently remove a control. There is no value
that disables limiting.

## Two-factor

TOTP via the `twoFactor` plugin, with `verified`, `failed_verification_count`
and `locked_until` on `auth_two_factors`. A six-digit code has a million values
inside a thirty-second window; without a failure counter that is a tractable
online attack.

When a sign-in returns `twoFactorRedirect`, no session has been issued. The
second factor is enforced server-side; the form's second stage is presentation.

## Passkeys

`@better-auth/passkey`. `auth_passkeys` stores a COSE **public** key — public by
construction, so a database disclosure reveals nothing usable.

`AUTH_RP_ID` defaults to the site hostname. Changing it invalidates every
enrolled passkey, so it is set once and left alone.

## Where a person manages this

`/settings/security` — passkeys, two-factor, and every active session with its
IP, client and sign-in time.

The lists are read **server-side** and passed in, so they are correct on first
paint and a browser that never runs the client code still sees the truth. The
client re-reads only after it has changed something.

Sessions are identified to the page by **id, never token**. The token is a
bearer credential, and a page that renders it hands it to anything that can read
the DOM. The current session has no "End session" button, so nobody locks
themselves out by accident.

Enabling or disabling two-factor requires the account password. A stolen cookie
must not be enough to add a second factor the real owner does not control, nor
to remove the one they do.

Backup codes are shown exactly once, at generation, with that fact stated at the
moment they appear. They are stored hashed; there is no second chance.

## Redirects

`?next=` is attacker-controlled. `safeInternalPath()`
(`apps/web/src/lib/redirects.ts`) accepts only a same-origin absolute path, and
rejects scheme-relative (`//evil.example`), backslash and control-character
forms explicitly, because browsers normalise them into absolute URLs. Everything
else falls back to the default destination.

An open redirect in an auth flow turns a real sign-in page into credential
theft: the victim authenticates on the genuine site and lands on the attacker's.

## Email

`apps/web/src/lib/email/index.ts` has two rules.

1. **It never pretends.** With no provider configured, `sendEmail` returns a
   failure saying so. Callers still answer the user generically — a reset
   endpoint that distinguished "sent" from "no such account" would enumerate
   users — but the operator sees the truth in the logs.
2. **It never logs the link in production.** A verification URL is a bearer
   credential. In development it is printed, because there is nowhere else for
   it to go and the alternative is an unusable dev environment.

A delivery failure never fails the surrounding request. The account is worth
more than the notification.

## What this layer does not do

- It does not decide what an account may spend. That is the mandate engine.
- It does not grant plan entitlements. Those are read from `subscriptions`.
- It does not hold a signing key for customer funds.
