import { afterEach, describe, expect, it, vi } from "vitest";

import { onRequestError } from "./instrumentation";

const context = {
  routerKind: "App Router",
  routePath: "/api/v1/jobs",
  routeType: "route",
  renderSource: "server-rendering",
  revalidateReason: undefined,
  renderType: "dynamic",
} as unknown as Parameters<typeof onRequestError>[2];
const request = (path: string) => ({ path, method: "GET", headers: {} });

describe("onRequestError", () => {
  const originalFetch = globalThis.fetch;
  const originalRuntime = process.env.NEXT_RUNTIME;
  const originalDsn = process.env.SENTRY_DSN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    vi.restoreAllMocks();
  });

  it("ATTACK: never forwards the query string, which can carry reset and OAuth tokens", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.SENTRY_DSN = "https://abc123@o0.ingest.sentry.io/42";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await onRequestError(
      new Error("boom"),
      request("/reset-password?token=SECRET123"),
      context,
    );
    // No extra tick: the hook awaits delivery itself, as Next requires.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("/reset-password");
    expect(String(init.body)).not.toContain("SECRET123");
    const logged = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(logged.join("\n")).not.toContain("SECRET123");
  });

  it("includes React's digest so the report matches Next's own log line", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.SENTRY_DSN = "https://abc123@o0.ingest.sentry.io/42";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await onRequestError(Object.assign(new Error("rendered"), { digest: "1234567" }), request("/jobs"), context);

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain('"digest":"1234567"');
  });

  it("does nothing outside the node runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await onRequestError(new Error("boom"), request("/x"), context);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
