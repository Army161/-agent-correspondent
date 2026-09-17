import { describe, expect, it, vi } from "vitest";

import { AgentCorrespondentApiError, AgentCorrespondentClient } from "../src/index";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("AgentCorrespondentClient", () => {
  it("sends the api key as a bearer token and parses a successful response", async () => {
    const fetchImpl = fakeFetch(201, { agentId: "agent_1" });
    const client = new AgentCorrespondentClient({
      baseUrl: "https://example.com",
      apiKey: "sk_test_123",
      fetch: fetchImpl,
    });

    const result = await client.createAgent({ name: "Buyer", model: "claude-sonnet-5" });
    expect(result).toEqual({ agentId: "agent_1" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/api/v1/agents",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer sk_test_123" }) as unknown,
      }),
    );
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchImpl = fakeFetch(200, { jobs: [] });
    const client = new AgentCorrespondentClient({ baseUrl: "https://example.com/", fetch: fetchImpl });
    await client.listJobs();
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/api/v1/jobs", expect.anything());
  });

  it("throws AgentCorrespondentApiError with the parsed body on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(409, { error: "ILLEGAL_JOB_TRANSITION", message: "cannot SETTLE a DRAFT job" });
    const client = new AgentCorrespondentClient({ baseUrl: "https://example.com", fetch: fetchImpl });

    await expect(
      client.transitionJob("job_1", { transition: "SETTLE" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "ILLEGAL_JOB_TRANSITION",
      message: "cannot SETTLE a DRAFT job",
    });
  });

  it("AgentCorrespondentApiError falls back to a generic message when the body has none", () => {
    const error = new AgentCorrespondentApiError(500, {});
    expect(error.message).toBe("Agent Correspondent API returned 500");
    expect(error.code).toBeUndefined();
  });

  it("does not send an authorization header without an api key", async () => {
    const fetchImpl = fakeFetch(200, { valid: true, reasons: [] });
    const client = new AgentCorrespondentClient({ baseUrl: "https://example.com", fetch: fetchImpl });
    await client.verifyCredential({ document: {}, signature: "sig" });

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });
});
