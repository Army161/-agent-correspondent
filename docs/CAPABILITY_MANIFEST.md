# The capability manifest

A machine-readable statement of what this deployment can actually do, generated
from the runtime. The public site renders it, so **the site cannot claim more
than the product supports**.

That is the entire point. Marketing copy drifts from reality the moment either
changes, and it always drifts in the flattering direction. A status derived from
a live probe does not.

## The five statuses

| Status | Means | Requires |
| --- | --- | --- |
| `LIVE` | verified live on a production network | a live probe that confirmed it |
| `TESTNET` | verified on a test network | a live probe, on a testnet |
| `INTEGRATING` | built, not yet verified end to end | credentials present, nothing confirmed |
| `EXPLORING` | adapter boundary only | nothing configured |
| `UNAVAILABLE` | probed and found absent | a live probe that found nothing |

**Configuration alone never reaches `LIVE`.** Putting a contract address in an
environment variable is not evidence that a contract exists there; a capability
marked `AVAILABLE` from config is reported as `INTEGRATING`.

There is one honest exception. A capability whose source is `internal` — the
μLedger, which is this repository's own code — can be `LIVE` without a network
probe, because it is verified by the test suite rather than by a network call.

`EXPERIMENTAL` is never `LIVE`. Multilateral netting is implemented and tested
and still reports `INTEGRATING`, because it has not been exercised against a
real rail.

## Evidence

Every feature carries the evidence behind its status:

```json
{
  "id": "xrpl.payments",
  "status": "EXPLORING",
  "capability": "XRPL.PAYMENTS",
  "evidence": "unknown (default) — verified by probing the configured XRPL node"
}
```

A status nobody can account for is a claim, so evidence is never empty, and an
e2e test asserts that anything marked `LIVE` has evidence saying it was probed.

## Where it is used

- `GET /api/v1/manifest` — public and unauthenticated, so anyone assessing the
  product can read the same statuses the site renders, from the same source.
- The landing page's integration section and roadmap render it directly. Neither
  contains a hand-written status.
- `e2e/manifest.spec.ts` asserts the page and the manifest cannot diverge.

## What it is not

The manifest describes integration work in this repository. It contains no
vocabulary for claiming a partnership, an endorsement, an affiliation or a
sponsorship, and a unit test asserts none of those words appears in any feature.

Every rendering carries:

> These are integration statuses for work in this repository. They are not
> claims of partnership, endorsement, affiliation or sponsorship by any project
> named, and no such relationship is implied.

## Adding a feature

A feature must name a real `CapabilityId` that the kernel gates on. That is
deliberate: a feature cannot appear on the site without something in the product
to verify it against.
