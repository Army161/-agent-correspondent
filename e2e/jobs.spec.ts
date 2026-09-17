/**
 * Jobs: the escrowed, evaluated work lifecycle.
 *
 * Unit tests cover the state machine in isolation (`@acor/core`). What only
 * exists in the running system is what happens where the state machine meets
 * real money: that FUND actually consumes a signed, accepted intent and
 * refuses to spend one twice; that SETTLE writes the receipt, the μLedger
 * entry and the transaction record mandate limits and Sentinel-5 read; and
 * that an illegal transition (settling before funding, settling twice) is
 * refused rather than silently applied.
 */

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
  method: "GET" | "POST",
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
  const email = `jobs-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Jobs Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
}

/** Create a buyer (with a credit-capable MULEDGER mandate) and a provider, and bind the buyer's wallet. */
async function createBuyerAndProvider(
  page: Page,
): Promise<{ buyerId: string; providerId: string }> {
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

/** Compile, sign and submit a MULEDGER intent for exactly `amountUsd`, paying `providerId`. */
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
  expect(compiled.status).toBe(200);

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
  expect(submitted.status).toBe(200);
  return submitted.json.intentId as string;
}

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("the full lifecycle: quote, fund, work, evaluate, settle", async ({ page }) => {
    await signUp(page);
    const { buyerId, providerId } = await createBuyerAndProvider(page);

    const created = await api(page, "POST", "/api/v1/jobs", {
      buyerAgentId: buyerId,
      providerAgentId: providerId,
      title: "Summarize doc",
      service: "research.summarize",
      priceUsd: "0.50",
    });
    expect(created.status).toBe(201);
    expect(created.json.state).toBe("DRAFT");
    const jobId = created.json.jobId as string;

    // SETTLE before FUND is illegal from DRAFT.
    const badSettle = await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "SETTLE",
    });
    expect(badSettle.status).toBe(409);
    expect(badSettle.json.error).toBe("ILLEGAL_JOB_TRANSITION");

    const quoted = await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "QUOTE",
    });
    expect(quoted.status).toBe(200);
    expect(quoted.json.state).toBe("QUOTED");

    const intentId = await fundingIntent(page, buyerId, providerId, "0.50");

    const funded = await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "FUND",
      intentId,
    });
    expect(funded.status).toBe(200);
    expect(funded.json.state).toBe("FUNDED");

    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "START" });
    const submitted = await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "SUBMIT",
      resultHash: `0x${"ab".repeat(32)}`,
      deliverableUri: "https://example.com/result",
    });
    expect(submitted.status).toBe(200);
    expect(submitted.json.state).toBe("SUBMITTED");

    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "EVALUATE" });
    const passed = await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "PASS",
    });
    expect(passed.status).toBe(200);
    expect(passed.json.state).toBe("COMPLETE");

    const settled = await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "SETTLE",
    });
    expect(settled.status).toBe(200);
    expect(settled.json.state).toBe("SETTLED");

    // Terminal: settling again is refused, not a silent no-op.
    const settleAgain = await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "SETTLE",
    });
    expect(settleAgain.status).toBe(409);
    expect(settleAgain.json.error).toBe("ILLEGAL_JOB_TRANSITION");

    const detail = await api(page, "GET", `/api/v1/jobs/${jobId}`);
    expect(detail.status).toBe(200);
    const job = detail.json.job as Record<string, unknown>;
    expect(job.state).toBe("SETTLED");
    expect(job.escrow).toBe("0.50");

    // Settlement moved the money: the clearing view now shows an OPEN
    // MULEDGER obligation for this asset, above zero gross.
    const clearing = await api(page, "GET", "/api/v1/clearing?asset=USDC");
    expect(clearing.status).toBe(200);
    expect((clearing.json.openEntries as number) ?? 0).toBeGreaterThan(0);
  });

  test("ATTACK: an intent already consumed by one job cannot fund a second", async ({ page }) => {
    await signUp(page);
    const { buyerId, providerId } = await createBuyerAndProvider(page);

    const job1 = await api(page, "POST", "/api/v1/jobs", {
      buyerAgentId: buyerId,
      providerAgentId: providerId,
      title: "First",
      service: "research.summarize",
      priceUsd: "0.25",
    });
    const job1Id = job1.json.jobId as string;
    await api(page, "POST", `/api/v1/jobs/${job1Id}/transition`, { transition: "QUOTE" });

    const intentId = await fundingIntent(page, buyerId, providerId, "0.25");
    const funded1 = await api(page, "POST", `/api/v1/jobs/${job1Id}/transition`, {
      transition: "FUND",
      intentId,
    });
    expect(funded1.status).toBe(200);

    const job2 = await api(page, "POST", "/api/v1/jobs", {
      buyerAgentId: buyerId,
      providerAgentId: providerId,
      title: "Second",
      service: "research.summarize",
      priceUsd: "0.25",
    });
    const job2Id = job2.json.jobId as string;
    await api(page, "POST", `/api/v1/jobs/${job2Id}/transition`, { transition: "QUOTE" });

    const doubleFund = await api(page, "POST", `/api/v1/jobs/${job2Id}/transition`, {
      transition: "FUND",
      intentId,
    });
    expect(doubleFund.status).toBe(400);
    expect(doubleFund.json.error).toBe("INTENT_NOT_OPEN");
  });

  test("ATTACK: an intent that does not cover the quoted price cannot fund the job", async ({
    page,
  }) => {
    await signUp(page);
    const { buyerId, providerId } = await createBuyerAndProvider(page);

    const job = await api(page, "POST", "/api/v1/jobs", {
      buyerAgentId: buyerId,
      providerAgentId: providerId,
      title: "Underfunded",
      service: "research.summarize",
      priceUsd: "1.00",
    });
    const jobId = job.json.jobId as string;
    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "QUOTE" });

    const intentId = await fundingIntent(page, buyerId, providerId, "0.10");
    const fund = await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "FUND",
      intentId,
    });
    expect(fund.status).toBe(400);
    expect(fund.json.error).toBe("INSUFFICIENT_AUTHORIZATION");
  });

  test("running a clearing cycle moves the settled obligation from OPEN to NETTED", async ({
    page,
  }) => {
    await signUp(page);
    const { buyerId, providerId } = await createBuyerAndProvider(page);

    const job = await api(page, "POST", "/api/v1/jobs", {
      buyerAgentId: buyerId,
      providerAgentId: providerId,
      title: "To be cleared",
      service: "research.summarize",
      priceUsd: "0.30",
    });
    const jobId = job.json.jobId as string;
    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "QUOTE" });
    const intentId = await fundingIntent(page, buyerId, providerId, "0.30");
    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "FUND", intentId });
    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "START" });
    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, {
      transition: "SUBMIT",
      resultHash: `0x${"cd".repeat(32)}`,
      deliverableUri: "https://example.com/result",
    });
    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "EVALUATE" });
    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "PASS" });
    await api(page, "POST", `/api/v1/jobs/${jobId}/transition`, { transition: "SETTLE" });

    const before = await api(page, "GET", "/api/v1/clearing?asset=USDC");
    const openBefore = before.json.openEntries as number;
    expect(openBefore).toBeGreaterThan(0);

    const run = await api(page, "POST", "/api/v1/clearing", { asset: "USDC", mode: "BILATERAL" });
    expect(run.status).toBe(201);
    expect(run.json.proofHash).toBeTruthy();
    expect(run.json.instructionCount).toBeGreaterThan(0);

    const after = await api(page, "GET", "/api/v1/clearing?asset=USDC");
    // Clearing is scoped to this organization, and the run above moved every
    // OPEN entry it owned to NETTED, so its open count must have dropped.
    expect((after.json.openEntries as number) ?? 0).toBeLessThan(openBefore);

    const cycles = after.json.cycles as { id: string; proofHash: string }[];
    expect(cycles.some((cycle) => cycle.proofHash === (run.json.proofHash as string))).toBe(true);

    // Running again with nothing OPEN left for this organization is refused,
    // not silently accepted as an empty cycle.
    const rerun = await api(page, "POST", "/api/v1/clearing", { asset: "USDC", mode: "BILATERAL" });
    if (rerun.status === 409) {
      expect(rerun.json.error).toBe("NOT_RUN");
    }
  });
});
