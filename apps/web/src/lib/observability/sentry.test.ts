import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEnvelope, captureException, captureMessage, errorReportingConfigured, parseDsn } from "./sentry";

describe("parseDsn", () => {
  it("parses a well-formed DSN", () => {
    const parsed = parseDsn("https://abc123@o0.ingest.sentry.io/4507000000000000");
    expect(parsed).toEqual({
      protocol: "https:",
      publicKey: "abc123",
      host: "o0.ingest.sentry.io",
      projectId: "4507000000000000",
    });
  });

  it("returns null for garbage input", () => {
    expect(parseDsn("not a url")).toBeNull();
  });

  it("returns null when the public key is missing", () => {
    expect(parseDsn("https://o0.ingest.sentry.io/123")).toBeNull();
  });

  it("keeps a self-hosted http DSN's scheme rather than forcing https", () => {
    expect(parseDsn("http://abc123@sentry.internal:9000/7")?.protocol).toBe("http:");
  });

  it("returns null for a non-http scheme", () => {
    expect(parseDsn("ftp://abc123@sentry.internal/7")).toBeNull();
  });

  it("returns null when the project id is missing", () => {
    expect(parseDsn("https://abc123@o0.ingest.sentry.io/")).toBeNull();
  });
});

describe("buildEnvelope", () => {
  const dsn = { protocol: "https:", publicKey: "abc123", host: "o0.ingest.sentry.io", projectId: "42" };

  it("targets the correct envelope endpoint and auth header", () => {
    const envelope = buildEnvelope(dsn, { event_id: "e1" });
    expect(envelope.url).toBe("https://o0.ingest.sentry.io/api/42/envelope/");
    expect(envelope.authHeader).toContain("sentry_key=abc123");
    expect(envelope.authHeader).toContain("sentry_version=7");
  });

  it("produces three newline-delimited JSON lines: envelope header, item header, event", () => {
    const envelope = buildEnvelope(dsn, { event_id: "e1", level: "error" });
    const lines = envelope.body.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event_id: "e1" });
    expect(JSON.parse(lines[1]!)).toEqual({ type: "event" });
    expect(JSON.parse(lines[2]!)).toMatchObject({ event_id: "e1", level: "error" });
  });
});

describe("captureException / captureMessage", () => {
  const originalFetch = globalThis.fetch;
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    vi.restoreAllMocks();
  });

  it("always logs structurally, even with no DSN configured", () => {
    delete process.env.SENTRY_DSN;
    captureException(new Error("boom"));
    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(logged.message).toBe("boom");
  });

  it("reports unconfigured with no DSN and does not attempt a network call", () => {
    delete process.env.SENTRY_DSN;
    expect(errorReportingConfigured()).toBe(false);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    captureException(new Error("boom"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards to Sentry's envelope endpoint when a DSN is configured", async () => {
    process.env.SENTRY_DSN = "https://abc123@o0.ingest.sentry.io/42";
    expect(errorReportingConfigured()).toBe(true);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    captureMessage("something happened", "warning", { organizationId: "org_1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://o0.ingest.sentry.io/api/42/envelope/");
    expect(String(init.body)).toContain("something happened");
    expect(String(init.body)).toContain("org_1");
  });

  it("swallows a delivery failure rather than throwing", async () => {
    process.env.SENTRY_DSN = "https://abc123@o0.ingest.sentry.io/42";
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(() => captureException(new Error("boom"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
