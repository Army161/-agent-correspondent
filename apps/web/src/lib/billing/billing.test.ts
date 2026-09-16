import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_SIGNATURE_AGE_SECONDS,
  signPaddlePayload,
  verifyPaddleSignature,
} from "./paddle-signature";
import { decideEvent, parseEnvelope } from "./webhook-events";

const SECRET = "pdl_ntfset_01_a_test_secret_value";
const NOW = new Date("2026-09-16T12:00:00.000Z");
const BODY = JSON.stringify({ event_id: "evt_1", event_type: "subscription.activated" });

describe("paddle signature", () => {
  it("accepts a correctly signed body", () => {
    const header = signPaddlePayload(BODY, SECRET, NOW);
    const result = verifyPaddleSignature(BODY, header, SECRET, NOW);
    expect(result.ok).toBe(true);
  });

  it("refuses when no secret is configured", () => {
    const header = signPaddlePayload(BODY, SECRET, NOW);
    const result = verifyPaddleSignature(BODY, header, undefined, NOW);
    expect(result).toEqual({ ok: false, reason: "MISSING_SECRET" });
    expect(verifyPaddleSignature(BODY, header, "   ", NOW)).toEqual({
      ok: false,
      reason: "MISSING_SECRET",
    });
  });

  it("refuses a missing or malformed header", () => {
    expect(verifyPaddleSignature(BODY, null, SECRET, NOW)).toEqual({
      ok: false,
      reason: "MISSING_HEADER",
    });
    expect(verifyPaddleSignature(BODY, "nonsense", SECRET, NOW)).toEqual({
      ok: false,
      reason: "MALFORMED_HEADER",
    });
    // A timestamp with no digest is not a signature.
    expect(verifyPaddleSignature(BODY, "ts=1789600000", SECRET, NOW)).toEqual({
      ok: false,
      reason: "MALFORMED_HEADER",
    });
  });

  it("refuses a body that was changed after signing", () => {
    const header = signPaddlePayload(BODY, SECRET, NOW);
    const tampered = BODY.replace("subscription.activated", "subscription.canceled");
    expect(verifyPaddleSignature(tampered, header, SECRET, NOW)).toEqual({
      ok: false,
      reason: "MISMATCH",
    });
  });

  it("refuses a signature made with a different secret", () => {
    const header = signPaddlePayload(BODY, "some-other-secret", NOW);
    expect(verifyPaddleSignature(BODY, header, SECRET, NOW)).toEqual({
      ok: false,
      reason: "MISMATCH",
    });
  });

  it("refuses a captured delivery replayed later", () => {
    const header = signPaddlePayload(BODY, SECRET, NOW);
    const later = new Date(NOW.getTime() + (MAX_SIGNATURE_AGE_SECONDS + 1) * 1000);
    expect(verifyPaddleSignature(BODY, header, SECRET, later)).toEqual({
      ok: false,
      reason: "STALE",
    });
  });

  it("refuses a timestamp far in the future as readily as a stale one", () => {
    const ahead = new Date(NOW.getTime() + (MAX_SIGNATURE_AGE_SECONDS + 60) * 1000);
    const header = signPaddlePayload(BODY, SECRET, ahead);
    expect(verifyPaddleSignature(BODY, header, SECRET, NOW)).toEqual({
      ok: false,
      reason: "STALE",
    });
  });

  it("refuses a non-numeric timestamp without hashing anything", () => {
    expect(verifyPaddleSignature(BODY, "ts=yesterday;h1=abcd", SECRET, NOW)).toEqual({
      ok: false,
      reason: "BAD_TIMESTAMP",
    });
  });

  it("signs the timestamp together with the body, not the body alone", () => {
    // Signing the body alone would let any captured timestamp be reused.
    const ts = Math.floor(NOW.getTime() / 1000).toString();
    const bodyOnly = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyPaddleSignature(BODY, `ts=${ts};h1=${bodyOnly}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "MISMATCH",
    });
  });

  it("accepts either digest while an endpoint secret is being rotated", () => {
    const valid = signPaddlePayload(BODY, SECRET, NOW);
    const digest = valid.split("h1=")[1] as string;
    const ts = valid.split(";")[0] as string;
    const header = `${ts};h1=${"0".repeat(64)};h1=${digest}`;
    expect(verifyPaddleSignature(BODY, header, SECRET, NOW).ok).toBe(true);
  });
});

const ENV = { ...process.env };

describe("paddle events", () => {
  beforeEach(() => {
    process.env.PADDLE_PRICE_BUILDER_MONTHLY = "pri_builder_monthly";
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  function envelope(overrides: Record<string, unknown> = {}): unknown {
    return {
      event_id: "evt_01",
      event_type: "subscription.activated",
      occurred_at: "2026-09-16T12:00:00.000Z",
      data: {
        id: "sub_01",
        status: "active",
        customer_id: "ctm_01",
        custom_data: { organizationId: "org_01" },
        items: [{ price: { id: "pri_builder_monthly" } }],
        current_billing_period: { ends_at: "2026-10-16T12:00:00.000Z" },
        ...overrides,
      },
    };
  }

  it("applies a recognised subscription event", () => {
    const parsed = parseEnvelope(envelope());
    expect(parsed).not.toBeNull();
    const decision = decideEvent(parsed!, () => true);
    expect(decision).toMatchObject({
      kind: "APPLY",
      organizationId: "org_01",
      subscriptionId: "sub_01",
      planId: "builder",
      status: "ACTIVE",
      priceId: "pri_builder_monthly",
    });
  });

  it("refuses an event that names no organization", () => {
    const parsed = parseEnvelope(envelope({ custom_data: null }));
    const decision = decideEvent(parsed!, () => true);
    expect(decision.kind).toBe("REJECT");
  });

  it("refuses an organization this deployment does not have", () => {
    const parsed = parseEnvelope(envelope({ custom_data: { organizationId: "org_someone_else" } }));
    const decision = decideEvent(parsed!, (id) => id === "org_01");
    expect(decision.kind).toBe("REJECT");
  });

  it("refuses a price that maps to no configured plan", () => {
    const parsed = parseEnvelope(envelope({ items: [{ price: { id: "pri_not_configured" } }] }));
    const decision = decideEvent(parsed!, () => true);
    expect(decision).toMatchObject({ kind: "REJECT" });
    // The point: an unmapped price does not silently become some other plan.
    expect((decision as { reason: string }).reason).toMatch(/not mapped to a plan/);
  });

  it("does not guess an entitlement from an unrecognised provider status", () => {
    const parsed = parseEnvelope(envelope({ status: "something_new" }));
    const decision = decideEvent(parsed!, () => true);
    expect(decision).toMatchObject({ kind: "APPLY", status: "NONE" });
  });

  it("treats a cancellation as cancelled whatever the status field says", () => {
    const parsed = parseEnvelope({
      ...(envelope() as Record<string, unknown>),
      event_type: "subscription.canceled",
    });
    const decision = decideEvent(parsed!, () => true);
    expect(decision).toMatchObject({ kind: "APPLY", status: "CANCELED" });
  });

  it("ignores events it has no action for", () => {
    const parsed = parseEnvelope({
      ...(envelope() as Record<string, unknown>),
      event_type: "transaction.completed",
    });
    expect(decideEvent(parsed!, () => true).kind).toBe("IGNORE");
  });

  it("rejects a body that is not shaped like an event", () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope({ event_id: "evt_1" })).toBeNull();
    expect(parseEnvelope({ event_type: "x", data: {} })).toBeNull();
  });
});
