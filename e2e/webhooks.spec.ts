/**
 * Outbound webhooks.
 *
 * Unit tests cover the crypto (encryption round-trip, HMAC signing) in
 * isolation. What only exists in the running system is the wiring: that
 * settling a job actually fires an HTTP delivery, that the delivery is
 * signed with the secret that subscription was given (and only that
 * subscription can verify it), and that revoking a subscription stops
 * deliveries rather than merely hiding them.
 */

import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";

const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const PASSWORD = "correct-horse-battery-staple";

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/health");
  const body = (await response.json()) as { database: { status: string } };
  return body.database.status === "CONNECTED";
}

async function api(
  page: Page,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(
    async ([method, path, body]) => {
      const response = await fetch(path as string, {
        method: method as string,
        ...(body === null
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text };
      }
      return { status: response.status, json };
    },
    [method, path, body ?? null] as const,
  );
}

async function signUp(page: Page): Promise<void> {
  const email = `webhook-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Webhook Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
}

async function createBuyerAndProvider(page: Page): Promise<{ buyerId: string; providerId: string }> {
  const buyer = await api(page, "POST", "/api/v1/agents", {
    name: "Buyer",
    provider: "anthropic",
    model: "claude-sonnet-5",
    mandate: {
      dailySpendLimitUsd: "10.00",
      maxTransactionUsd: "5.00",
      minimumReserveUsd: "0.00",
      unverifiedCounterpartyLimitUsd: "5.00",
      humanApprovalAboveUsd: "10.00",
      creditAllowed: true,
      tokenTradingAllowed: false,
      allowedAssets: ["USDC"],
      allowedNetworks: ["MULEDGER"],
    },
  });
  const provider = await api(page, "POST", "/api/v1/agents", {
    name: "Provider",
    provider: "anthropic",
    model: "claude-sonnet-5",
  });
  const buyerId = buyer.json.agentId as string;
  const providerId = provider.json.agentId as string;

  const challenge = await api(page, "POST", `/api/v1/agents/${buyerId}/wallets/challenge`, {
    network: "ARC",
    address: OWNER.address,
  });
  const signature = await OWNER.signMessage({ message: challenge.json.message as string });
  await api(page, "POST", `/api/v1/agents/${buyerId}/wallets`, {
    network: "ARC",
    address: OWNER.address,
    custody: "external",
    isPrimary: true,
    nonce: challenge.json.nonce,
    signature,
  });

  return { buyerId, providerId };
}

async function fundingIntent(
  page: Page,
  buyerId: string,
  providerId: string,
  amountUsd: string,
): Promise<string> {
  const compiled = await api(page, "POST", "/api/v1/intents", {
    buyerAgentId: buyerId,
    providerAgentId: providerId,
    service: "research.summarize",
    maxSpend: amountUsd,
    minReceive: amountUsd,
    settlementAsset: "USDC",
    network: "MULEDGER",
    allowedRails: ["MULEDGER"],
    destination: providerId,
    ttlSeconds: 600,
  });
  const typedData = compiled.json.typedData as {
    domain: unknown;
    types: { EconomicIntent: unknown };
    message: unknown;
  };
  const signature = await OWNER.signTypedData({
    domain: typedData.domain as never,
    types: { EconomicIntent: typedData.types.EconomicIntent as never },
    primaryType: "EconomicIntent",
    message: typedData.message as never,
  });
  const submitted = await api(page, "POST", "/api/v1/intents/submit", {
    intent: compiled.json.intent,
    signature,
    signer: OWNER.address,
  });
  return submitted.json.intentId as string;
}

interface Received {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: string;
}

/** A minimal local HTTP receiver, reachable from the app server on the loopback interface. */
async function startReceiver(): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("subscribing requires at least one known event", async ({ page }) => {
    await signUp(page);
    const refused = await api(page, "POST", "/api/v1/webhooks", {
      url: "https://example.com/hook",
      events: ["not.a.real.event"],
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("INVALID_INPUT");
  });

  test("a settled job delivers a signed webhook, and the secret is never shown again", async ({
    page,
  }) => {
    const receiver = await startReceiver();
    try {
      await signUp(page);
      const subscribed = await api(page, "POST", "/api/v1/webhooks", {
        url: receiver.url,
        events: ["job.funded", "job.settled"],
      });
      expect(subscribed.status).toBe(201);
      const secret = subscribed.json.secret as string;
      expect(secret).toMatch(/^[0-9a-f]{64}$/);

      // Listing it back never re-shows the secret.
      const listed = await api(page, "GET", "/api/v1/webhooks");
      const rows = listed.json.webhooks as Record<string, unknown>[];
      expect(rows.some((row) => row.id === subscribed.json.webhookId)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(secret);

      const { buyerId, providerId } = await createBuyerAndProvider(page);
      const job = await api(page, "POST", "/api/v1/jobs", {
        buyerAgentId: buyerId,
        providerAgentId: providerId,
        title: "Webhook test",
        service: "research.summarize",
        priceUsd: "0.40",
      });
      const jobId = job.json.jobId as string;
      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "QUOTE" });
      const intentId = await fundingIntent(page, buyerId, providerId, "0.40");
      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "FUND", intentId });

      await waitUntil(() => receiver.received.length >= 1);
      const fundedDelivery = receiver.received[0]!;
      const fundedPayload = JSON.parse(fundedDelivery.rawBody) as {
        event: string;
        data: { jobId: string };
      };
      expect(fundedPayload.event).toBe("job.funded");
      expect(fundedPayload.data.jobId).toBe(jobId);
      const expectedSig = createHmac("sha256", secret)
        .update(fundedDelivery.rawBody, "utf8")
        .digest("hex");
      expect(fundedDelivery.headers["x-acor-signature"]).toBe(expectedSig);
      expect(fundedDelivery.headers["x-acor-event"]).toBe("job.funded");

      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "START" });
      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
        transition: "SUBMIT",
        resultHash: `0x${"ef".repeat(32)}`,
        deliverableUri: "https://example.com/result",
      });
      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "EVALUATE" });
      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "PASS" });
      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "SETTLE" });

      await waitUntil(() => receiver.received.length >= 2);
      const settledDelivery = receiver.received[1]!;
      const settledPayload = JSON.parse(settledDelivery.rawBody) as {
        event: string;
        data: { jobId: string; to: string };
      };
      expect(settledPayload.event).toBe("job.settled");
      expect(settledPayload.data.jobId).toBe(jobId);
      expect(settledPayload.data.to).toBe("SETTLED");

      // ATTACK: a signature computed with the wrong secret does not match
      // what was actually sent -- this is what a receiver's own verification
      // must reject.
      const forgedSig = createHmac("sha256", "wrong-secret").update(settledDelivery.rawBody).digest("hex");
      expect(settledDelivery.headers["x-acor-signature"]).not.toBe(forgedSig);
    } finally {
      await receiver.close();
    }
  });

  test("a revoked subscription receives no further deliveries", async ({ page }) => {
    const receiver = await startReceiver();
    try {
      await signUp(page);
      const subscribed = await api(page, "POST", "/api/v1/webhooks", {
        url: receiver.url,
        events: ["job.funded"],
      });
      const webhookId = subscribed.json.webhookId as string;

      const revoked = await api(page, "DELETE", `/api/v1/webhooks/${webhookId}`);
      expect(revoked.status).toBe(200);
      expect(revoked.json.active).toBe(false);

      const { buyerId, providerId } = await createBuyerAndProvider(page);
      const job = await api(page, "POST", "/api/v1/jobs", {
        buyerAgentId: buyerId,
        providerAgentId: providerId,
        title: "Should not deliver",
        service: "research.summarize",
        priceUsd: "0.10",
      });
      const jobId = job.json.jobId as string;
      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "QUOTE" });
      const intentId = await fundingIntent(page, buyerId, providerId, "0.10");
      await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "FUND", intentId });

      // Give a real delivery every chance to arrive, then confirm it didn't.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(receiver.received).toHaveLength(0);
    } finally {
      await receiver.close();
    }
  });

  test("ATTACK: revoking another organization's webhook is refused", async ({ page }) => {
    await signUp(page);
    const subscribed = await api(page, "POST", "/api/v1/webhooks", {
      url: "https://example.com/hook",
      events: ["job.funded"],
    });
    const webhookId = subscribed.json.webhookId as string;

    await page.evaluate(async () => {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    });
    await signUp(page);

    const attempt = await api(page, "DELETE", `/api/v1/webhooks/${webhookId}`);
    expect(attempt.status).toBe(404);
  });
});
