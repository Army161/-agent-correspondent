# Onboarding

`packages/core/src/onboarding/index.ts` — pure, tested, no I/O.
`apps/web/src/lib/onboarding.ts` — gathers the facts.
`apps/web/src/app/onboarding/` — the page and its actions.

## Why a state machine and not a step counter

A stored `step` integer and the world disagree constantly. Someone who creates
an agent through the API and then opens the browser is not on the "create your
first agent" step — but a counter would say they are, and they would have to
click past a task they already finished.

So progress is *derived*:

```ts
onboardingState(facts) -> { steps, current, completedRequired, complete, finished }
```

Same facts in, same state out. That makes it resumable on any device,
impossible to skip by editing a URL, and testable without a browser.

## The facts

| Fact | Where it comes from |
| --- | --- |
| `emailVerified` | `auth_users.email_verified` |
| `emailDeliveryConfigured` | whether a mail provider is set |
| `organizationNamed` | `organizations.name`, via `isOrganizationNamed()` |
| `purposeRecorded` | `onboarding_progress.purpose_recorded_at` |
| `planSelected` | `onboarding_progress.plan_selected_at` |
| `agentCount` | `agents`, scoped to the organization |
| `dismissedAt` | `onboarding_progress.dismissed_at` |

`onboarding_progress` is deliberately small: it holds only what cannot be
observed elsewhere. Duplicating the agent count into it would create a second,
staler truth.

`isOrganizationNamed` rejects the generated names — `"My organization"` and
anything matching `"<name>'s organization"` — by shape rather than by list.

## The steps

1. **Confirm your email** — required.
2. **Name your organization** — required.
3. **Tell us what you are building** — optional. Used for mandate defaults.
4. **Choose a plan** — required, including an explicit choice of the free tier,
   so nobody is billed for something they did not pick.
5. **Create your first agent** — required.

A step can carry a `blockedReason`: the verification step says so when the
deployment has no mail provider, rather than offering a button that cannot work.

## Economic readiness

`economicReadiness(facts, { requireVerifiedEmail })` reports whether the
prerequisites for an economic action are in place, and lists everything missing
so the UI can name it rather than hint.

`requireVerifiedEmail` is **deployment policy, not user preference**:
`requiresVerifiedEmail()` returns true in production. A production deployment
that cannot send mail therefore authorizes no economic actions. That is the
correct failure — an account nobody can verify is an account nobody can
attribute — and it is visible on `/onboarding` and in `/api/health` rather than
silent.

This function *reports*. It does not authorize. Every economic endpoint still
enforces the same conditions itself.

## Server actions

Each action in `app/onboarding/actions.ts` re-reads the session and takes the
organization from it. A form field naming an organization would be an
authorization decision made by the browser.

Recording a plan choice is not granting it. `onboarding_progress.selected_plan_id`
is what the user picked; entitlements are read from `subscriptions`, which is
written only by the signature-verified webhook handler.
